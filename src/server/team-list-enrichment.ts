import type { TeamListItem } from '../shared/types.js'
import type { AgentLifecycleState } from './agent-lifecycle.js'
import { getWorkspaceActivity, minutesSinceLastArtifact } from './artifact-clock.js'
import type { RuntimeStore } from './runtime-store.js'
import { taskStore } from './task-store.js'

export type TeamListEnrichmentStore = Pick<
  RuntimeStore,
  | 'getActiveRunByAgentId'
  | 'getLastDispatchForWorker'
  | 'getLastPtyActivityAt'
  | 'getLastPtyLineForAgent'
  | 'peekAgentLaunchConfig'
  | 'settings'
> & {
  getAgentLifecycleState?: (workspaceId: string, agentId: string) => AgentLifecycleState | null
  getAgentLifecycleError?: (workspaceId: string, agentId: string) => string | null
  /** Memory-watchdog telemetry (absent in narrow test doubles). */
  getWorkerRssMb?: (workspaceId: string, agentId: string) => number | null
}

/**
 * Resolves the built-in command preset id for a worker. Mirrors the launch-time
 * lookup in `agent-run-bootstrap.ts::resolveLaunchPreset`: explicit
 * `commandPresetId` first, then implicit by matching `config.command` against a
 * built-in preset record. Returns null when the worker was launched with a
 * custom command, when augmentation has been disabled on the config (the
 * launcher won't apply preset behavior, so claiming the brand logo would be a
 * lie), or when there is no launch config row yet (worker created but never
 * configured).
 */
export const resolveCommandPresetId = (
  store: Pick<RuntimeStore, 'peekAgentLaunchConfig' | 'settings'>,
  workspaceId: string,
  workerId: string
): string | null => {
  const config = store.peekAgentLaunchConfig(workspaceId, workerId)
  if (!config) return null
  if (config.presetAugmentationDisabled) return null
  if (config.commandPresetId) return config.commandPresetId
  const implicit = store.settings.getCommandPreset(config.command)
  if (!implicit || implicit.command !== config.command) return null
  return implicit.id
}

/**
 * Folds the transient signals exposed on team list payloads — last PTY
 * line (read fresh per request), resolved command preset id (read from the
 * launch cache), PTY activity timestamp, dispatch timestamps, and active
 * run status — into the in-memory worker records. The records themselves
 * stay narrow (`workspace-store.listWorkers`) because the workspace store does
 * not own the launch cache; enrichment happens at the route boundary instead.
 */
export const enrichTeamList = async (
  workspaceId: string,
  store: TeamListEnrichmentStore,
  workers: TeamListItem[],
  options: { workspacePath?: string | null } = {}
): Promise<TeamListItem[]> =>
  Promise.all(
    workers.map(async (worker) => {
      const line = store.getLastPtyLineForAgent(workspaceId, worker.id)
      const config = store.peekAgentLaunchConfig(workspaceId, worker.id)
      const presetId = resolveCommandPresetId(store, workspaceId, worker.id)
      const ptyActivityAt = store.getLastPtyActivityAt
        ? store.getLastPtyActivityAt(workspaceId, worker.id)
        : null
      const activeRun = store.getActiveRunByAgentId
        ? store.getActiveRunByAgentId(workspaceId, worker.id)
        : undefined
      const lastDispatch = store.getLastDispatchForWorker
        ? store.getLastDispatchForWorker(workspaceId, worker.id)
        : undefined
      const rssMb = store.getWorkerRssMb?.(workspaceId, worker.id) ?? null

      const next: TeamListItem = { ...worker }
      if (line !== null) next.lastPtyLine = line
      if (presetId !== null) next.commandPresetId = presetId
      if (config) {
        next.command = config.command
        next.args = config.args ?? []
      }
      if (ptyActivityAt !== null) next.lastPtyOutputAt = ptyActivityAt
      if (activeRun !== undefined) {
        next.hasActiveRun = activeRun.status === 'starting' || activeRun.status === 'running'
        if (activeRun.paused) next.paused = true
      }
      if (rssMb !== null) next.rssMb = rssMb
      if (lastDispatch?.createdAt !== undefined) next.lastDispatchedAt = lastDispatch.createdAt
      if (lastDispatch?.deliveredAt !== undefined && lastDispatch.deliveredAt !== null) {
        next.lastDeliveredAt = lastDispatch.deliveredAt
      }
      let lifecycleStatus = store.getAgentLifecycleState?.(workspaceId, worker.id)
      const assignedTask =
        taskStore.getAssignedTaskForWorker(workspaceId, worker.id) ??
        taskStore.getAssignedTaskForWorker(workspaceId, worker.name)

      // Stuck diagnostics only make sense while the worker is actually busy. A
      // worker whose summary status is `idle` (or `stopped`/`waiting_decision`)
      // is not mid-delivery — a leftover assigned card or an ended run record
      // must not be reported as stuck, or lifecycle_status stays inconsistent
      // with status.
      const isBusy = next.status === 'working'

      // Диагностика 1: активный run висит на permission / onboarding экранах (bypass permissions, shift+tab, press enter)
      if (
        isBusy &&
        activeRun &&
        line &&
        /bypass permissions|shift\+tab to cycle|press enter to continue/i.test(line) &&
        lifecycleStatus === 'ready'
      ) {
        lifecycleStatus = 'stuck_on_prompt' as AgentLifecycleState
      }
      // Диагностика 2: задача в статусе assigned/running, run активен, но в терминале голый idle-промпт движка (? for shortcuts, Gemini, Claude>, Codex>)
      else if (
        isBusy &&
        activeRun &&
        assignedTask &&
        (assignedTask.status === 'assigned' || assignedTask.status === 'running') &&
        line &&
        /\? for shortcuts|gemini|antigravity|type your message|^[❯›?>]\s*$/i.test(line.trim()) &&
        (!lastDispatch?.deliveredAt || Date.now() - (lastDispatch.deliveredAt ?? 0) > 10_000)
      ) {
        lifecycleStatus = 'stuck_no_task_delivered' as AgentLifecycleState
      }

      if (lifecycleStatus) next.lifecycleStatus = lifecycleStatus
      // Orchestrator feedback #2: surface WHY a run died (classified from the
      // PTY tail) next to the status instead of hiding it in lifecycle rows.
      const lastError = store.getAgentLifecycleError?.(workspaceId, worker.id)
      if (lastError) next.lastFailure = lastError
      if (assignedTask) {
        next.currentTaskId = assignedTask.id
        next.currentTaskTitle = assignedTask.title
        next.currentTaskStatus = assignedTask.status
        if (assignedTask.status === 'review' && next.status !== 'stopped') {
          next.status = 'waiting_decision'
        }
      }
      // Orchestrator feedback #3: file-activity clock. A worker can stream PTY
      // spinner frames forever while touching nothing; the freshest artifact
      // mtime is the honest "is it actually producing" signal.
      const isBusyWorker = next.status === 'working' || Boolean(next.hasActiveRun)
      if (isBusyWorker && options.workspacePath) {
        try {
          const activity = await getWorkspaceActivity(options.workspacePath)
          next.lastArtifactAt = activity.lastArtifactAt ?? null
          next.changedFiles = activity.changedFiles
          const minutes = minutesSinceLastArtifact(activity)
          if (minutes !== null) next.minutesSinceLastArtifact = minutes
        } catch {
          // Diagnostics are best-effort — never fail the list over them.
        }
      }
      return next
    })
  )
