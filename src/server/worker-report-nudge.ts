import { buildWorkerReportNudgePayload, type WorkerReportNudgeTask } from './gachi-team-guidance.js'
import { type TaskRecord, taskStore } from './task-store.js'
import type { WorkspaceRecord } from './workspace-store.js'

export const WORKER_NUDGE_INTERVAL_MS = 60_000

/** Максимальное время между claim и реальным стартом агента (2 минуты). */
export const CLAIM_TIMEOUT_MS = 2 * 60_000

/** Минимальное число минут молчания терминала до первого напоминания (10 минут). */
export const WORKER_NUDGE_QUIET_TICKS = 10
/** Минимальное число минут молчания до фиксации предупреждения о простое (25 минут). */
export const WORKER_AUTO_IDLE_QUIET_TICKS = 25

/** Minimum gap between repeat nudges to the same worker, so a genuinely long-running task isn't spammed. */
export const WORKER_NUDGE_COOLDOWN_MS = 8 * 60_000

/** Кулдаун повторного триггера задачи — не чаще раза в 2 минуты. */
export const TASK_RETRIGGER_COOLDOWN_MS = 2 * 60_000

/**
 * A submitted dispatch that was never acknowledged after this long while the
 * worker's run is still alive is assumed swallowed by the CLI and re-injected.
 */
export const UNDELIVERED_REINJECT_AFTER_MS = 90_000

interface WorkerReportNudgeDeps {
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  listWorkspaces: () => Array<{ id: string }>
  writeWorkerReportNudge: (workspaceId: string, agentId: string, payload?: string) => void
  markTaskReported?: (workspaceId: string, agentId: string) => void
  hasActiveRun?: (workspaceId: string, agentId: string) => boolean
  /**
   * Detects whether an agent's PTY is currently quiescent (no significant
   * output growth over a short sampling window) — the same technique used by
   * `isOrchestratorFree` in orchestrator-heartbeat.ts, generalized to any
   * agent id.
   */
  isAgentQuiet: (workspaceId: string, agentId: string) => boolean | Promise<boolean>
  intervalMs?: number
  now?: () => number
  /** Called after a task is released/recovered so the dispatcher can pick the next task. */
  dispatchReadyTasks?: (workspaceId: string) => Promise<void>
  /**
   * Guaranteed delivery: re-injects a submitted-but-unacknowledged dispatch
   * payload into the worker's still-active run. Returns true when a re-inject
   * happened.
   */
  reinjectUndeliveredDispatch?: (workspaceId: string, agentId: string, minAgeMs: number) => boolean
}

/**
 * Every `intervalMs`, checks each workspace's non-orchestrator agents that
 * are `working`. Some CLI engines finish their assigned task (files on disk
 * change) but never call `team report`, leaving the orchestrator blind until
 * it happens to notice and manually re-nudge. An agent whose PTY has stayed
 * quiet for `WORKER_NUDGE_QUIET_TICKS` consecutive ticks while still marked
 * `working` gets one reminder injected directly into its own terminal via
 * `writeWorkerReportNudge`.
 */
/**
 * Builds a task-aware nudge payload. When the worker has an assigned task we
 * name it and pre-bind the `--dispatch` id so the worker can't brush the nudge
 * off with a generic "I'm active / waiting for tasks" reply.
 */
export const nudgePayloadForTask = (
  task: Pick<TaskRecord, 'id' | 'dispatchId' | 'title'> | undefined
): string => {
  if (!task) return buildWorkerReportNudgePayload()
  const dispatchId = task.dispatchId ?? task.id
  const descriptor: WorkerReportNudgeTask = {
    taskId: task.id.slice(0, 8),
    dispatchId,
    title: task.title,
  }
  return buildWorkerReportNudgePayload(descriptor)
}

export const createWorkerReportNudge = ({
  getWorkspaceSnapshot,
  listWorkspaces,
  writeWorkerReportNudge,
  markTaskReported,
  hasActiveRun,
  isAgentQuiet,
  dispatchReadyTasks,
  reinjectUndeliveredDispatch,
  intervalMs = WORKER_NUDGE_INTERVAL_MS,
  now = Date.now,
}: WorkerReportNudgeDeps) => {
  const quietStreaks = new Map<string, number>()
  // Кулдаун напоминаний для агентов (по ключу workspace:agentId)
  const lastNudgeAt = new Map<string, number>()
  // Кулдаун ретриггера для задач (по ключу taskId) — живёт отдельно от агентов
  const lastTaskRetriggerAt = new Map<string, number>()

  const trackerKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

  const tick = async () => {
    const seen = new Set<string>()
    for (const workspace of listWorkspaces()) {
      // Claim timeout: задача в CLAIMED/ASSIGNED без старта агента возвращается в READY.
      let releasedAny = false
      const released = taskStore.releaseExpiredClaims(CLAIM_TIMEOUT_MS, now())
      for (const entry of released) {
        releasedAny = true
        console.log(
          `[CLAIM TIMEOUT] Task #${entry.taskId.slice(0, 8)} re-released to READY (agent did not start)`
        )
      }
      if (releasedAny) await dispatchReadyTasks?.(workspace.id)
      let snapshot: WorkspaceRecord
      try {
        snapshot = getWorkspaceSnapshot(workspace.id)
      } catch {
        continue
      }
      for (const agent of snapshot.agents) {
        if (agent.role === 'orchestrator') continue
        const key = trackerKey(workspace.id, agent.id)
        if (agent.status !== 'working') continue
        seen.add(key)
        const quiet = await isAgentQuiet(workspace.id, agent.id)
        if (!quiet) {
          quietStreaks.delete(key)
          continue
        }
        const streak = (quietStreaks.get(key) ?? 0) + 1
        quietStreaks.set(key, streak)

        // Предупреждение о длительном бездействии воркера
        if (streak >= WORKER_AUTO_IDLE_QUIET_TICKS) {
          const assignedTask = taskStore.getAssignedTaskForWorker(workspace.id, agent.id)
          if (assignedTask) {
            taskStore.addLog(
              workspace.id,
              assignedTask.id,
              `[ВНИМАНИЕ] Воркер @${agent.name} не выводит данные в терминал более ${streak} мин. Проверьте статус выполнения.`
            )
          }
          continue
        }

        if (streak < WORKER_NUDGE_QUIET_TICKS) continue
        const last = lastNudgeAt.get(key) ?? 0
        const t = now()
        if (t - last < WORKER_NUDGE_COOLDOWN_MS) continue
        const assignedTask = taskStore.getAssignedTaskForWorker(workspace.id, agent.id)
        writeWorkerReportNudge(workspace.id, agent.id, nudgePayloadForTask(assignedTask))
        lastNudgeAt.set(key, t)

        if (assignedTask) {
          taskStore.addLog(
            workspace.id,
            assignedTask.id,
            `[НАПОМИНАНИЕ] Воркер @${agent.name} бездействует ${streak} мин. Отправлено напоминание о необходимости вызвать team report.`
          )
        }
      }

      // Проверяем задачи в assigned/running
      const activeTasks = taskStore.listTasks(workspace.id)
      for (const task of activeTasks) {
        if ((task.status === 'assigned' || task.status === 'running') && task.assignedAgentId) {
          const agentId = task.assignedAgentId
          const workerExists = snapshot.agents.some((a) => a.id === agentId)
          const isAgentActive = hasActiveRun ? hasActiveRun(workspace.id, agentId) : true

          // Если воркера вообще нет в воркспейсе или его runtime процесс мёртв.
          // Both `assigned` (claimed but the run never started) and `running`
          // (run disappeared) cards are requeued — otherwise a worker freed to
          // `idle` keeps a stuck card and its pendingTaskCount never drains.
          if (!workerExists || !isAgentActive) {
            console.log(
              `[WATCHDOG RECOVERY] Task #${task.id.slice(0, 8)} has no active runtime for @${agentId}. Releasing back to READY.`
            )
            taskStore.releaseTask(
              workspace.id,
              task.id,
              `Воркер @${agentId} не имеет активного процесса в runtime`
            )
            // releaseTask alone does not touch the per-worker pending counter.
            // Without this, queued counts from repeated deliveries keep growing
            // even though the card is requeued. Decrement only when the worker
            // still exists (a vanished worker has no counter to settle).
            if (workerExists) markTaskReported?.(workspace.id, agentId)
            await dispatchReadyTasks?.(workspace.id)
            continue
          }

          const lastTrigger = lastTaskRetriggerAt.get(task.id) ?? task.updatedAt
          // Guaranteed delivery first: a swallowed paste is retried with the
          // same dispatch id while the run is alive, so the worker actually
          // receives its task instead of idling until recovery tears it down.
          reinjectUndeliveredDispatch?.(workspace.id, agentId, UNDELIVERED_REINJECT_AFTER_MS)
          if (now() - lastTrigger >= TASK_RETRIGGER_COOLDOWN_MS) {
            const quiet = await isAgentQuiet(workspace.id, agentId)
            if (quiet) {
              writeWorkerReportNudge(workspace.id, agentId, nudgePayloadForTask(task))
              lastTaskRetriggerAt.set(task.id, now())
              const worker = snapshot.agents.find((a) => a.id === agentId)
              taskStore.addLog(
                workspace.id,
                task.id,
                `[ПОВТОРНЫЙ ТРИГГЕР] Отправлено напоминание воркеру @${worker?.name || agentId} (тихий > ${Math.round(TASK_RETRIGGER_COOLDOWN_MS / 60_000)} мин)`
              )
            }
          }
        }
      }
    }
    // Drop bookkeeping for agents no longer `working` so a later working
    // spell starts its quiet-streak count fresh.
    for (const key of quietStreaks.keys()) {
      if (!seen.has(key)) quietStreaks.delete(key)
    }
    for (const key of lastNudgeAt.keys()) {
      if (!seen.has(key)) lastNudgeAt.delete(key)
    }
    // Чистим retrigger-записи для завершённых задач
    for (const [taskId] of lastTaskRetriggerAt.entries()) {
      const task = taskStore.getTaskById(taskId)
      if (
        !task ||
        task.status === 'done' ||
        task.status === 'canceled' ||
        task.status === 'review'
      ) {
        lastTaskRetriggerAt.delete(taskId)
      }
    }
  }

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void tick().catch((error) =>
      console.error('[NUDGE] tick error:', error instanceof Error ? error.message : error)
    )
  }, intervalMs)
  timer.unref?.()

  return {
    stop: () => clearInterval(timer),
  }
}
