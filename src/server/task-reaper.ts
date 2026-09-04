import type { TaskRecord } from './task-store.js'

export interface TaskReaperPort {
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => { runId: string } | undefined
  getHeartbeat: (workspaceId: string, agentId: string) => { lastSeen: number } | undefined
  isHeartbeatStale: (workspaceId: string, agentId: string, maxAgeMs: number, now: number) => boolean
  listTasks: (workspaceId: string) => TaskRecord[]
  now?: () => number
  releaseTask: (workspaceId: string, taskId: string, reason: string) => void
}

/**
 * Window to wait after a `running` task's process disappears before reaping it.
 * The normal exit path (`runtime-supervisor.settleTask`) settles the task the
 * moment the PTY exits, so a brief settle grace avoids racing it. Much faster
 * than the recovery-watchdog's staleness-based requeue (minutes), so a dead
 * `running` task no longer blocks its worker or triggers a restart loop.
 */
export const REAP_DEAD_RUNNING_TASK_AFTER_MS = 30_000

/**
 * Reaps `running` tasks whose owner has no live process and no recent
 * heartbeat. Such a task is a genuine orphan: `running` is only reached after
 * the worker's process acked the dispatch (see worker-output-tracker), so the
 * process must have been alive — if it is gone now, the task can never finish
 * and must return to `ready` so the dispatcher re-routes it. Runs synchronously
 * and returns the number of tasks requeued.
 */
export const reapDeadRunningTasks = (workspaceId: string, port: TaskReaperPort): number => {
  const now = (port.now ?? Date.now)()
  let reaped = 0
  for (const task of port.listTasks(workspaceId)) {
    if (task.status !== 'running') continue
    const agentId = task.assignedAgentId
    if (!agentId) continue
    if (port.getActiveRunByAgentId(workspaceId, agentId)) continue
    const heartbeat = port.getHeartbeat(workspaceId, agentId)
    if (
      heartbeat &&
      !port.isHeartbeatStale(workspaceId, agentId, REAP_DEAD_RUNNING_TASK_AFTER_MS, now)
    ) {
      continue
    }
    port.releaseTask(
      workspaceId,
      task.id,
      `Worker @${agentId} has no live process for a running task (reaped)`
    )
    console.log(`[REAP] Task #${task.id.slice(0, 8)} returned to ready: owner has no live process`)
    reaped++
  }
  return reaped
}
