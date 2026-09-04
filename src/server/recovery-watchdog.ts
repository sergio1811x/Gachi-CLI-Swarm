import { createAgentSnapshot, persistAgentSnapshot } from './agent-handoff.js'
import type { AgentHeartbeatStore } from './agent-heartbeat-store.js'
import type { AgentLifecycleStore } from './agent-lifecycle-store.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { readAgentSessionSnapshot } from './agent-session-journal.js'
import { type TaskRecord, taskStore } from './task-store.js'
import type { WorkspaceStore } from './workspace-store.js'

/**
 * #10 Recovery watchdog.
 *
 * Every `intervalMs` scans each workspace for a stuck worker: an agent with an
 * active PTY run whose heartbeat `lastSeen` is older than `stuckAfterMs` while
 * still owning a task in `assigned`/`running`. On detection it runs the
 * roadmap's STUCK → snapshot → restart → restore flow:
 *
 *   1. snapshot  — session journal + handoff snapshot persisted to `.gachi/agents/<id>/handoffs/`
 *   2. stuck     — lifecycle transition working/ready → stuck
 *   3. restart   — stop the live run, then start a fresh one (session resume +
 *                  recovery summary injection happen inside the run starter)
 *   4. restore   — the restarted process receives handoff context from the journal
 *
 * A per-agent cooldown prevents restart loops for agents that are legitimately
 * silent for longer than the window.
 */
export const RECOVERY_WATCHDOG_INTERVAL_MS = 15_000
/** Staleness window used to detect a worker whose process is gone (requeue fast). */
export const STUCK_HEARTBEAT_AFTER_MS = 120_000
/**
 * Staleness window used when the process is still ALIVE. Agent work (LLM
 * thinking, long tool runs) can be legitimately silent for minutes, and killing
 * an alive-but-quiet worker loses its context and starts a restart loop. This
 * must be much more generous than the dead-process window and aligned with the
 * worker-report-nudge's quiet tolerance (which gently reminds before we kill).
 */
export const STUCK_ALIVE_HEARTBEAT_AFTER_MS = 15 * 60_000
export const RESTART_COOLDOWN_MS = 5 * 60_000
/**
 * Idle window for a worker whose process is alive and still keeping its
 * heartbeat fresh, but has produced NO PTY output. This is the classic
 * "finished the task but never exited" hang: staleness-based recovery can never
 * catch it because the heartbeat keeps getting refreshed. On detection the run
 * is stopped and the owned task requeued so the dispatcher re-routes it.
 */
export const IDLE_STUCK_AFTER_MS = 5 * 60_000
/**
 * A task is re-dispatched to a (possibly the same, broken) worker on every
 * recovery release. Without a cap, a worker whose engine accepts input but
 * never executes/reports spins the release -> ready -> re-dispatch loop
 * forever (~every `IDLE_STUCK_AFTER_MS`). After this many claims we give up
 * on that attempt chain: the task is marked `failed` so the dispatcher stops
 * re-routing it, and the worker's lifecycle is failed so it stops being poked.
 */
export const MAX_RETRY_ATTEMPTS = 3

export interface RecoveryWatchdog {
  stop: () => void
}

export interface RecoveryWatchdogEventPayload {
  agentId: string
  reason: string
  runId: string | null
  taskId?: string | null
  taskStatus?: string | null
}

interface RecoveryWatchdogDeps {
  agentHeartbeatStore: AgentHeartbeatStore
  agentLifecycleStore: AgentLifecycleStore
  agentRuntime: Pick<AgentRuntime, 'getActiveRunByAgentId'>
  /** Emits an AGENT_STUCK / AGENT_RECOVERED runtime event when set. */
  emitEvent?: (
    workspaceId: string,
    type: 'AGENT_STUCK' | 'AGENT_RECOVERED',
    payload: Record<string, unknown>
  ) => void
  /** Requeues a task back to READY/FAILED when the owning worker died. */
  releaseTask?: (
    workspaceId: string,
    taskId: string,
    reason: string,
    options?: { permanent?: boolean }
  ) => void
  /**
   * Decrements a worker's pending-task count after one of its tasks is released
   * by recovery. Without this the worker stays `working` (pending leaked),
   * which makes the orchestrator keep dispatching to an agent that is actually
   * down/idle. Wired to the workspace store's markTaskReported.
   */
  markTaskReleased?: (workspaceId: string, agentId: string) => void
  /** Called after requeue so the dispatcher can immediately pick a replacement. */
  dispatchReadyTasks?: (workspaceId: string) => Promise<void>
  /** Last PTY-output timestamp for an agent (from WorkerOutputTracker), if any. */
  getLastPtyActivityAt?: (workspaceId: string, agentId: string) => number | null
  /**
   * Timestamp of the last SPONTANEOUS output (excluding prompted replies to
   * injected nudges/heartbeats). When present this drives idle detection so a
   * zombie that only answers system prompts is still caught.
   */
  getLastSpontaneousActivityAt?: (workspaceId: string, agentId: string) => number | null
  getWorkspacePath: (workspaceId: string) => string
  intervalMs?: number
  listWorkspaces: () => Array<{ id: string }>
  now?: () => number
  restartCooldownMs?: number
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { gachiPort: string }
  ) => Promise<{ runId: string; status: string; exitCode: number | null }>
  stopAgentRun: (runId: string) => Promise<void>
  /** Staleness window for dead-process detection. */
  stuckAfterMs?: number
  /** Staleness window for alive-but-quiet processes (defaults to 15 minutes). */
  aliveStuckAfterMs?: number
  /** PTY-idle window for a heartbeating-but-silent worker (defaults to 5 minutes). */
  idleStuckAfterMs?: number
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
}

const isActiveTask = (status: string | undefined) => status === 'assigned' || status === 'running'

export const createRecoveryWatchdog = ({
  agentHeartbeatStore,
  agentLifecycleStore,
  agentRuntime,
  dispatchReadyTasks,
  emitEvent,
  getLastPtyActivityAt,
  getLastSpontaneousActivityAt,
  getWorkspacePath,
  idleStuckAfterMs = IDLE_STUCK_AFTER_MS,
  intervalMs = RECOVERY_WATCHDOG_INTERVAL_MS,
  listWorkspaces,
  markTaskReleased,
  now = Date.now,
  releaseTask,
  restartCooldownMs = RESTART_COOLDOWN_MS,
  startAgent,
  stopAgentRun,
  stuckAfterMs = STUCK_HEARTBEAT_AFTER_MS,
  aliveStuckAfterMs = STUCK_ALIVE_HEARTBEAT_AFTER_MS,
  workspaceStore,
}: RecoveryWatchdogDeps): RecoveryWatchdog => {
  const lastRestartAt = new Map<string, number>()
  const lastHealth = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | undefined

  const getAssignedTask = (workspaceId: string, agentId: string) =>
    taskStore.getAssignedTaskForWorker(workspaceId, agentId) ??
    taskStore.getAssignedTaskForWorker(workspaceId, agentId.replace(/^.+:/u, ''))

  /**
   * Releases a task owned by a stuck worker. Applies the retry cap (a task that
   * keeps bouncing off the same broken worker is failed instead of re-queued,
   * which is what breaks the infinite release -> ready -> re-dispatch loop) and
   * decrements the worker's pending count so it is no longer reported as
   * `working`. Returns true when the task was permanently failed (do NOT
   * re-dispatch), false when it was released back to `ready`.
   */
  const settleStuckTask = async (
    workspaceId: string,
    agentId: string,
    task: TaskRecord,
    reason: string
  ): Promise<boolean> => {
    const permanent = (task.attempts ?? 0) >= MAX_RETRY_ATTEMPTS
    releaseTask?.(workspaceId, task.id, reason, permanent ? { permanent: true } : undefined)
    markTaskReleased?.(workspaceId, agentId)
    if (permanent) {
      try {
        agentLifecycleStore.transition(workspaceId, agentId, 'failed', {
          error: `Task "${task.title}" failed after ${task.attempts} attempts; worker is likely broken`,
          reason: 'recovery_watchdog_max_retries',
          runId: null,
        })
      } catch {
        // Best-effort quarantine; failing the task still proceeds.
      }
      reportHealth(
        workspaceId,
        agentId,
        'FAILED',
        `task "#${task.id.slice(0, 8)}" failed after ${task.attempts ?? 0} attempts (quarantined)`
      )
    }
    return permanent
  }

  const reportHealth = (workspaceId: string, agentId: string, status: string, detail: string) => {
    const key = `${workspaceId}:${agentId}`
    if (lastHealth.get(key) === status) return
    lastHealth.set(key, status)
    console.log(`[RECOVERY] @${agentId} status=${status}: ${detail}`)
  }

  const recoverAgent = async (workspaceId: string, agentId: string) => {
    const activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    // A user-paused run is intentionally silent: the OS process is suspended,
    // so "no PTY output" and a stale heartbeat are EXPECTED, not a hang. Any
    // recovery action here would kill exactly the worker the user froze.
    if (activeRun?.paused) {
      reportHealth(workspaceId, agentId, 'PAUSED', 'run suspended by user — skipping recovery')
      return
    }
    const assignedTask = getAssignedTask(workspaceId, agentId)
    if (!assignedTask || !isActiveTask(assignedTask.status)) {
      reportHealth(workspaceId, agentId, 'IDLE', 'no in-flight task')
      return
    }
    const heartbeat = agentHeartbeatStore.get(workspaceId, agentId)
    const hasFreshHeartbeat =
      heartbeat && !agentHeartbeatStore.isStale(workspaceId, agentId, stuckAfterMs, now())
    // When the process is still alive we use a much more generous window so a
    // legitimately quiet (working) agent is not killed and lost its context.
    const aliveFresh =
      heartbeat && !agentHeartbeatStore.isStale(workspaceId, agentId, aliveStuckAfterMs, now())

    // Scenario C — dead worker: task is owned but there is no live PTY process.
    // Requeue the task (failed lifecycle) so a replacement worker picks it up.
    // `claimed` still counts as "starting soon"; the claim-timeout nudge owns that.
    if (!activeRun) {
      if (hasFreshHeartbeat) {
        // Scenario A — agent is alive (e.g. between claim and spawn): keep running.
        reportHealth(workspaceId, agentId, 'HEALTHY', 'no live process yet, heartbeat fresh')
        return
      }
      if (!releaseTask) return
      reportHealth(
        workspaceId,
        agentId,
        'DEAD',
        `owns task "#${assignedTask.id.slice(0, 8)}" but has no live process`
      )
      try {
        agentLifecycleStore.transition(workspaceId, agentId, 'failed', {
          error: `Process died while task "${assignedTask.title}" was ${assignedTask.status}`,
          reason: 'recovery_watchdog_worker_dead',
          runId: null,
        })
      } catch {
        // Best-effort: requeue still proceeds even if the lifecycle record is missing.
      }
      const permanent = await settleStuckTask(
        workspaceId,
        agentId,
        assignedTask,
        `Worker @${agentId} died with no active process`
      )
      if (!permanent) await dispatchReadyTasks?.(workspaceId)
      return
    }

    if (activeRun.status !== 'starting' && activeRun.status !== 'running') {
      reportHealth(workspaceId, agentId, 'IDLE', 'run not starting/running')
      return
    }

    if (!heartbeat) return

    // Scenario D — heartbeating zombie: the process is alive and keeps the
    // heartbeat fresh, but has produced NO PTY output for `idleStuckAfterMs`.
    // This is the classic "finished the task but never exited" hang that
    // staleness-based recovery can never catch (the heartbeat never goes
    // stale). Stop the run and requeue the task so the dispatcher re-routes it.
    const spontaneousActivity = getLastSpontaneousActivityAt ?? getLastPtyActivityAt
    const lastPtyActivity = spontaneousActivity?.(workspaceId, agentId) ?? now()
    if (aliveFresh && now() - lastPtyActivity >= idleStuckAfterMs && releaseTask) {
      reportHealth(
        workspaceId,
        agentId,
        'STUCK',
        `alive but no PTY output for ${idleStuckAfterMs}ms while task "#${assignedTask.id.slice(0, 8)}" is ${assignedTask.status}`
      )

      const restartKey = `${workspaceId}:${agentId}`
      const lastRestart = lastRestartAt.get(restartKey)
      if (lastRestart !== undefined && now() - lastRestart < restartCooldownMs) return
      lastRestartAt.set(restartKey, now())

      try {
        const snapshot = createAgentSnapshot(
          readAgentSessionSnapshot(getWorkspacePath(workspaceId), agentId)
        )
        persistAgentSnapshot(getWorkspacePath(workspaceId), snapshot)
      } catch {
        // Snapshot is best-effort; release still proceeds.
      }

      try {
        const lifecycle = agentLifecycleStore.get(workspaceId, agentId)
        if (lifecycle && (lifecycle.state === 'working' || lifecycle.state === 'ready')) {
          agentLifecycleStore.transition(workspaceId, agentId, 'stuck', {
            error: `Alive but idle (no PTY output) for ${idleStuckAfterMs}ms while task "${assignedTask.title}" is ${assignedTask.status}`,
            reason: 'recovery_watchdog_idle',
            runId: activeRun.runId,
          })
          emitEvent?.(workspaceId, 'AGENT_STUCK', {
            agentId,
            reason: 'idle',
            runId: activeRun.runId,
            taskId: assignedTask.id,
            taskStatus: assignedTask.status,
          })
        }
      } catch {
        // The transition is best-effort; release still proceeds.
      }

      try {
        await stopAgentRun(activeRun.runId)
      } catch {
        // Ignore stop failures; the task is still requeued below.
      }
      const permanent = await settleStuckTask(
        workspaceId,
        agentId,
        assignedTask,
        `Worker @${agentId} idle after completing its task`
      )
      if (!permanent) {
        emitEvent?.(workspaceId, 'AGENT_RECOVERED', {
          agentId,
          reason: 'stopped_after_idle',
          runId: null,
          taskId: assignedTask.id,
          taskStatus: assignedTask.status,
        })
        await dispatchReadyTasks?.(workspaceId)
      }
      return
    }

    // Scenario A — process alive with a fresh (alive-window) heartbeat: nothing to do.
    if (aliveFresh) {
      reportHealth(workspaceId, agentId, 'HEALTHY', 'process alive, heartbeat fresh')
      return
    }

    // Scenario B — process alive but heartbeat stale: stuck → snapshot → restart.
    reportHealth(
      workspaceId,
      agentId,
      'STUCK',
      `heartbeat stale for ${stuckAfterMs}ms while task "#${assignedTask.id.slice(0, 8)}" is ${assignedTask.status}`
    )

    const restartKey = `${workspaceId}:${agentId}`
    const lastRestart = lastRestartAt.get(restartKey)
    if (lastRestart !== undefined && now() - lastRestart < restartCooldownMs) return
    lastRestartAt.set(restartKey, now())

    // 1. snapshot — persist handoff state from the session journal.
    try {
      const snapshot = createAgentSnapshot(
        readAgentSessionSnapshot(getWorkspacePath(workspaceId), agentId)
      )
      persistAgentSnapshot(getWorkspacePath(workspaceId), snapshot)
    } catch {
      // Snapshot is best-effort; restart still proceeds with the recovery summary.
    }

    // 2. stuck — record the detection as a lifecycle state.
    try {
      const lifecycle = agentLifecycleStore.get(workspaceId, agentId)
      if (lifecycle && (lifecycle.state === 'working' || lifecycle.state === 'ready')) {
        agentLifecycleStore.transition(workspaceId, agentId, 'stuck', {
          error: `Heartbeat stale for ${stuckAfterMs}ms while task "${assignedTask.title}" is ${assignedTask.status}`,
          reason: 'recovery_watchdog_stuck',
          runId: activeRun.runId,
        })
        emitEvent?.(workspaceId, 'AGENT_STUCK', {
          agentId,
          reason: 'heartbeat_stale',
          runId: activeRun.runId,
          taskId: assignedTask.id,
          taskStatus: assignedTask.status,
        })
      }
    } catch {
      // The transition is best-effort; if it races with another lifecycle change we still restart.
    }

    // 3. restart — stop the live run, then start a fresh one (session resume +
    //    recovery summary injection happen inside the run starter).
    const failedRunId = activeRun.runId
    try {
      await stopAgentRun(failedRunId)
    } catch {
      // Ignore stop failures; startAgent below may still spawn a replacement.
    }
    try {
      await startAgent(workspaceId, agentId, { gachiPort: '' })
      emitEvent?.(workspaceId, 'AGENT_RECOVERED', {
        agentId,
        reason: 'restarted_after_stuck',
        runId: null,
        taskId: assignedTask.id,
        taskStatus: assignedTask.status,
      })
    } catch (error) {
      console.error(
        `[RECOVERY] Failed to restart stuck agent ${agentId}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  const tick = () => {
    for (const workspace of listWorkspaces()) {
      let record: Awaited<ReturnType<WorkspaceStore['getWorkspaceSnapshot']>>
      try {
        record = workspaceStore.getWorkspaceSnapshot(workspace.id)
      } catch {
        continue
      }
      for (const agent of record.agents) {
        // The orchestrator is included too: it can hang in `working` while it
        // owns a task (e.g. a coordination dispatch it never closes). If it has
        // no in-flight task, recoverAgent is a no-op. Only a genuinely stuck
        // orchestrator (spontaneous-idle or dead process) is stopped/restarted.
        void recoverAgent(workspace.id, agent.id).catch((error) =>
          console.error(
            `[RECOVERY] recoverAgent failed for ${agent.id}:`,
            error instanceof Error ? error.message : error
          )
        )
      }
    }
  }

  timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()

  return {
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
