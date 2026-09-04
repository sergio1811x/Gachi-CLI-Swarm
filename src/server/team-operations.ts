import { createAgentSnapshot, persistAgentSnapshot } from './agent-handoff.js'
import type { AgentLifecycleState } from './agent-lifecycle.js'
import type { AgentRuntime } from './agent-runtime.js'
import { readAgentSessionSnapshot, updateAgentSessionTaskContext } from './agent-session-journal.js'
import { buildOrchestratorReportPayload } from './agent-stdin-dispatcher.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { ConflictError, PtyInactiveError } from './http-errors.js'
import type { MessageLogHandle, MessageLogRecord } from './message-log-store.js'
import { getReviewTask, parseReviewVerdict } from './reviewer-pipeline.js'
import {
  createReportMessage,
  createSendMessage,
  createStatusMessage,
  createUserInputMessage,
} from './runtime-message-builders.js'
import { parseStructuredCompletion } from './task-completion.js'
import { taskStore, type UpdateTaskInput } from './task-store.js'
import { syncTasksMarkdownFile } from './tasks-file.js'
import type { WorkerOutputTracker } from './worker-output-tracker.js'
import type { WorkspaceStore } from './workspace-store.js'

export interface TeamOperationsInput {
  agentRuntime: AgentRuntime
  /** Links the worker's active run to the task so the supervisor can settle it on exit. */
  bindRunTask?: (workspaceId: string, agentId: string, taskId: string) => void
  createDispatch: (input: {
    fromAgentId?: string
    text: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord
  deleteDispatch: (dispatchId: string) => void
  deleteMessage: (handle: MessageLogHandle) => void
  findOpenDispatch: (
    workspaceId: string,
    toAgentId: string,
    dispatchId?: string
  ) => DispatchRecord | undefined
  findOpenDispatchById: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
  insertMessage: (record: MessageLogRecord) => MessageLogHandle
  markDispatchCancelled: (input: {
    dispatchId: string
    reason: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchReportedByWorker: (input: {
    artifacts: string[]
    dispatchId?: string
    reportText: string
    toAgentId: string
    workspaceId: string
  }) => DispatchRecord | undefined
  /** Force-cancel a dispatch in any non-cancelled status (see ledger store). */
  deleteDispatchForced: (input: {
    id: string
    reason: string
    workspaceId: string
  }) => DispatchRecord | undefined
  markDispatchDelivered: (dispatchId: string) => void
  markDispatchSubmitted: (dispatchId: string) => void
  /** Optional hook to record the worker's current task as the heartbeat phase. */
  recordHeartbeat?: (workspaceId: string, agentId: string, phase: string) => void
  /** Called when a worker frees up (reports a task), so the dispatcher can pick the next task. */
  onWorkerReleased?: (workspaceId: string) => void
  /**
   * Push-first notification of a settled report to the orchestrator (backed by
   * the orchestrator inbox: immediate PTY injection with queued retry). The
   * heartbeat fingerprint remains as the backup channel.
   */
  pushOrchestratorUpdate?: (workspaceId: string, payload: string) => void
  transitionLifecycle?: (
    workspaceId: string,
    agentId: string,
    state: AgentLifecycleState,
    input?: { error?: string | null; reason?: string; runId?: string | null }
  ) => void
  workspaceStore: WorkspaceStore
  workerOutputTracker?: WorkerOutputTracker | null
}

export interface DispatchTaskInput {
  fromAgentId?: string
  gachiPort?: string
}

export interface ReportTaskInput {
  artifacts?: string[]
  dispatchId?: string
  requireActiveRun?: boolean
  status?: string
  text?: string
}

export interface StatusTaskInput {
  artifacts?: string[]
  requireActiveRun?: boolean
  text?: string
}

export interface CancelTaskInput {
  fromAgentId: string
  reason: string
}

export interface ReportTaskResult {
  dispatch: DispatchRecord | null
  forwardError: string | null
  forwarded: boolean
}

const reportForwardErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const createTeamOperations = ({
  agentRuntime,
  bindRunTask,
  createDispatch,
  deleteDispatch,
  deleteDispatchForced,
  deleteMessage,
  findOpenDispatch,
  findOpenDispatchById,
  insertMessage,
  markDispatchCancelled,
  markDispatchDelivered,
  markDispatchReportedByWorker,
  markDispatchSubmitted,
  onWorkerReleased,
  pushOrchestratorUpdate,
  recordHeartbeat,
  transitionLifecycle,
  workspaceStore,
  workerOutputTracker,
}: TeamOperationsInput) => {
  const ensureWorkerRun = async (workspaceId: string, workerId: string, gachiPort: string) => {
    if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
      return
    }

    const config = agentRuntime.peekAgentLaunchConfig(workspaceId, workerId)
    if (!config) {
      throw new ConflictError('No worker launch config available')
    }

    transitionLifecycle?.(workspaceId, workerId, 'starting', {
      error: null,
      reason: 'dispatch_start_requested',
      runId: null,
    })
    workspaceStore.markAgentStarted(workspaceId, workerId)
    try {
      const run = await agentRuntime.startAgent(
        workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        workerId,
        { gachiPort }
      )
      if (run.status === 'error') {
        transitionLifecycle?.(workspaceId, workerId, 'failed', {
          error: `${config.command} failed to start`,
          reason: 'dispatch_start_failed',
          runId: run.runId,
        })
        workspaceStore.markAgentStopped(workspaceId, workerId)
        throw new ConflictError(`${config.command} failed to start`)
      }
      // Mirror the autostart path: attach the output tracker so the handshake
      // (TASK_ACK) and progress can be observed for runs started on dispatch.
      workerOutputTracker?.attach(workspaceId, workerId, run.runId, run.output)
      transitionLifecycle?.(workspaceId, workerId, 'ready', {
        error: null,
        reason: 'dispatch_process_started',
        runId: run.runId,
      })
    } catch (error) {
      transitionLifecycle?.(workspaceId, workerId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        reason: 'dispatch_start_failed',
        runId: null,
      })
      workspaceStore.markAgentStopped(workspaceId, workerId)
      throw error
    }
  }

  const dispatchTask = async (
    workspaceId: string,
    workerId: string,
    text: string,
    input: DispatchTaskInput = {}
  ) => {
    const message = createSendMessage(workspaceId, workerId, text, input.fromAgentId)
    const messageHandle = insertMessage(message)
    let dispatch: DispatchRecord | undefined
    // Card created by THIS call (not a poke of an existing one). If delivery
    // fails below, it must be rolled back — otherwise the worker's queue
    // accumulates zombie cards that nobody will ever run (orchestrator
    // feedback: dozens of dead cards bound to a worker that never started).
    let createdTask: { id: string } | undefined

    try {
      const dispatchInput: {
        fromAgentId?: string
        text: string
        toAgentId: string
        workspaceId: string
      } = {
        text,
        toAgentId: workerId,
        workspaceId,
      }
      if (input.fromAgentId) dispatchInput.fromAgentId = input.fromAgentId
      dispatch = createDispatch(dispatchInput)

      // Resolve or create the worker's task card SYNCHRONOUSLY, before any
      // `await` (ensureWorkerRun below). Two concurrent dispatches to the same
      // worker used to both pass the "no active task" check across the async
      // gap and each create a fresh card — the board filled with 2-3+ duplicates
      // and broke the single-task-per-worker logic. Doing check-then-create here,
      // with no awaits in between (single-threaded), makes the second call see
      // the first's card and poke it instead of duplicating.
      let assignedTask = taskStore.getAssignedTaskForWorker(workspaceId, workerId)
      if (assignedTask) {
        // Poke the existing in-flight task rather than create a duplicate:
        // append the new text and reopen `review` → `assigned`. `running` /
        // `claimed` keep their status (the state machine forbids forced moves).
        //
        // Close the previously bound dispatch row first: the card's dispatchId
        // is about to be re-stamped, and reconcile rebuilds cards from every
        // non-cancelled ledger row — leaving the old row behind resurrects a
        // phantom duplicate of this very card. An OPEN row is cancelled; an
        // already-`reported` row (work already merged into this card by
        // reportTask) needs the forced path, exactly like deleteTaskCard.
        if (assignedTask.dispatchId) {
          const supersededId = assignedTask.dispatchId
          const supersedeReason = `superseded by dispatch ${dispatch.id}`
          if (findOpenDispatchById(workspaceId, supersededId)) {
            markDispatchCancelled({
              dispatchId: supersededId,
              reason: supersedeReason,
              workspaceId,
            })
            // The closed row no longer counts as pending work for this worker.
            workspaceStore.markTaskCancelled(workspaceId, workerId)
          } else {
            deleteDispatchForced({
              id: supersededId,
              reason: supersedeReason,
              workspaceId,
            })
          }
        }
        const updates: UpdateTaskInput = {
          dispatchId: dispatch.id,
          // Bounded merge (S-2): the old append-everything made `description`
          // grow on every poke until the tasks blob exceeded SQLite's bind
          // limit. Keep the TAIL — recent instructions matter most — and let
          // the store's clamp provide the final guarantee.
          description: assignedTask.description
            ? `${assignedTask.description}\n\n---\n${text}`.slice(-16_000)
            : text,
        }
        if (assignedTask.status === 'review') updates.status = 'assigned'
        taskStore.updateTask(workspaceId, assignedTask.id, updates)
      } else {
        const title =
          text
            .split('\n')[0]
            ?.replace(/^#+\s*/, '')
            .trim()
            .slice(0, 80) || `Задача для @${workerId.split(':').pop()}`
        assignedTask = taskStore.createTask(workspaceId, {
          title,
          description: text,
          status: 'assigned',
          assignedAgentId: workerId,
          dispatchId: dispatch.id,
        })
        createdTask = { id: assignedTask.id }
        taskStore.addLog(
          workspaceId,
          assignedTask.id,
          `[DISPATCH #${dispatch.id.slice(0, 8)}] Задача назначена @${workerId.split(':').pop()} (ожидание доставки в PTY)`
        )
      }

      if (input.fromAgentId) {
        const sender = workspaceStore.getAgent(workspaceId, input.fromAgentId)
        await ensureWorkerRun(workspaceId, workerId, input.gachiPort ?? '')
        const worker = workspaceStore.getWorker(workspaceId, workerId)
        // Mark submitted only after the write call itself succeeds (does not throw) —
        // e.g. no active run, or a synchronous PTY failure — so the ledger can't claim
        // "submitted" for a dispatch that never reached the CLI. delivered_at is a
        // separate, later stamp: it fires from onDelivered once the payload actually
        // settles into the PTY (may be well after this call returns).
        const dispatchId = dispatch.id
        const onDelivered = () => {
          markDispatchDelivered(dispatchId)
          workspaceStore.markTaskDispatched(workspaceId, workerId)
          if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
            transitionLifecycle?.(workspaceId, workerId, 'working', {
              reason: 'task_delivered_to_pty',
            })
            recordHeartbeat?.(workspaceId, workerId, assignedTask?.title ?? text)
          }
          if (assignedTask) {
            try {
              taskStore.markTaskRunning(workspaceId, assignedTask.id)
              bindRunTask?.(workspaceId, workerId, assignedTask.id)
              taskStore.addLog(
                workspaceId,
                assignedTask.id,
                `[DISPATCH #${dispatchId.slice(0, 8)}] Текст задачи успешно доставлен в PTY воркера (status: running)`
              )
            } catch {}
          }
        }

        agentRuntime.writeSendPrompt(
          workspaceId,
          workerId,
          dispatchId,
          sender.name,
          worker.description,
          text,
          onDelivered
        )
        markDispatchSubmitted(dispatch.id)
      } else {
        workspaceStore.markTaskDispatched(workspaceId, workerId)
        if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
          transitionLifecycle?.(workspaceId, workerId, 'working', {
            reason: 'task_dispatched',
          })
          const taskTitle = text
            .split('\n')[0]
            ?.replace(/^#+\s*/, '')
            .trim()
            .slice(0, 80)
          if (taskTitle) recordHeartbeat?.(workspaceId, workerId, taskTitle)
        }
      }

      // Привязка карточки и синхронизация tasks.md (карточка уже создана/покнута выше).
      try {
        const ws = workspaceStore.getWorkspaceSnapshot(workspaceId)
        syncTasksMarkdownFile(ws.summary.path, taskStore.listTasks(workspaceId))
        bindRunTask?.(workspaceId, workerId, assignedTask.id)
        updateAgentSessionTaskContext(ws.summary.path, workerId, {
          artifacts: assignedTask.artifacts ?? [],
          status: assignedTask.status,
          summary: assignedTask.description.slice(0, 1000),
          taskId: assignedTask.id,
          updatedAt: assignedTask.updatedAt,
        })
      } catch (err) {
        console.error('[gachi] task store sync in dispatchTask failed', err)
      }

      return dispatch
    } catch (error) {
      if (dispatch) deleteDispatch(dispatch.id)
      if (createdTask) {
        try {
          taskStore.deleteTask(workspaceId, createdTask.id)
          console.warn(
            `[DISPATCH] rolled back card #${createdTask.id.slice(0, 8)} — delivery to @${workerId.split(':').pop()} failed`
          )
        } catch (cleanupError) {
          console.error('[DISPATCH] rollback of freshly created card failed', cleanupError)
        }
      }
      deleteMessage(messageHandle)
      throw error
    }
  }

  const cancelByDispatchId = (
    workspaceId: string,
    dispatchId: string,
    input: CancelTaskInput
  ): ReportTaskResult => {
    workspaceStore.getAgent(workspaceId, input.fromAgentId)
    const openDispatch = findOpenDispatchById(workspaceId, dispatchId)
    if (!openDispatch) {
      throw new ConflictError(`No open dispatch: ${dispatchId}`)
    }
    const dispatch = markDispatchCancelled({
      dispatchId,
      reason: input.reason,
      workspaceId,
    })
    if (!dispatch) {
      throw new ConflictError(`No open dispatch: ${dispatchId}`)
    }
    workspaceStore.markTaskCancelled(workspaceId, dispatch.toAgentId)
    let forwardError: string | null = null
    let forwarded = false
    try {
      agentRuntime.writeCancelPrompt(workspaceId, dispatch.toAgentId, dispatch.id, input.reason)
      forwarded = true
    } catch (error) {
      forwardError = reportForwardErrorMessage(error)
      console.error('[gachi] swallowed:teamCancel.forward', error)
    }
    return { dispatch, forwardError, forwarded }
  }

  return {
    /**
     * Guaranteed-delivery backstop: re-injects the exact payload of a
     * submitted-but-never-delivered dispatch while the worker's run is still
     * alive. A paste swallowed by a busy/mid-render CLI used to leave the card
     * `assigned` forever with no terminal input; this replays the SAME dispatch
     * id (idempotent payload) instead of waiting for the watchdog to tear the
     * assignment down.
     */
    reinjectUndeliveredDispatch(workspaceId: string, workerId: string, minAgeMs: number): boolean {
      const open = findOpenDispatch(workspaceId, workerId)
      if (!open || open.deliveredAt !== null || open.submittedAt === null) return false
      if (Date.now() - open.submittedAt < minAgeMs) return false
      if (!agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) return false
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const senderId = open.fromAgentId ?? `${workspaceId}:orchestrator`
      const sender = workspaceStore.getAgent(workspaceId, senderId)
      agentRuntime.writeSendPrompt(
        workspaceId,
        workerId,
        open.id,
        sender.name,
        worker.description,
        open.text
      )
      // Refresh the submitted timestamp so the retry cadence is bounded by the
      // caller's tick instead of re-injecting in a tight loop.
      markDispatchSubmitted(open.id)
      const assignedTask = taskStore.getAssignedTaskForWorker(workspaceId, workerId)
      if (assignedTask) {
        taskStore.addLog(
          workspaceId,
          assignedTask.id,
          `[DISPATCH #${open.id.slice(0, 8)}] Доставка не подтверждена — текст задачи повторно отправлен в PTY воркера`
        )
      }
      return true
    },

    cancelTask(workspaceId: string, dispatchId: string, input: CancelTaskInput) {
      return cancelByDispatchId(workspaceId, dispatchId, input)
    },
    /**
     * Cancel by task id — for the orchestrator/user who sees a zombie card on
     * the board but not its dispatch id. Cancels the bound open dispatch when
     * one exists (same path as cancelTask); otherwise settles the card to
     * `canceled` directly and frees the worker's pending count.
     */
    cancelTaskById(workspaceId: string, taskId: string, input: CancelTaskInput) {
      workspaceStore.getAgent(workspaceId, input.fromAgentId)
      // B2: accept short board ids (`#f064b6b3`) alongside full UUIDs.
      const task =
        taskStore.resolveTaskId(workspaceId, taskId) ?? taskStore.getTask(workspaceId, taskId)
      if (!task) {
        throw new ConflictError(`No task: ${taskId}`)
      }
      const resolvedId = task.id
      const boundDispatchId = task.dispatchId
      if (boundDispatchId && findOpenDispatchById(workspaceId, boundDispatchId)) {
        const result = cancelByDispatchId(workspaceId, boundDispatchId, input)
        // Settle the card itself too — cancel-by-dispatch alone leaves the
        // board row behind, which is exactly what zombie cards are.
        taskStore.updateTask(workspaceId, resolvedId, { status: 'canceled' })
        taskStore.addLog(workspaceId, resolvedId, `[CANCEL] ${input.reason}`)
        return { ...result, taskId: resolvedId }
      }
      taskStore.updateTask(workspaceId, resolvedId, { status: 'canceled' })
      if (task.assignedAgentId) {
        try {
          // Unknown/deleted assignee must not break card deletion.
          workspaceStore.markTaskCancelled(workspaceId, task.assignedAgentId)
        } catch {
          // Worker record already gone.
        }
      }
      taskStore.addLog(workspaceId, resolvedId, `[CANCEL] ${input.reason}`)
      return { dispatch: null, forwardError: null, forwarded: false, taskId: resolvedId }
    },
    /**
     * Physically remove a zombie card from history so dispatch-ledger
     * reconciliation can never resurrect it. Any dispatch bound to the card is
     * force-cancelled first — including already-`reported` rows, which the
     * reconcile loop would otherwise rebuild as zombie review cards. The
     * worker's pending count is settled too.
     */
    deleteTaskCard(workspaceId: string, taskId: string, input: CancelTaskInput): boolean {
      workspaceStore.getAgent(workspaceId, input.fromAgentId)
      // B2: accept short board ids (`#f064b6b3`) alongside full UUIDs.
      const task =
        taskStore.resolveTaskId(workspaceId, taskId) ?? taskStore.getTask(workspaceId, taskId)
      if (!task) return false
      const boundDispatchId = task.dispatchId
      if (boundDispatchId) {
        const open = findOpenDispatchById(workspaceId, boundDispatchId)
        markDispatchCancelled({
          dispatchId: boundDispatchId,
          reason: input.reason,
          workspaceId,
        })
        // markDispatchCancelled only closes open (queued/submitted) rows; a
        // reported row needs the forced path or the card resurrects on reconcile.
        if (!open) {
          deleteDispatchForced({
            id: boundDispatchId,
            reason: input.reason,
            workspaceId,
          })
        }
        try {
          agentRuntime.writeCancelPrompt(
            workspaceId,
            task.assignedAgentId ?? open?.toAgentId ?? '',
            boundDispatchId,
            input.reason
          )
        } catch {
          // Best-effort: the card is being deleted regardless.
        }
      }
      if (task.assignedAgentId) {
        try {
          workspaceStore.markTaskCancelled(workspaceId, task.assignedAgentId)
        } catch {
          // Assignee record may already be gone (deleted worker / test fixture).
        }
      }
      return taskStore.deleteTask(workspaceId, task.id)
    },
    dispatchTask,
    async dispatchTaskByWorkerName(
      workspaceId: string,
      workerName: string,
      text: string,
      input: DispatchTaskInput = {}
    ) {
      // B7 healing: the shell splits an unquoted multi-word worker name
      // (`team send Theme Scout A "fix it"`) into name `Theme` plus text
      // `Scout A fix it`. When the exact name misses, re-join leading text
      // words onto the name (longest candidate first) so the dispatch is not
      // silently mis-addressed; otherwise fall through to the normal lookup.
      let targetName = workerName
      let taskText = text
      const workers = workspaceStore.listWorkers(workspaceId)
      if (!workers.some((item) => item.name === workerName)) {
        const words = text.trim().split(/\s+/).filter(Boolean)
        for (let take = Math.min(words.length, 6); take >= 1; take -= 1) {
          const candidate = `${workerName} ${words.slice(0, take).join(' ')}`
          if (!workers.some((item) => item.name === candidate)) continue
          const rest = words.slice(take).join(' ')
          if (!rest) continue
          targetName = candidate
          taskText = rest
          break
        }
      }
      const worker = workspaceStore.getWorkerByName(workspaceId, targetName)
      // PROTECTION (snowball guard): a worker that already owns an in-flight task
      // (claimed/assigned/running) must not be poked again by a fresh `team send`.
      // Poking re-delivers the text to the PTY and inflates pendingTaskCount, which
      // is exactly how an inert worker stays pinned in `working` and accumulates a
      // growing queue. Reject instead so the orchestrator queues via the Kanban
      // board; the dispatcher delivers it once the worker frees up. This path is
      // the `team send` route only — the kanban dispatcher calls `dispatchTask`
      // directly and is unaffected.
      const inFlight = taskStore.getAssignedTaskForWorker(workspaceId, worker.id)
      if (
        inFlight &&
        (inFlight.status === 'claimed' ||
          inFlight.status === 'assigned' ||
          inFlight.status === 'running')
      ) {
        throw new ConflictError(
          `Worker ${worker.name} is already working on task #${inFlight.id.slice(
            0,
            8
          )} ("${inFlight.title}"). If the worker is stuck, unblock with ` +
            `\`team worker stop ${worker.name} --cancel-task\` and resend; ` +
            `otherwise create the task on the Kanban board to queue it, or wait for the worker to report.`
        )
      }
      return dispatchTask(workspaceId, worker.id, taskText, input)
    },
    recordUserInput(workspaceId: string, orchestratorId: string, text: string): boolean {
      workspaceStore.getAgent(workspaceId, orchestratorId)
      const delivered = agentRuntime.writeUserInputPrompt(workspaceId, text)
      insertMessage(createUserInputMessage(workspaceId, orchestratorId, text))
      return delivered
    },
    statusTask(workspaceId: string, workerId: string, input: StatusTaskInput = {}) {
      const text = input.text ?? ''
      const artifacts = input.artifacts ?? []
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      const messageHandle = insertMessage(
        createStatusMessage(workspaceId, workerId, text, artifacts)
      )
      try {
        const assignedTask = taskStore.getAssignedTaskForWorker(workspaceId, workerId)
        if (assignedTask) {
          taskStore.addLog(
            workspaceId,
            assignedTask.id,
            `[СТАТУС] @${worker.name}: ${text.slice(0, 150)}${text.length > 150 ? '...' : ''}`
          )
        }
        return { dispatch: null, forwardError: null, forwarded: true }
      } catch (error) {
        deleteMessage(messageHandle)
        throw error
      }
    },
    reportTask(workspaceId: string, workerId: string, input: ReportTaskInput = {}) {
      const text = input.text ?? ''
      const status = input.status
      const artifacts = input.artifacts ?? []
      const completion = parseStructuredCompletion(text)
      const worker = workspaceStore.getWorker(workspaceId, workerId)
      if (
        input.requireActiveRun === true &&
        !agentRuntime.getActiveRunByAgentId(workspaceId, `${workspaceId}:orchestrator`)
      ) {
        throw new PtyInactiveError(`No active run for agent: ${workspaceId}:orchestrator`)
      }
      const openDispatch = findOpenDispatch(workspaceId, workerId, input.dispatchId)
      // Tasks auto-assigned at worker start have no dispatch-ledger row, so a
      // worker must be able to report against its assigned task without one.
      // Only reject the report when there is neither an open dispatch nor an
      // in-flight assigned task to attach it to.
      const workerAssignedTask = taskStore.getAssignedTaskForWorker(workspaceId, workerId)
      if (!openDispatch && !workerAssignedTask) {
        throw new ConflictError(`No open dispatch or assigned task for worker: ${worker.name}`)
      }
      const messageHandle = insertMessage(
        createReportMessage(workspaceId, workerId, text, status, artifacts)
      )
      try {
        let dispatch: DispatchRecord | null = null
        if (openDispatch) {
          const marked = markDispatchReportedByWorker({
            artifacts,
            ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
            reportText: text,
            toAgentId: workerId,
            workspaceId,
          })
          if (!marked) {
            throw new ConflictError(`No open dispatch for worker: ${worker.name}`)
          }
          dispatch = marked
        }

        const stringArtifacts = (artifacts || []).filter((a): a is string => typeof a === 'string')

        let assignedTask =
          (input.dispatchId
            ? taskStore.getTaskByDispatchId(workspaceId, input.dispatchId)
            : undefined) ??
          (dispatch?.id ? taskStore.getTaskByDispatchId(workspaceId, dispatch.id) : undefined) ??
          taskStore.getAssignedTaskForWorker(workspaceId, workerId)
        const reportDispatchId = dispatch?.id ?? assignedTask?.dispatchId

        const reviewVerdict =
          worker.role === 'reviewer' && assignedTask ? parseReviewVerdict(text) : null
        const reviewAssignedTask = assignedTask
        const reviewTask = reviewAssignedTask
          ? getReviewTask(workspaceId, reviewAssignedTask.id)
          : undefined
        if (reviewVerdict && reviewTask && reviewAssignedTask) {
          const originalTask = taskStore.getTask(workspaceId, reviewTask.parentTaskId)
          taskStore.addComment(workspaceId, reviewAssignedTask.id, worker.name, text, worker.role)
          taskStore.updateTask(workspaceId, reviewAssignedTask.id, {
            ...(reportDispatchId ? { dispatchId: reportDispatchId } : {}),
            result: text,
            artifacts: stringArtifacts,
            status: 'done',
          })
          if (originalTask) {
            taskStore.addComment(workspaceId, originalTask.id, worker.name, text, worker.role)
            if (reviewVerdict === 'approve') {
              taskStore.updateTask(workspaceId, originalTask.id, {
                status: 'done',
                result: text,
                artifacts: stringArtifacts,
              })
              taskStore.addLog(
                workspaceId,
                originalTask.id,
                `[REVIEWER] @${worker.name} одобрил задачу (APPROVE)`
              )
            } else {
              taskStore.updateTask(workspaceId, originalTask.id, {
                status: 'ready',
                assignedAgentId: null,
              })
              taskStore.addLog(
                workspaceId,
                originalTask.id,
                `[REVIEWER] @${worker.name} вернул задачу на доработку: ${text.slice(0, 300)}`
              )
            }
          }
          // Worker release happens only after every task mutation succeeded —
          // a failed settlement must leave the worker busy so the report can
          // be retried instead of silently lost with a freed worker.
          workspaceStore.markTaskReported(workspaceId, workerId)
          onWorkerReleased?.(workspaceId)
          if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
            transitionLifecycle?.(workspaceId, workerId, 'ready', {
              reason: 'review_verdict_submitted',
            })
          }
          syncTasksMarkdownFile(
            workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
            taskStore.listTasks(workspaceId)
          )
          updateAgentSessionTaskContext(
            workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
            workerId,
            {
              artifacts: stringArtifacts,
              status: 'done',
              summary: text.slice(0, 1000),
              taskId: reviewAssignedTask.id,
              updatedAt: reviewAssignedTask.updatedAt,
            }
          )
          pushOrchestratorUpdate?.(
            workspaceId,
            buildOrchestratorReportPayload(
              worker.name,
              text,
              stringArtifacts,
              reviewAssignedTask.id
            )
          )
          return { dispatch, forwardError: null, forwarded: false }
        }

        if (!assignedTask) {
          const title = `Отчёт @${worker.name}`
          assignedTask = taskStore.createTask(workspaceId, {
            title,
            description: `Задача выполнена агентом @${worker.name}`,
            status: 'review',
            assignedAgentId: workerId,
            ...(reportDispatchId ? { dispatchId: reportDispatchId } : {}),
            result: text,
            artifacts: stringArtifacts,
            completion,
          })
        } else {
          // Protocol contract (AGENTS.md): a task may not transition directly
          // to done — a worker report always settles the card into review;
          // only `team accept` / `team rework` move it further.
          assignedTask = taskStore.updateTask(workspaceId, assignedTask.id, {
            status: 'review',
            ...(reportDispatchId ? { dispatchId: reportDispatchId } : {}),
            result: text,
            artifacts: stringArtifacts,
            completion,
          })
        }
        if (!assignedTask) {
          throw new Error(`Task was not available after report for worker: ${worker.name}`)
        }
        // Worker release happens only after the card settled — see the
        // reviewer branch above.
        workspaceStore.markTaskReported(workspaceId, workerId)
        onWorkerReleased?.(workspaceId)
        if (agentRuntime.getActiveRunByAgentId(workspaceId, workerId)) {
          transitionLifecycle?.(
            workspaceId,
            workerId,
            assignedTask.status === 'review' ? 'waiting_input' : 'ready',
            {
              reason:
                assignedTask.status === 'review'
                  ? 'task_reported_for_review'
                  : 'task_reported_completed',
            }
          )
        }
        taskStore.addComment(workspaceId, assignedTask.id, worker.name, text, worker.role)
        taskStore.addLog(
          workspaceId,
          assignedTask.id,
          `[ОТЧЁТ] @${worker.name} сдал задачу и перевёл в Review (Ждет решения)`
        )

        try {
          const ws = workspaceStore.getWorkspaceSnapshot(workspaceId)
          syncTasksMarkdownFile(ws.summary.path, taskStore.listTasks(workspaceId))
          const taskContext = {
            artifacts: stringArtifacts,
            status: assignedTask.status,
            summary: text.slice(0, 1000),
            taskId: assignedTask.id,
            updatedAt: assignedTask.updatedAt,
          }
          if (updateAgentSessionTaskContext(ws.summary.path, workerId, taskContext)) {
            persistAgentSnapshot(
              ws.summary.path,
              createAgentSnapshot(readAgentSessionSnapshot(ws.summary.path, workerId))
            )
          }
        } catch {}

        // Push-first: the orchestrator learns about the finished task now, not
        // on the next heartbeat tick. The inbox queues the payload when the
        // orchestrator's PTY is unwritable and the heartbeat flush retries it.
        pushOrchestratorUpdate?.(
          workspaceId,
          buildOrchestratorReportPayload(worker.name, text, stringArtifacts, assignedTask.id)
        )

        return { dispatch, forwardError: null, forwarded: true }
      } catch (error) {
        deleteMessage(messageHandle)
        throw error
      }
    },
  }
}
