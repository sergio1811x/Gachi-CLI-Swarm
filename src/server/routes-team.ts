import type { WorkerRole } from '../shared/types.js'
import { resolveCommandPresetLaunchConfig } from './agent-launch-resolver.js'
import { BREAKER_STAGE_KEY_PREFIX, BREAKER_UNTIL_KEY_PREFIX } from './error-budget-breaker.js'
import { GhError } from './github-pr.js'
import { BadRequestError } from './http-errors.js'
import { DISPATCH_PAUSED_KEY_PREFIX, isDispatchPausedForWorkspace } from './permission-mode.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CancelTaskBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
} from './route-types.js'
import { buildTaskDispatchPrompt } from './routes-tasks.js'
import type { TaskRecord } from './task-store.js'
import { taskStore } from './task-store.js'
import { syncTasksMarkdownFile } from './tasks-file.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { resolveWorkerBranchName } from './worktree-manager.js'

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const teamRoutes: RouteDefinition[] = [
  // --- Workforce management (orchestrator-only) — feedback: the model was
  // grepping source for REST routes to scale workers; give it first-class
  // commands instead. ---
  route('POST', '/api/team/worker/add', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
      role?: string
      preset?: string
      autostart?: boolean
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')

    const role = (body.role ?? 'coder') as WorkerRole
    // Resolve the preset BEFORE creating the worker: an unknown preset id must
    // fail with a typed 400 instead of leaving a half-configured worker whose
    // start can only die with "Agent launch config not found".
    let presetLaunchConfig: ReturnType<typeof resolveCommandPresetLaunchConfig>
    if (body.preset) {
      presetLaunchConfig = resolveCommandPresetLaunchConfig(store.settings, body.preset)
      if (!presetLaunchConfig) {
        const known = store.settings
          .listCommandPresets()
          .map((preset) => preset.id)
          .join(', ')
        throw new BadRequestError(
          `Unknown command preset / engine: ${body.preset}. Known presets: ${known}.`
        )
      }
    }
    const worker = store.addWorker(projectId, {
      name,
      role,
      description: `Added by orchestrator via team worker add`,
    })
    if (presetLaunchConfig) {
      await store.configureAgentLaunch(projectId, worker.id, presetLaunchConfig)
    }
    let started: { ok: boolean; error: string | null; run_id: string | null } = {
      ok: false,
      error: null,
      run_id: null,
    }
    if (body.autostart !== false) {
      // B7: fail with an actionable hint instead of the opaque
      // "Agent launch config not found" when no preset was configured.
      if (!body.preset && !store.peekAgentLaunchConfig(projectId, worker.id)) {
        started = {
          ok: false,
          error:
            'No launch preset configured for this worker. Use `team worker add <name> [role] --preset <preset-id>` to create a ready-to-run worker, or set an engine with `team engine <name> <codex|agy|claude|opencode>`, then `team worker start <name>`.',
          run_id: null,
        }
      } else {
        try {
          await store.startAgent(projectId, worker.id, {
            gachiPort: String(request.socket.localPort ?? ''),
          })
          started = { ok: true, error: null, run_id: null }
        } catch (error) {
          started = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            run_id: null,
          }
        }
      }
    }
    sendJson(response, 201, {
      ok: true,
      worker_id: worker.id,
      name: worker.name,
      role: worker.role,
      preset: body.preset ?? null,
      started,
    })
  }),
  route('POST', '/api/team/worker/start', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    // A worker without a launch config can never spawn — fail with the
    // actionable hint instead of the opaque "Agent launch config not found" 500.
    if (!store.peekAgentLaunchConfig(projectId, worker.id)) {
      throw new BadRequestError(
        `No launch configuration for ${name}. Set an engine first: \`team engine ${name} <codex|agy|claude|opencode>\`, then retry \`team worker start ${name}\`.`
      )
    }
    await store.startAgent(projectId, worker.id, {
      gachiPort: String(request.socket.localPort ?? ''),
    })
    sendJson(response, 200, { ok: true, worker_id: worker.id })
  }),
  route('POST', '/api/team/worker/stop', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
      cancel_task?: boolean
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    // B1: stopping a worker must also release its in-flight dispatch, otherwise
    // the bound task hangs in running/ready forever (the "ghost" bug). Release
    // returns it to READY with the sticky worker binding kept, so the recovery
    // watchdog can re-dispatch it to this worker on restart — or it can be
    // re-picked manually via the board.
    // `cancel_task` opts out of that resurrection: the card is canceled
    // instead of requeued, so a follow-up `team send` cannot lose the race
    // against the dispatcher re-assigning the stale bound card to a silently
    // hung worker.
    const boundTaskId = taskStore.getAssignedTaskForWorker(projectId, worker.id)?.id
    let canceledTaskId: string | null = null
    if (boundTaskId) {
      if (body.cancel_task === true) {
        store.cancelTaskById(projectId, boundTaskId, {
          fromAgentId,
          reason: 'Canceled via team worker stop --cancel-task',
        })
        canceledTaskId = boundTaskId
      } else {
        taskStore.releaseTask(projectId, boundTaskId, 'Worker stopped via team worker stop')
      }
    }
    const run = store.getActiveRunByAgentId(projectId, worker.id)
    if (run) await store.stopAgentRun(run.runId)
    sendJson(response, 200, {
      ok: true,
      stopped: Boolean(run),
      canceledTask: canceledTaskId,
      releasedTask: canceledTaskId ? null : (boundTaskId ?? null),
    })
  }),
  ...(['pause', 'resume'] as const).flatMap((action) => [
    route('POST', `/api/team/worker/${action}`, async ({ request, response, store }) => {
      const body = await readJsonBody<{
        project_id?: string
        from_agent_id?: string
        token?: string
        name?: string
      }>(request)
      const projectId = requireNonEmptyString(body.project_id, 'project_id')
      const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
      const name = requireNonEmptyString(body.name, 'name')
      const agent = authenticateCliAgent({
        fromAgentId,
        getAgent: store.getAgent,
        token: body.token,
        validateToken: store.validateAgentToken,
        workspaceId: projectId,
      })
      requireCommandForRole(agent, 'workers')
      const worker = store.listWorkers(projectId).find((w) => w.name === name)
      if (!worker) {
        sendJson(response, 404, { error: `Worker not found: ${name}` })
        return
      }
      const run = store.getActiveRunByAgentId(projectId, worker.id)
      if (!run) {
        sendJson(response, 409, { error: `No active run for worker: ${name}` })
        return
      }
      if (action === 'pause') store.pauseTerminalRun(run.runId)
      else store.resumeTerminalRun(run.runId)
      const after = store.getActiveRunByAgentId(projectId, worker.id)
      sendJson(response, 200, {
        ok: true,
        name,
        run_id: run.runId,
        paused: Boolean(after?.paused),
      })
    }),
  ]),
  route('POST', '/api/team/worker/compact', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    // Reuses the agent-control surface: resolves the engine from the persisted
    // launch config and writes its /compact (or /compress) into the live PTY.
    // Unsupported engines throw a typed ConflictError (409) from the control
    // layer instead of a guessed slash command.
    const result = await store.agentContextAction(projectId, worker.id, 'compact')
    const boundTaskId = taskStore.getAssignedTaskForWorker(projectId, worker.id)?.id
    if (boundTaskId) {
      taskStore.addLog(
        projectId,
        boundTaskId,
        '[COMPACT] Контекст воркера сжат по запросу оркестратора'
      )
    }
    sendJson(response, 200, { ok: true, name, action: result.action, task_id: boundTaskId ?? null })
  }),
  route('POST', '/api/team/worker/restart-all-crashed', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const gachiPort = String(request.socket.localPort ?? '')
    const results: Array<{ name: string; started: boolean; error?: string }> = []
    for (const worker of store.listWorkers(projectId)) {
      // Only workers that actually died (summary settled to stopped) with a
      // persisted launch config are relaunched; live workers are untouched.
      const summary = store.getAgent(projectId, worker.id)
      if (!summary || summary.status !== 'stopped') continue
      if (!store.peekAgentLaunchConfig(projectId, worker.id)) continue
      try {
        await store.startAgent(projectId, worker.id, { gachiPort })
        results.push({ name: worker.name, started: true })
      } catch (error) {
        results.push({
          error: error instanceof Error ? error.message : String(error),
          name: worker.name,
          started: false,
        })
      }
    }
    sendJson(response, 200, {
      ok: true,
      restarted: results.filter((item) => item.started).length,
      results,
    })
  }),
  route('POST', '/api/team/worker/note', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
      text?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const text = requireNonEmptyString(body.text, 'text')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    const run = store.getActiveRunByAgentId(projectId, worker.id)
    if (!run) {
      sendJson(response, 409, { error: `No active run for worker: ${name}` })
      return
    }
    // Raw system-note injection into the worker PTY — explicitly NOT a task:
    // no card is created or poked, the dispatcher never sees it.
    store.writeRunInput(run.runId, `[Gachi system message: note from @${agent.name}]\n${text}\n`)
    sendJson(response, 200, { ok: true, name, run_id: run.runId })
  }),
  route('POST', '/api/team/worker/describe', async ({ request, response, store }) => {
    // Orchestrator-only rewrite of a worker's persistent description — the
    // specialization note that is injected into every dispatch prompt. Fixes a
    // stale description ("still points at gptimage") without deleting and
    // re-adding the worker; takes effect on the NEXT dispatch, no restart.
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
      description?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const description = requireNonEmptyString(body.description, 'description')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    const updated = store.updateWorker(projectId, worker.id, { description })
    sendJson(response, 200, {
      description: updated.description,
      name: updated.name,
      ok: true,
      worker_id: updated.id,
    })
  }),
  route('POST', '/api/team/worker/rm', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      name?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const name = requireNonEmptyString(body.name, 'name')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const worker = store.listWorkers(projectId).find((w) => w.name === name)
    if (!worker) {
      sendJson(response, 404, { error: `Worker not found: ${name}` })
      return
    }
    const boundTaskId = taskStore.getAssignedTaskForWorker(projectId, worker.id)?.id
    if (boundTaskId) {
      // Release before deleting the worker so the task is not orphaned bound to
      // a removed agent — it falls back to a free READY card.
      taskStore.releaseTask(projectId, boundTaskId, 'Worker removed via team worker rm')
    }
    const run = store.getActiveRunByAgentId(projectId, worker.id)
    if (run) await store.stopAgentRun(run.runId)
    store.deleteWorker(projectId, worker.id)
    sendJson(response, 200, { ok: true, removed: worker.id, releasedTask: boundTaskId ?? null })
  }),
  // Error-budget breaker resume from the CLI (orchestrator-only). Mirrors the
  // UI's PUT /dispatch-pause resume path: fully closes the breaker (cooldown
  // deadline + escalation stage + softened streak) instead of only clearing
  // the flag, so a half-burned budget does not re-trip instantly.
  route('POST', '/api/team/dispatch-resume', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      reason?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')
    const wasPaused =
      store.settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${projectId}`)?.value === '1'
    store.settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${projectId}`, '0')
    store.settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${projectId}`, '0')
    store.settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${projectId}`, '0')
    store.softenErrorBudget(projectId)
    console.log(`[TEAM] dispatch resumed by @${agent.name}${body.reason ? `: ${body.reason}` : ''}`)
    sendJson(response, 200, { dispatch_paused: false, ok: true, was_paused: wasPaused })
  }),
  route('GET', '/api/team/events', ({ request, response, store }) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const projectId = requireNonEmptyString(url.searchParams.get('project_id'), 'project_id')
    const fromAgentId = url.searchParams.get('agent_id') ?? undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: url.searchParams.get('token') ?? undefined,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'events')
    if (fromAgentId === undefined) {
      // authenticateCliAgent already rejected a missing identity; keep the
      // type narrowed so the caller's id is guaranteed for the lookup below.
      throw new BadRequestError('Missing agent_id')
    }

    const limitRaw = url.searchParams.get('limit')
    const sinceRaw = url.searchParams.get('since')
    const limit = limitRaw && Number.isInteger(Number(limitRaw)) ? Number(limitRaw) : undefined
    const since = sinceRaw && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined

    sendJson(response, 200, {
      events: store.agentEvents(projectId, fromAgentId, {
        ...(limit !== undefined ? { limit } : {}),
        ...(since !== undefined ? { since } : {}),
      }),
      ok: true,
    })
  }),
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'send')
    const dispatch = await store.dispatchTaskByWorkerName(projectId, to, text, {
      fromAgentId,
      gachiPort: String(request.socket.localPort ?? ''),
    })

    // The direct PTY delivery above works even while the Kanban dispatcher is
    // paused (error budget) — without this flag the sender cannot tell why the
    // card it just created will sit in the backlog forever (orchestrator
    // feedback: "статус висит на ready бесконечно").
    const dispatchPaused = isDispatchPausedForWorkspace(store.settings, projectId)
    sendJson(response, 202, {
      dispatch_id: dispatch.id,
      dispatch_paused: dispatchPaused,
      ok: true,
      ...(dispatchPaused
        ? {
            warning:
              'Workspace dispatch is paused (error budget) — the Kanban backlog will not drain until a human resumes it',
          }
        : {}),
    })
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const reason = requireNonEmptyString(body.reason, 'reason')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'cancel')
    // Cancel by dispatch id or by task id — whichever the caller can see.
    if (typeof body.task_id === 'string' && !body.dispatch_id) {
      const taskId = requireNonEmptyString(body.task_id, 'task_id')
      const result = store.cancelTaskById(projectId, taskId, { fromAgentId, reason })
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
        task_id: result.taskId,
      })
      return
    }
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const result = store.cancelTask(projectId, dispatchId, { fromAgentId, reason })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
  }),
  route('POST', '/api/team/task-delete', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const taskId = requireNonEmptyString(body.task_id, 'task_id')
    const reason = requireNonEmptyString(body.reason ?? 'deleted via team task-delete', 'reason')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'cancel')
    const deleted = store.deleteTaskCard(projectId, taskId, { fromAgentId, reason })
    if (!deleted) {
      sendJson(response, 404, { error: `No task: ${taskId}` })
      return
    }
    sendJson(response, 200, { ok: true, task_id: taskId })
  }),
  route('POST', '/api/team/tasks/cleanup', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      stale_hours?: number
      dry_run?: boolean
      delete?: boolean
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'workers')

    const staleHours = Number(body.stale_hours)
    if (!Number.isFinite(staleHours) || staleHours <= 0) {
      throw new BadRequestError('stale_hours must be a positive number')
    }
    const dryRun = body.dry_run !== false
    const applyDelete = body.delete === true

    const cutoff = Date.now() - staleHours * 3_600_000
    const stale = taskStore.listTasks(projectId).filter((task) => {
      if (task.status !== 'ready' && task.status !== 'assigned') return false
      if (!task.assignedAgentId) return false
      if (task.updatedAt > cutoff) return false
      const run = store.getActiveRunByAgentId(projectId, task.assignedAgentId)
      const assigneeLive =
        run !== undefined && (run.status === 'starting' || run.status === 'running')
      return !assigneeLive
    })

    if (!dryRun) {
      for (const task of stale) {
        if (applyDelete) {
          store.deleteTaskCard(projectId, task.id, {
            fromAgentId,
            reason: `tasks-cleanup: карточка неактивна дольше ${staleHours} ч`,
          })
        } else {
          taskStore.updateTask(projectId, task.id, { assignedAgentId: null })
          taskStore.addLog(
            projectId,
            task.id,
            `[CLEANUP] Привязка снята: карточка была неактивна дольше ${staleHours} ч`
          )
        }
      }
    }

    sendJson(response, 200, {
      ok: true,
      stale_hours: staleHours,
      dry_run: dryRun,
      delete: applyDelete,
      matched: stale.length,
      tasks: stale.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assigned_agent_id: task.assignedAgentId ?? null,
        updated_at: task.updatedAt,
      })),
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'report')
    const reportInput = {
      artifacts: getArtifacts(body.artifacts),
      ...(typeof body.dispatch_id === 'string' ? { dispatchId: body.dispatch_id } : {}),
      // B5: no `requireActiveRun` here on purpose. A dead/unstarted
      // orchestrator PTY used to reject the whole report (409) and leave the
      // card hanging in running/assigned with nobody to hand it to. Now the
      // report always settles the card into review, and the orchestrator
      // notification is queued in the inbox and flushed on every heartbeat
      // tick (the heartbeat loop also self-heals a crashed orchestrator).
      text: resultText,
    }
    if (typeof body.status === 'string') {
      const result = store.reportTask(projectId, fromAgentId, {
        ...reportInput,
        status: body.status,
      })
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    } else {
      const result = store.reportTask(projectId, fromAgentId, reportInput)
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    }
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'status')
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: getArtifacts(body.artifacts),
      requireActiveRun: true,
      text: resultText,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
    return
  }),
  route('POST', '/api/team/request', async ({ request, response, store }) => {
    // Agent permission request (Telegram approval flow): the worker asks
    // before running a potentially dangerous command; a human approves or
    // denies it from Telegram or the web UI.
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      command?: string
      reason?: string
      dispatch_id?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const command = requireNonEmptyString(body.command, 'command')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'request')

    // Rate limit (audit L-1): a misbehaving agent must not spam approval
    // requests into paired chats. Bounded by durable data: max pending per
    // agent plus a minimum interval between consecutive requests.
    const MAX_PENDING_PER_AGENT = 5
    const REQUEST_COOLDOWN_MS = 60_000
    const approvals = store.listApprovals(projectId)
    const pendingByAgent = approvals.pending.filter((item) => item.agentId === fromAgentId)
    if (pendingByAgent.length >= MAX_PENDING_PER_AGENT) {
      sendJson(response, 429, {
        error: `Too many pending permission requests (${pendingByAgent.length}). A human must decide first.`,
        error_code: 'rate_limited',
        retry_after_ms: REQUEST_COOLDOWN_MS,
      })
      return
    }
    const lastRequestAt = approvals.recent.find((item) => item.agentId === fromAgentId)?.createdAt
    if (lastRequestAt !== undefined) {
      const elapsed = Date.now() - lastRequestAt
      if (elapsed < REQUEST_COOLDOWN_MS) {
        sendJson(response, 429, {
          error: `Permission requests are rate limited (1 per ${REQUEST_COOLDOWN_MS / 1000}s per agent).`,
          error_code: 'rate_limited',
          retry_after_ms: REQUEST_COOLDOWN_MS - elapsed,
        })
        return
      }
    }

    const boundTask =
      typeof body.dispatch_id === 'string' && body.dispatch_id.trim()
        ? taskStore.getTaskByDispatchId(projectId, body.dispatch_id)
        : taskStore.getAssignedTaskForWorker(projectId, fromAgentId)
    if (boundTask) {
      taskStore.addLog(
        projectId,
        boundTask.id,
        `[APPROVAL REQUEST] ${command}${body.reason ? ` — ${body.reason}` : ''}`
      )
    }

    const created = store.createApprovalRequest({
      agentId: fromAgentId,
      command,
      dispatchId:
        typeof body.dispatch_id === 'string' && body.dispatch_id.trim()
          ? body.dispatch_id
          : (boundTask?.dispatchId ?? null),
      reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
      taskId: boundTask?.id ?? null,
      workspaceId: projectId,
    })
    // Push to paired Telegram chats; delivery failures must not fail the CLI.
    void store.notifyApprovalRequired(created).catch((error) => {
      console.error('[TEAM] approval push failed:', error instanceof Error ? error.message : error)
    })

    sendJson(response, 202, {
      ok: true,
      request_id: created.id,
      task_id: created.taskId,
      status: created.status,
    })
    return
  }),
  route('POST', '/api/team/engine', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      target?: string
      engine?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const targetName = requireNonEmptyString(body.target, 'target')
    const enginePreset = requireNonEmptyString(body.engine, 'engine')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'engine')

    const isOrchestrator =
      targetName.toLowerCase() === 'orchestrator' || targetName.toLowerCase() === '@orchestrator'

    let targetAgentId: string
    if (isOrchestrator) {
      targetAgentId = `${projectId}:orchestrator`
    } else {
      const cleanName = targetName.replace(/^@/, '')
      const workers = store.listWorkers(projectId)
      const found = workers.find(
        (w) => w.name.toLowerCase() === cleanName.toLowerCase() || w.id === cleanName
      )
      if (!found) {
        throw new BadRequestError(`Worker not found: ${targetName}`)
      }
      targetAgentId = found.id
    }

    const launchConfig = resolveCommandPresetLaunchConfig(store.settings, enginePreset)
    if (!launchConfig) {
      throw new BadRequestError(`Unknown command preset / engine: ${enginePreset}`)
    }

    store.configureAgentLaunch(projectId, targetAgentId, launchConfig)

    sendJson(response, 200, {
      ok: true,
      target: targetName,
      agent_id: targetAgentId,
      engine: enginePreset,
    })
  }),
  // Model switching for any agent (orchestrator-only). Mirrors the UI
  // control-panel action; the engine capability registry validates the id.
  route('POST', '/api/team/model', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      target?: string
      model?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const targetName = requireNonEmptyString(body.target, 'target')
    const model = requireNonEmptyString(body.model, 'model')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'model')

    const isOrchestrator =
      targetName.toLowerCase() === 'orchestrator' || targetName.toLowerCase() === '@orchestrator'

    let targetAgentId: string
    if (isOrchestrator) {
      targetAgentId = `${projectId}:orchestrator`
    } else {
      const cleanName = targetName.replace(/^@/, '')
      const workers = store.listWorkers(projectId)
      const found = workers.find(
        (w) => w.name.toLowerCase() === cleanName.toLowerCase() || w.id === cleanName
      )
      if (!found) {
        throw new BadRequestError(`Worker not found: ${targetName}`)
      }
      targetAgentId = found.id
    }

    try {
      const result = await store.agentSwitchModel(projectId, targetAgentId, model)
      sendJson(response, 200, {
        ok: true,
        target: targetName,
        agent_id: targetAgentId,
        model: result.model,
        restarted: result.restarted,
      })
    } catch (error) {
      // Capability registry rejections (unknown/unsupported model id) surface
      // as typed 409s so the orchestrator can pick another id.
      sendJson(response, 409, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }),
  route('POST', '/api/team/accept', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      dispatch_id?: string
      task_id?: string
      note?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'accept')

    let task: TaskRecord | undefined
    if (body.task_id) {
      // B2: accept short board ids (`#f064b6b3`) alongside full UUIDs.
      try {
        task =
          taskStore.resolveTaskId(projectId, body.task_id) ??
          taskStore.getTask(projectId, body.task_id)
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error))
      }
      if (!task) {
        throw new BadRequestError(`Task not found: ${body.task_id}`)
      }
    } else if (body.dispatch_id) {
      task = taskStore.getTaskByDispatchId(projectId, body.dispatch_id)
      if (!task) {
        throw new BadRequestError(`No task found matching dispatch ID "${body.dispatch_id}"`)
      }
    } else {
      const reviewTasks = taskStore.listTasks(projectId).filter((t) => t.status === 'review')
      if (reviewTasks.length === 1) {
        task = reviewTasks[0]
      } else if (reviewTasks.length > 1) {
        throw new BadRequestError(
          `Multiple tasks are in Review. Specify which task to accept: team accept --dispatch <id> (or team accept --task <id>)`
        )
      } else {
        throw new BadRequestError('No task found in Review stage to accept')
      }
    }

    if (!task) {
      throw new BadRequestError('No task found in Review stage to accept')
    }

    if (task.status !== 'review') {
      throw new BadRequestError(
        `Task #${task.id.slice(0, 8)} ("${task.title}") is in status "${task.status}", not in Review stage.`
      )
    }

    const note = body.note?.trim() ? body.note.trim() : 'Работа принята оркестратором'
    const updated = taskStore.updateTask(projectId, task.id, {
      status: 'done',
    })
    taskStore.addComment(projectId, task.id, agent.name || 'Orchestrator', note, agent.role)
    taskStore.addLog(projectId, task.id, `[ОДОБРЕНО ОРКЕСТРАТОРОМ] ${note}`)

    try {
      const workspace = store.getWorkspaceSnapshot(projectId)
      syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(projectId))
    } catch {}

    sendJson(response, 200, {
      ok: true,
      task_id: updated?.id ?? task.id,
      dispatch_id: updated?.dispatchId ?? task.dispatchId ?? body.dispatch_id ?? null,
      status: 'done',
      note,
    })
  }),
  route('POST', '/api/team/rework', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
      dispatch_id?: string
      task_id?: string
      feedback?: string
      reason?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const feedback = requireNonEmptyString(body.feedback ?? body.reason, 'feedback')

    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'rework')

    let task: TaskRecord | undefined
    if (body.task_id) {
      // B2: accept short board ids (`#f064b6b3`) alongside full UUIDs.
      try {
        task =
          taskStore.resolveTaskId(projectId, body.task_id) ??
          taskStore.getTask(projectId, body.task_id)
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error))
      }
      if (!task) {
        throw new BadRequestError(`Task not found: ${body.task_id}`)
      }
    } else if (body.dispatch_id) {
      task = taskStore.getTaskByDispatchId(projectId, body.dispatch_id)
      if (!task) {
        throw new BadRequestError(`No task found matching dispatch ID "${body.dispatch_id}"`)
      }
    } else {
      const reviewTasks = taskStore.listTasks(projectId).filter((t) => t.status === 'review')
      if (reviewTasks.length === 1) {
        task = reviewTasks[0]
      } else if (reviewTasks.length > 1) {
        throw new BadRequestError(
          `Multiple tasks are in Review. Specify which task to rework: team rework --dispatch <id> "<feedback>"`
        )
      } else {
        throw new BadRequestError('No task found in Review stage to send back for rework')
      }
    }

    if (!task) {
      throw new BadRequestError('No task found in Review stage to send back for rework')
    }

    if (task.status !== 'review') {
      throw new BadRequestError(
        `Task #${task.id.slice(0, 8)} ("${task.title}") is in status "${task.status}", not in Review stage.`
      )
    }

    // review → running: разрешённый переход (агент берётся за доработку)
    const updated = taskStore.updateTask(projectId, task.id, {
      status: 'running',
    })
    taskStore.addComment(projectId, task.id, agent.name || 'Orchestrator', feedback, agent.role)
    taskStore.addLog(projectId, task.id, `[ОТПРАВЛЕНО НА ДОРАБОТКУ] ${feedback}`)

    if (task.assignedAgentId) {
      const workers = store.listWorkers(projectId)
      const worker = workers.find((w) => w.id === task.assignedAgentId)
      if (worker) {
        const prompt = buildTaskDispatchPrompt(
          task,
          `Замечания оркестратора по доработке: ${feedback}`
        )
        try {
          await store.dispatchTask(projectId, worker.id, prompt, {
            fromAgentId,
            gachiPort: String(request.socket.localPort ?? ''),
          })
        } catch (err) {
          console.error('[gachi] dispatch on rework failed', err)
        }
      }
    }

    try {
      const workspace = store.getWorkspaceSnapshot(projectId)
      syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(projectId))
    } catch {}

    sendJson(response, 200, {
      ok: true,
      task_id: updated?.id ?? task.id,
      dispatch_id: updated?.dispatchId ?? task.dispatchId ?? body.dispatch_id ?? null,
      status: 'running',
      feedback,
    })
  }),

  // --- GitHub PR flow (orchestrator-only, roadmap Wave 2). ---
  // Publishes a worker's `gachi/<agent>` branch (or an explicit branch) to
  // origin and opens a PR through the injected PrService.
  route('POST', '/api/team/pr/status', async ({ prService, request, response, store }) => {
    const body = await readJsonBody<{
      project_id?: string
      from_agent_id?: string
      token?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'pr')

    let workspacePath: string
    try {
      workspacePath = store.getWorkspaceSnapshot(projectId).summary.path
    } catch {
      sendJson(response, 404, { ok: false, error: 'workspace not found' })
      return
    }

    const status = prService.checkStatus(workspacePath)
    const openPrs = status.installed && status.authed ? prService.list(workspacePath) : []
    sendJson(response, 200, {
      error: status.error,
      installed: status.installed,
      open_prs: openPrs.map((pr) => ({
        head: pr.head,
        number: pr.number,
        state: pr.state,
        title: pr.title,
        url: pr.url,
      })),
    })
  }),

  route('POST', '/api/team/pr/create', async ({ prService, request, response, store }) => {
    const body = await readJsonBody<{
      agent_id?: string
      base?: string
      body?: string
      branch?: string
      from_agent_id?: string
      project_id?: string
      task_id?: string
      token?: string
      title?: string
    }>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'pr')

    let workspacePath: string
    try {
      workspacePath = store.getWorkspaceSnapshot(projectId).summary.path
    } catch {
      sendJson(response, 404, { ok: false, error: 'workspace not found' })
      return
    }

    // Branch resolution order: explicit branch → task's assignee → fail.
    let branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    let agentIdForBranch = typeof body.agent_id === 'string' ? body.agent_id.trim() : ''
    if (!branch && !agentIdForBranch && typeof body.task_id === 'string') {
      // B2: accept short board ids (`#f064b6b3`) alongside full UUIDs.
      let task: TaskRecord | undefined
      try {
        task =
          taskStore.resolveTaskId(projectId, body.task_id.trim()) ??
          taskStore.getTask(projectId, body.task_id.trim())
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error))
      }
      agentIdForBranch = task?.assignedAgentId ?? ''
    }
    if (!branch && agentIdForBranch)
      branch = resolveWorkerBranchName(workspacePath, agentIdForBranch)
    if (!branch) {
      sendJson(response, 400, {
        ok: false,
        error: 'branch, agent_id or task_id with an assigned worker is required',
      })
      return
    }

    try {
      const created = prService.create({
        base: typeof body.base === 'string' && body.base.trim() ? body.base.trim() : undefined,
        body:
          typeof body.body === 'string' && body.body.trim()
            ? body.body.slice(0, 16_000)
            : undefined,
        branch,
        cwd: workspacePath,
        title:
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim().slice(0, 200)
            : `PR for ${branch}`,
      })
      sendJson(response, 201, { ok: true, url: created.url, number: created.number, branch })
      // Audit trail: pin the PR into the originating card's journal so the
      // board, Telegram relay and worker prompts all see the link.
      if (typeof body.task_id === 'string' && body.task_id.trim()) {
        try {
          taskStore.addLog(projectId, body.task_id.trim(), `[PR] ${created.url}`)
        } catch {
          // Journal entry is best-effort; the PR itself already exists.
        }
      }
      return
    } catch (error) {
      if (error instanceof GhError) {
        sendJson(response, 409, { ok: false, error: error.message, kind: error.kind })
        return
      }
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }),
]
