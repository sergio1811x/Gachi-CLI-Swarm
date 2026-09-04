import { taskStore } from './task-store.js'
import type { WorkspaceRecord } from './workspace-store.js'

export const DEFAULT_INTERVAL_MS = 60_000

export const HEARTBEAT_DISABLED_VALUE = 0

/** Allowed values for the "check on agents" cadence, surfaced in the Orchestrator CLI dialog. */
export const HEARTBEAT_INTERVAL_OPTIONS_MS = [
  60_000,
  120_000,
  180_000,
  300_000,
  600_000,
  HEARTBEAT_DISABLED_VALUE,
] as const

/** Fallback poll delay while heartbeats are disabled, so re-enabling picks up promptly. */
const DISABLED_POLL_MS = 60_000

export const HEARTBEAT_INTERVAL_APP_STATE_KEY = 'orchestrator_heartbeat_interval_ms'

interface AppStatePort {
  getAppState: (key: string) => { value: string | null } | undefined
}

/** Reads the configured heartbeat cadence from app state, falling back to the default. */
export const readHeartbeatIntervalMs = (settings: AppStatePort): number => {
  const stored = settings.getAppState(HEARTBEAT_INTERVAL_APP_STATE_KEY)?.value
  const parsed = stored ? Number(stored) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INTERVAL_MS
}

/**
 * Строит fingerprint состояния воркспейса: статус задач + статус воркеров.
 * Если fingerprint изменился с прошлого тика — оркестратор получит уведомление.
 */
const buildTasksFingerprint = (workspaceId: string, snapshot: WorkspaceRecord): string => {
  const tasksPart = taskStore
    .listTasks(workspaceId)
    .filter(
      (t) =>
        t.status === 'ready' ||
        t.status === 'assigned' ||
        t.status === 'running' ||
        t.status === 'review' ||
        t.status === 'blocked'
    )
    .map((t) => `${t.id}:${t.status}:${t.assignedAgentId ?? ''}:${t.comments?.length ?? 0}`)
    .sort()
    .join('|')

  const workersPart = snapshot.agents
    .filter((a) => a.role !== 'orchestrator')
    .map((a) => `${a.id}:${a.status}`)
    .sort()
    .join('|')

  return `${tasksPart}||${workersPart}`
}

interface OrchestratorHeartbeatDeps {
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  dispatchReadyTasks?: (workspaceId: string) => Promise<void> /**
   * Retries queued orchestrator notifications (worker reports whose PTY
   * injection failed earlier). Runs every tick before the fingerprint check so
   * pending pushes are delivered even when board state is otherwise stable.
   */
  flushPendingNotifications?: (workspaceId: string) => number
  /**
   * Restarts the workspace orchestrator when its run is gone (crash, manual
   * kill). Checked every tick so a dead orchestrator self-heals instead of
   * staying down until the whole daemon restarts.
   */
  ensureOrchestratorRunning?: (workspaceId: string) => Promise<boolean>
  /** Static override, mainly for tests. Ignored when `getIntervalMs` is provided. */
  intervalMs?: number
  /** Re-read on every tick so the cadence can change without restarting the runtime. */
  getIntervalMs?: () => number
  listWorkspaces: () => Array<{ id: string }>
  /** Must return false when nothing was written (no active orchestrator run). */
  writeHeartbeatPrompt: (workspaceId: string) => boolean
  /**
   * Optional gate checked right before sending: skip the nudge when the
   * orchestrator's own CLI is still actively streaming a response, so
   * heartbeats don't pile up as unread queued input on a busy agent.
   */
  isOrchestratorFree?: (workspaceId: string) => boolean | Promise<boolean>
}

/**
 * Опрашивает состояние Канбан-доски и воркеров каждые N секунд.
 * Отправляет уведомление оркестратору ТОЛЬКО при реальном изменении состояния задач
 * (fingerprint по статусу + исполнителю + комментариям), предотвращая спам.
 * dispatchReadyTasks запускается на каждом тике для раздачи свободных задач.
 */
export const createOrchestratorHeartbeat = ({
  dispatchReadyTasks,
  flushPendingNotifications,
  ensureOrchestratorRunning,
  getWorkspaceSnapshot,
  intervalMs = DEFAULT_INTERVAL_MS,
  getIntervalMs,
  listWorkspaces,
  writeHeartbeatPrompt,
  isOrchestratorFree,
}: OrchestratorHeartbeatDeps) => {
  const resolveIntervalMs = () => getIntervalMs?.() ?? intervalMs
  const lastFingerprints = new Map<string, string>()

  const tick = async () => {
    if (resolveIntervalMs() === HEARTBEAT_DISABLED_VALUE) return
    for (const workspace of listWorkspaces()) {
      let snapshot: WorkspaceRecord
      try {
        snapshot = getWorkspaceSnapshot(workspace.id)
      } catch {
        continue
      }

      // Self-heal: a crashed/killed orchestrator run is restarted on the tick
      // instead of staying down until the daemon itself restarts.
      if (ensureOrchestratorRunning) {
        try {
          await ensureOrchestratorRunning(workspace.id)
        } catch (error) {
          console.error(
            `[ORCHESTRATOR] autorestart failed for ${workspace.id}:`,
            error instanceof Error ? error.message : error
          )
        }
      }

      // Раздаём задачи воркерам при каждом тике (не зависит от fingerprint)
      if (dispatchReadyTasks) {
        try {
          await dispatchReadyTasks(workspace.id)
        } catch (error) {
          console.error(
            `[ORCHESTRATOR] dispatch tick failed for ${workspace.id}:`,
            error instanceof Error ? error.message : error
          )
        }
      }

      // Retry queued worker-report pushes first: a report whose PTY injection
      // failed at settle time must reach the orchestrator even if the board
      // state does not change again afterwards.
      let inboxDelivered = 0
      if (flushPendingNotifications) {
        try {
          inboxDelivered = flushPendingNotifications(workspace.id)
        } catch (error) {
          console.error(
            `[ORCHESTRATOR] inbox flush failed for ${workspace.id}:`,
            error instanceof Error ? error.message : error
          )
        }
        if (inboxDelivered > 0) continue
      }

      const hasWorkingMember = snapshot.agents.some(
        (agent) => agent.role !== 'orchestrator' && agent.status === 'working'
      )
      const hasActiveTasks = taskStore
        .listTasks(workspace.id)
        .some(
          (t) =>
            t.status === 'ready' ||
            t.status === 'assigned' ||
            t.status === 'running' ||
            t.status === 'review'
        )

      if (!hasWorkingMember && !hasActiveTasks) {
        // Состояние чистое — сбрасываем fingerprint чтобы следующее появление задачи было замечено
        lastFingerprints.delete(workspace.id)
        continue
      }

      // Fingerprint: шлём heartbeat только если что-то изменилось.
      // The fingerprint is consumed ONLY after the notification was actually
      // written — consuming it before a successful write used to lose the
      // change forever when the orchestrator's PTY was unwritable or busy.
      const fingerprint = buildTasksFingerprint(workspace.id, snapshot)
      const prev = lastFingerprints.get(workspace.id)
      if (fingerprint === prev) continue

      const free = isOrchestratorFree ? await isOrchestratorFree(workspace.id) : true
      if (!free) continue

      // The write reports delivery honestly: a missing/unwritable orchestrator
      // run returns false, so the fingerprint stays pending for the next tick.
      const notified = (() => {
        try {
          return writeHeartbeatPrompt(workspace.id)
        } catch (error) {
          console.error(
            `[ORCHESTRATOR] heartbeat write failed for ${workspace.id}:`,
            error instanceof Error ? error.message : error
          )
          return false
        }
      })()
      if (notified) lastFingerprints.set(workspace.id, fingerprint)
    }
  }

  let timer: ReturnType<typeof setTimeout>
  const scheduleNext = () => {
    const nextDelay = resolveIntervalMs() || DISABLED_POLL_MS
    timer = setTimeout(() => {
      void tick()
        .catch((error) =>
          console.error(
            '[ORCHESTRATOR] heartbeat tick error:',
            error instanceof Error ? error.message : error
          )
        )
        .finally(scheduleNext)
    }, nextDelay)
    timer.unref?.()
  }
  scheduleNext()

  return {
    stop: () => clearTimeout(timer),
  }
}
