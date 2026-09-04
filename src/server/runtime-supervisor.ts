import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentHeartbeatStore } from './agent-heartbeat-store.js'
import type { AgentLifecycleStore } from './agent-lifecycle-store.js'
import type { AgentRun } from './agent-run-model.js'
import { createAgentRunModel } from './agent-run-model.js'
import type { AgentRunRecordStore } from './agent-run-record-store.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { detectDangerousOps } from './dangerous-ops.js'
import { runDeployHook } from './deploy-hook.js'
import {
  type ClassifiedFailure,
  classifyFailure,
  isSuccessExit,
  tailOf,
} from './failure-classifier.js'
import { describeBackoff, retryBackoffMs } from './failure-policy.js'
import { getWindowsProcessIdentity, isPidAlive, killTree } from './process-tree-kill.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import type { TaskRecord } from './task-store.js'
import type { RuntimeEventPayload } from './tasks-websocket-server.js'
import { mergeWorktreeToMain } from './worktree-manager.js'

export type RunExitReason =
  | 'success'
  | 'error'
  | 'crash'
  | 'timeout'
  | 'manual_stop'
  | 'recovery'
  | 'superseded'
  | 'process_dead_after_restart'

export type AgentHealthStatus = 'HEALTHY' | 'SUSPECTED' | 'STUCK' | 'DEAD' | 'NOT_RUNNING'

export interface AgentHealthResult {
  status: AgentHealthStatus
  agentId: string
  workspaceId: string
  runId: string | null
  lastHeartbeat: number | null
  lastOutput: string
  lifecycleState: string | null
}

export interface ReconcileSummary {
  restored: number
  failed: number
  stale: number
}

export interface ReleaseAgentRunInput {
  exitCode: number | null
  endedAt: number
  reason: RunExitReason
  error?: string | null
}

export interface RuntimeSupervisor {
  /** Starts (or reuses) an agent run and returns the unified model view. */
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: { gachiPort: string }
  ) => Promise<AgentRun>
  stopAgent: (runId: string) => void
  waitForAgentRunExit: (runId: string) => Promise<void>
  bindTask: (runId: string, taskId: string) => void
  getAgentRun: (workspaceId: string, agentId: string) => AgentRun | undefined
  getRun: (runId: string) => AgentRun | undefined
  listActiveRuns: () => AgentRun[]
  getOutputBus: () => PtyOutputBus
  /** Called by the runtime when a run is fully started. */
  handleRunStarted: (
    runId: string,
    agentId: string,
    workspaceId: string,
    startedAt: number,
    pid: number | null
  ) => void
  /** Called by the runtime when a run has exited. */
  handleRunExited: (
    runId: string,
    agentId: string,
    workspaceId: string,
    exitCode: number | null,
    endedAt: number
  ) => void
  /**
   * Single exit pipeline: stops a still-live process, completes the run record,
   * releases the agent (lifecycle + heartbeat + events) and settles the owned
   * task (review on clean exit, requeue otherwise), then triggers the dispatcher.
   */
  releaseAgentRun: (runId: string, input: ReleaseAgentRunInput) => void
  /** Non-blocking health classification for a worker. */
  healthCheck: (workspaceId: string, agentId: string) => AgentHealthResult
  /**
   * Halves the workspace's consecutive-failure streak (breaker auto-resume
   * after a cooldown): repeated breaches re-trip sooner than a fresh streak,
   * keeping the cooldown ladder meaningful.
   */
  softenErrorBudget: (workspaceId: string) => void
  /** Startup recovery: restore live runs, fail stale ones, requeue owned tasks. */
  reconcile: () => ReconcileSummary
  getRunHistory: (limit?: number) => AgentRun[]
  close: () => void
}

export interface RuntimeSupervisorDeps {
  agentRuntime: AgentRuntime
  agentHeartbeatStore: AgentHeartbeatStore
  agentLifecycleStore: AgentLifecycleStore
  recordStore?: AgentRunRecordStore
  taskStorePort?: {
    getAssignedTaskForWorker: (
      workspaceId: string,
      workerIdOrName: string
    ) => TaskRecord | undefined
    getTask: (workspaceId: string, taskId: string) => TaskRecord | undefined
    addTaskLog?: (workspaceId: string, taskId: string, message: string) => void
    releaseTask: (workspaceId: string, taskId: string, reason: string) => void
    updateTask: (
      workspaceId: string,
      taskId: string,
      updates:
        | { status: 'review'; finishedAt: number }
        | { status: 'ready'; nextRetryAt?: number; lastFailureCategory?: string }
    ) => void
    /** R4.1: true when an open follow-up issue card already exists for this task. */
    hasOpenChildIssue?: (workspaceId: string, taskId: string) => boolean
    /** R4.1: creates the follow-up issue card linked to the failing task. */
    createIssueCard?: (
      workspaceId: string,
      input: { parentTaskId: string; title: string; description: string }
    ) => { id: string } | undefined
  }
  workspaceStorePort?: {
    getAgent: (workspaceId: string, agentId: string) => AgentSummary | undefined
    hasAgent: (workspaceId: string, agentId: string) => boolean
    markAgentStopped: (workspaceId: string, agentId: string) => void
  }
  /** Workspace path for worktree merge-back. */
  workspaceStorePath?: (workspaceId: string) => string | null
  /**
   * Auto-PR after merge (opt-in per workspace): when enabled and the worker's
   * changes were merged, publish the branch via `gh` and journal the PR URL.
   */
  autoPr?: {
    isEnabled: (workspaceId: string) => boolean
    publishBranch: (
      workspaceId: string,
      agentId: string
    ) => { url: string; number: number | null } | { error: string }
  }
  /**
   * R4 deploy hooks (opt-in per workspace): a shell command executed after the
   * worker's changes were merged back into main. Failures journal but never
   * break the release pipeline.
   */
  deployHook?: {
    getCommand: (workspaceId: string) => string | null
    execute?: typeof runDeployHook
  }
  /**
   * R3.3: benches a worker whose CLI is missing/unauthenticated — clears the
   * launch config so the dispatcher stops selecting it until a human fixes
   * the environment and re-configures the engine.
   */
  disableWorker?: (workspaceId: string, agentId: string, reason: string) => void
  /**
   * R10 error budget: called once when a workspace accumulates
   * `ERROR_BUDGET_THRESHOLD` consecutive failed runs. The handler pauses
   * dispatch and notifies; a success resets the streak.
   */
  onErrorBudgetExceeded?: (workspaceId: string, threshold: number) => void
  /**
   * Called when a clean run resets a non-zero failure streak: the breaker
   * closes fully (cooldown deadline and escalation stage are cleared).
   */
  onBreakerRecovered?: (workspaceId: string) => void
  /**
   * Cancels the agent's open (queued/submitted) ledger rows. Called on run
   * release when the owned task is requeued — a leaked `submitted` row would
   * otherwise resurrect a duplicate card on every board reconcile.
   */
  cancelOpenDispatches?: (workspaceId: string, agentId: string, reason: string) => void
  emitEvent?: (workspaceId: string, event: Omit<RuntimeEventPayload, 'updatedAt'>) => void
  dispatchReadyTasks?: (workspaceId: string) => Promise<void>
  /**
   * Этап 5 crash auto-restart (opt-in per workspace): isEnabled reads the
   * workspace's app-state flag; start relaunches the worker with its
   * persisted launch config.
   */
  autoRestart?: {
    isEnabled: (workspaceId: string) => boolean
    start: (workspaceId: string, agentId: string) => Promise<unknown>
  }
  /** Restart ladder override (tests / tuning); defaults to 1m/5m/15m. */
  restartBackoffMs?: number[]
  healthyHeartbeatMaxAgeMs?: number
  stuckHeartbeatMaxAgeMs?: number
}

export const HEALTHY_HEARTBEAT_MAX_AGE_MS = 30_000
export const STUCK_HEARTBEAT_MAX_AGE_MS = 90_000

/** R10: consecutive failed runs per workspace before dispatch pauses. */
export const ERROR_BUDGET_THRESHOLD = 5

/**
 * Этап 5: crash auto-restart ladder (opt-in per workspace via the wiring's
 * app-state flag). Three relaunch attempts with growing delays; a clean exit
 * resets the streak and a manual stop never resurrects the worker.
 */
export const WORKER_RESTART_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]
export const WORKER_RESTART_MAX_ATTEMPTS = WORKER_RESTART_BACKOFF_MS.length

/**
 * `releasedRuns` exists only to make run-exit handling idempotent for RECENT
 * exits; without a cap it grows forever in long-lived processes. Insertion
 * order of the Set gives cheap FIFO eviction.
 */
const RELEASED_RUNS_CAP = 1000

const isActiveRuntimeState = (state: AgentRun['runtimeState']) =>
  state === 'starting' || state === 'running'

const isFailureReason = (reason: RunExitReason) =>
  reason === 'crash' ||
  reason === 'error' ||
  reason === 'timeout' ||
  reason === 'recovery' ||
  reason === 'superseded' ||
  reason === 'process_dead_after_restart'

export const createRuntimeSupervisor = (deps: RuntimeSupervisorDeps): RuntimeSupervisor => {
  const model = createAgentRunModel(deps.recordStore ? { recordStore: deps.recordStore } : {})
  const outputUnsubscribers = new Map<string, () => void>()
  const releasedRuns = new Set<string>()
  /** R10: consecutive failed runs per workspace (success resets). */
  const errorBudgetStreaks = new Map<string, number>()
  /** Этап 5: per-worker crash streak and pending auto-restart timers. */
  const crashStreaks = new Map<string, number>()
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Cards orphaned by a superseded exit: the exiting run owned `taskId`, but
   * the replacement run had not bound it yet (a handoff delivery lands only
   * after `handleRunStarted`). Keyed by the replacement's run id; the entry
   * settles when the replacement binds a different task or exits without
   * ever binding the orphaned card.
   */
  const orphanedTasksByReplacement = new Map<
    string,
    {
      agentId: string
      endedAt: number
      exitCode: number | null
      reason: RunExitReason
      taskId: string
      workspaceId: string
    }
  >()

  const refresh = (run: AgentRun): AgentRun => {
    const lifecycle = deps.agentLifecycleStore.get(run.workspaceId, run.agentId)
    const heartbeat = deps.agentHeartbeatStore.get(run.workspaceId, run.agentId)
    const active = deps.agentRuntime.getActiveRunByAgentId(run.workspaceId, run.agentId)
    const liveOwnsRun = active && active.runId === run.id
    return {
      ...run,
      pid: liveOwnsRun ? (active.pid ?? run.pid) : run.pid,
      runtimeState: liveOwnsRun ? active.status : run.runtimeState,
      lifecycleState: lifecycle?.state ?? run.lifecycleState,
      lastHeartbeat: heartbeat?.lastSeen ?? run.lastHeartbeat,
    }
  }

  const unsubscribeOutput = (runId: string) => {
    const unsubscribe = outputUnsubscribers.get(runId)
    if (unsubscribe) {
      unsubscribe()
      outputUnsubscribers.delete(runId)
    }
  }

  /**
   * Wall-clock moment this supervisor instance was created. A process created
   * after this point cannot be an orphan from the previous session.
   */
  const supervisorBootedAt = Date.now()

  /** Tolerance for comparing a persisted run's start time to a pid's creation. */
  const PID_REUSE_WINDOW_MS = 2 * 60_000

  /**
   * Startup orphan reaper: a persisted run without a live registry entry may
   * still own a living OS process from the previous daemon session (Windows
   * ConPTY survives pty.kill()). Kill the tree so it cannot keep "working"
   * with no task and no supervision.
   *
   * PID-reuse guard (production: flow2api's python was killed by a boot sweep
   * because Windows had recycled the persisted pid): on Windows the process
   * creation time must fall inside the run's lifetime — created no earlier
   * than the run start (minus tolerance) and no later than this daemon's
   * boot. Anything else is a recycled pid and must NOT be touched.
   */
  const reapOrphanProcess = (
    pid: number | null | undefined,
    why: string,
    startedAt?: number | null
  ): void => {
    void (async () => {
      if (!pid || !isPidAlive(pid)) return
      if (process.platform === 'win32') {
        const identity = await getWindowsProcessIdentity(pid)
        if (!identity) return // Process vanished between the liveness check and the query.
        const lowerBound = startedAt ? startedAt - PID_REUSE_WINDOW_MS : 0
        const reused = identity.creationMs > supervisorBootedAt || identity.creationMs < lowerBound
        if (reused) {
          console.warn(
            `[RECOVERY] PID ${pid} (${why}) NOT killed — PID reuse suspected (created ${new Date(identity.creationMs).toISOString()}, run started ${startedAt ? new Date(startedAt).toISOString() : 'unknown'}, cmdline: ${identity.commandLine?.slice(0, 160) ?? 'unknown'})`
          )
          return
        }
        console.warn(
          `[RECOVERY] orphaned PID ${pid} (${why}) — killing process tree (created ${new Date(identity.creationMs).toISOString()}, cmdline: ${identity.commandLine?.slice(0, 160) ?? 'unknown'})`
        )
      } else {
        console.warn(`[RECOVERY] orphaned PID ${pid} (${why}) — killing process tree`)
      }
      await killTree(pid)
    })()
  }

  const releaseAgent = (run: AgentRun, input: { reason: RunExitReason; error: string | null }) => {
    const { workspaceId, agentId } = run
    if (!deps.workspaceStorePort?.hasAgent(workspaceId, agentId)) return
    const lifecycle = deps.agentLifecycleStore.get(workspaceId, agentId)
    const target = isFailureReason(input.reason) ? 'failed' : 'stopped'
    if (lifecycle && lifecycle.state !== 'stopped' && lifecycle.state !== 'failed') {
      try {
        deps.agentLifecycleStore.transition(workspaceId, agentId, target, {
          error: input.error,
          reason: input.reason,
          runId: run.id,
        })
      } catch {
        // Lifecycle already reached a terminal state; release proceeds anyway.
      }
    }
    deps.workspaceStorePort.markAgentStopped(workspaceId, agentId)
    deps.agentHeartbeatStore.record(workspaceId, agentId, {
      status: target,
      phase: 'process_exited',
    })
    const agent = deps.workspaceStorePort.getAgent(workspaceId, agentId)
    deps.emitEvent?.(workspaceId, {
      type: 'AGENT_STATUS_CHANGED',
      entityVersion: Date.now(),
      payload: {
        agentId,
        name: agent?.name ?? agentId,
        role: agent?.role ?? 'custom',
        status: 'stopped',
      },
    })
  }

  const settleOwnedTask = (
    workspaceId: string,
    agentId: string,
    taskId: string | undefined,
    input: { exitCode: number | null; endedAt: number; reason: RunExitReason }
  ) => {
    if (!deps.taskStorePort) return
    const task = taskId
      ? deps.taskStorePort.getTask(workspaceId, taskId)
      : deps.taskStorePort.getAssignedTaskForWorker(workspaceId, agentId)
    if (!task) return
    const inFlight =
      task.status === 'running' || task.status === 'assigned' || task.status === 'claimed'
    if (!inFlight) return
    if (input.reason === 'success') {
      deps.taskStorePort.updateTask(task.workspaceId, task.id, {
        status: 'review',
        finishedAt: input.endedAt,
      })
      console.log(`[RUN EXIT] Task #${task.id.slice(0, 8)} moved to review (worker exited cleanly)`)
    } else {
      deps.taskStorePort.releaseTask(
        task.workspaceId,
        task.id,
        `Worker @${agentId} exited with code ${String(input.exitCode)} (${input.reason})`
      )
      console.log(
        `[REQUEUE] Task #${task.id.slice(0, 8)} returned to ready (worker exited: ${input.reason})`
      )
    }
  }

  const settleTask = (
    run: AgentRun,
    input: { exitCode: number | null; endedAt: number; reason: RunExitReason }
  ) => {
    settleOwnedTask(run.workspaceId, run.agentId, run.taskId ?? undefined, input)
  }

  /**
   * Этап 5: crash auto-restart. A crashed worker is relaunched on the
   * 1m/5m/15m ladder (max 3 attempts) when the workspace opted in. A clean
   * exit resets the streak; any other exit reason cancels a pending restart
   * instead of resurrecting a worker the operator stopped or superseded.
   */
  const scheduleCrashRestart = (run: AgentRun, reason: RunExitReason) => {
    const key = `${run.workspaceId}:${run.agentId}`
    const pending = restartTimers.get(key)
    if (pending) {
      clearTimeout(pending)
      restartTimers.delete(key)
    }
    if (reason === 'success') {
      crashStreaks.delete(key)
      return
    }
    if (reason !== 'crash') return
    if (!deps.autoRestart?.isEnabled(run.workspaceId)) return
    const attempts = (crashStreaks.get(key) ?? 0) + 1
    if (attempts > WORKER_RESTART_MAX_ATTEMPTS) {
      console.log(
        `[AUTO-RESTART] @${run.agentId} exceeded ${WORKER_RESTART_MAX_ATTEMPTS} restarts — staying down until a manual start`
      )
      crashStreaks.delete(key)
      return
    }
    crashStreaks.set(key, attempts)
    const backoff = deps.restartBackoffMs ?? WORKER_RESTART_BACKOFF_MS
    const delay = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 60_000
    console.log(
      `[AUTO-RESTART] @${run.agentId} crashed — restart ${attempts}/${WORKER_RESTART_MAX_ATTEMPTS} in ${describeBackoff(delay)}`
    )
    const timer = setTimeout(() => {
      restartTimers.delete(key)
      const autoRestart = deps.autoRestart
      if (!autoRestart) return
      void Promise.resolve()
        .then(() => autoRestart.start(run.workspaceId, run.agentId))
        .then(() => {
          console.log(`[AUTO-RESTART] @${run.agentId} relaunched`)
        })
        .catch((restartError: unknown) => {
          console.error('[AUTO-RESTART] relaunch failed:', restartError)
        })
    }, delay)
    timer.unref?.()
    restartTimers.set(key, timer)
  }

  const releaseAgentRun = (runId: string, input: ReleaseAgentRunInput) => {
    const run = model.get(runId)
    if (!run) return
    if (releasedRuns.has(runId)) return
    releasedRuns.add(runId)
    while (releasedRuns.size > RELEASED_RUNS_CAP) {
      const oldest = releasedRuns.values().next().value
      if (oldest === undefined) break
      releasedRuns.delete(oldest)
    }

    const { agentId, workspaceId } = run
    const rawError = input.error ?? null

    // Classify WHY the run failed (orchestrator feedback #2): the category
    // flows into lifecycle lastError (team list) and the task journal, so a
    // 429/OOM/auth failure is triageable without opening terminals.
    let failure: ClassifiedFailure | null = null
    if (!isSuccessExit(input.reason)) {
      let outputTail = ''
      try {
        outputTail = tailOf(deps.agentRuntime.getLiveRun?.(runId)?.output)
      } catch {
        // Live record may already be gone — classification falls back to the
        // recorded error only.
      }
      failure = classifyFailure(outputTail, input.exitCode, rawError)
    }
    const error = failure && !rawError ? `[${failure.category}] ${failure.detail}` : rawError

    // R10 error budget: a success resets the workspace streak; crossing the
    // threshold pauses dispatch via the injected handler. Daemon-restart
    // releases (`process_dead_after_restart` from boot reconcile, `superseded`
    // from engine switches) are infrastructure damage, not worker misbehavior
    // — they must neither punish nor reward the streak (production incident:
    // a supervisor restart-loop re-paused dispatch every cycle).
    if (workspaceId) {
      const previous = errorBudgetStreaks.get(workspaceId) ?? 0
      const infrastructureRelease =
        input.reason === 'process_dead_after_restart' ||
        input.reason === 'superseded' ||
        input.reason === 'manual_stop'
      const streak = infrastructureRelease ? previous : failure === null ? 0 : previous + 1
      errorBudgetStreaks.set(workspaceId, streak)
      if (failure === null && previous > 0) deps.onBreakerRecovered?.(workspaceId)
      // Fire on the crossing only: an already-paused workspace must not
      // re-notify on every further failure (test contract: fires once).
      if (
        previous < ERROR_BUDGET_THRESHOLD &&
        streak >= ERROR_BUDGET_THRESHOLD &&
        deps.onErrorBudgetExceeded
      ) {
        console.warn(
          `[ERROR BUDGET] ws ${workspaceId.slice(0, 8)}: ${streak} consecutive failures — pausing dispatch`
        )
        deps.onErrorBudgetExceeded(workspaceId, ERROR_BUDGET_THRESHOLD)
      }
    }

    // R10 risk observability: journal risky commands the run actually ran.
    // Detection is narrow by design — this informs the human, never blocks.
    if (deps.taskStorePort?.addTaskLog) {
      let runOutput = ''
      try {
        runOutput = deps.agentRuntime.getLiveRun?.(runId)?.output ?? ''
      } catch {}
      const risks = detectDangerousOps(runOutput)
      if (risks.length > 0) {
        try {
          const riskTask = deps.taskStorePort.getAssignedTaskForWorker(workspaceId, agentId)
          if (riskTask) {
            deps.taskStorePort.addTaskLog(workspaceId, riskTask.id, `[RISK] ${risks.join(', ')}`)
            console.warn(`[RISK] ${risks.join(', ')} in run ${runId.slice(0, 8)} @${agentId}`)
          }
        } catch {}
      }
    }

    // Legacy run rows may lack a workspace mapping (pre-schema-v23). Complete
    // the record so it is not left active, but there is nothing to free,
    // settle or dispatch without a workspace.
    if (!workspaceId) {
      model.complete(runId, input.exitCode, input.endedAt)
      model.updateError(runId, error)
      unsubscribeOutput(runId)
      console.log(
        `[RUN EXIT] run=${runId.slice(0, 8)} @${agentId} reason=${input.reason} (no workspace mapping)`
      )
      return
    }

    // 1. Stop the live process if it is still running for this runId.
    const live = deps.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (live && live.runId === runId) {
      try {
        deps.agentRuntime.stopAgentRun(runId)
      } catch {
        // Best-effort: the process may already be gone.
      }
    }

    // 2. Complete the run record (memory first, then SQLite — persisted state wins).
    model.complete(runId, input.exitCode, input.endedAt)
    model.updateError(runId, error)
    unsubscribeOutput(runId)

    console.log(
      `[RUN EXIT] run=${runId.slice(0, 8)} @${agentId} reason=${input.reason} exit=${String(input.exitCode)}${failure ? ` fail=${failure.category}` : ''} error=${error ?? 'none'}`
    )

    // 3. A newer run for the same agent owns the agent state. The task is
    // NOT settled here even when the replacement has not bound it yet: a
    // handoff delivery (engine switch / restart with session resume) binds
    // the same card only after run start. Instead the card is remembered on
    // the replacement — if the handoff never happens (replacement binds a
    // different task, or exits without binding anything), the card settles
    // then instead of being stuck in `running` until the idle watchdog.
    const newerActive = model
      .listActive()
      .some(
        (other) =>
          other.agentId === agentId && other.workspaceId === workspaceId && other.id !== runId
      )
    if (newerActive) {
      const replacement = model
        .listActive()
        .find(
          (other) =>
            other.agentId === agentId && other.workspaceId === workspaceId && other.id !== runId
        )
      const orphanedTaskId = run.taskId ?? undefined
      const carriedOver = orphanedTaskId !== undefined && replacement?.taskId === orphanedTaskId
      if (!carriedOver && orphanedTaskId !== undefined && replacement) {
        orphanedTasksByReplacement.set(replacement.id, {
          agentId,
          endedAt: input.endedAt,
          exitCode: input.exitCode,
          reason: input.reason,
          taskId: orphanedTaskId,
          workspaceId,
        })
      }
      console.log(
        `[RUN EXIT] Stale exit for @${agentId} (${runId.slice(0, 8)}): a newer run is active, skipping task/agent release.`
      )
      return
    }

    // 4. Free the agent so the dispatcher can reuse it immediately.
    releaseAgent(run, { reason: input.reason, error })

    // 5. Settle the owned task (review on clean exit, requeue otherwise) and
    // journal the classified failure so the card explains itself.
    if (failure && deps.taskStorePort?.addTaskLog) {
      const failedTask = run.taskId
        ? deps.taskStorePort.getTask(workspaceId, run.taskId)
        : deps.taskStorePort.getAssignedTaskForWorker(workspaceId, agentId)
      if (
        failedTask &&
        (failedTask.status === 'running' ||
          failedTask.status === 'assigned' ||
          failedTask.status === 'claimed')
      ) {
        try {
          deps.taskStorePort.addTaskLog(
            workspaceId,
            failedTask.id,
            `[RUN FAILED] ${failure.category}: ${failure.detail}`
          )
        } catch {
          // Journal is best-effort.
        }
        // R3 failure policy: classes that cannot self-heal by waiting get a
        // backoff window before the dispatcher may touch the card again.
        const backoffMs = retryBackoffMs(failure.category)
        if (backoffMs !== null && deps.taskStorePort.updateTask) {
          const nextRetryAt = Date.now() + backoffMs
          try {
            deps.taskStorePort.updateTask(workspaceId, failedTask.id, {
              status: 'ready',
              nextRetryAt,
              lastFailureCategory: failure.category,
            })
            deps.taskStorePort.addTaskLog(
              workspaceId,
              failedTask.id,
              `[RETRY ${failure.category} in ${describeBackoff(backoffMs)}]`
            )
            console.log(
              `[POLICY] task #${failedTask.id.slice(0, 8)} backoff ${describeBackoff(backoffMs)} (${failure.category})`
            )
          } catch {
            // Transition race (card already moved) — the log above stands.
          }
        }
        // R3.3: cli-missing/auth cannot fix themselves by waiting — bench the
        // worker so the dispatcher stops selecting it until a human intervenes.
        if (
          (failure.category === 'cli-missing' || failure.category === 'auth') &&
          deps.disableWorker
        ) {
          try {
            deps.disableWorker(workspaceId, agentId, failure.category)
            console.warn(`[WORKER DISABLED] @${agentId} (${failure.category})`)
            try {
              deps.taskStorePort.addTaskLog(
                workspaceId,
                failedTask.id,
                `[WORKER DISABLED] ${failure.category} — fix the environment, then reconfigure the engine`
              )
            } catch {}
            deps.emitEvent?.(workspaceId, {
              type: 'RUN_PROGRESS',
              entityVersion: Date.now(),
              payload: {
                agentId,
                line: `[WORKER DISABLED] ${failure.category} — reconfigure the engine after fixing the environment`,
              },
            })
          } catch {
            // Best-effort; backoff/journal above still explain the failure.
          }
        }
        // R4.1 auto-issue: after repeated NON-transient failures, surface an
        // incident card instead of retrying blindly. Transient classes
        // (rate-limit/quota/network) keep their silent backoff loop.
        const AUTO_ISSUE_AFTER_ATTEMPTS = 3
        const TRANSIENT_CATEGORIES = new Set(['rate-limit', 'quota', 'network'])
        const attempts = failedTask.attempts ?? 0
        if (
          attempts >= AUTO_ISSUE_AFTER_ATTEMPTS &&
          !TRANSIENT_CATEGORIES.has(failure.category) &&
          deps.taskStorePort.hasOpenChildIssue?.(workspaceId, failedTask.id) === false &&
          deps.taskStorePort.createIssueCard
        ) {
          const issue = deps.taskStorePort.createIssueCard(workspaceId, {
            parentTaskId: failedTask.id,
            title: `[ISSUE] ${failedTask.title} — repeated ${failure.category} failures`,
            description: [
              `Original task: #${failedTask.id}`,
              `Attempts: ${attempts} · Category: ${failure.category}`,
              '',
              `Last failure: ${failure.detail}`,
              '',
              'Triage: fix the root cause, then move the original task back to ready.',
            ].join('\n'),
          })
          if (issue) {
            try {
              deps.taskStorePort.addTaskLog(
                workspaceId,
                failedTask.id,
                `[ISSUE CREATED] #${issue.id}`
              )
            } catch {}
            console.log(
              `[ISSUE] task #${failedTask.id.slice(0, 8)} → issue card ${issue.id.slice(0, 8)} (${failure.category}, ${attempts} attempts)`
            )
          }
        }
      }
    }
    settleTask(run, { exitCode: input.exitCode, endedAt: input.endedAt, reason: input.reason })

    // Close the run's ledger rows: the owned task was just requeued, so no
    // report can arrive against them. A `submitted` row left behind
    // resurrects a zombie card on every board reconcile. Skipped on success —
    // there the row is `reported` and the review card references it.
    if (input.reason !== 'success') {
      deps.cancelOpenDispatches?.(workspaceId, agentId, `[RUN EXIT] run released (${input.reason})`)
    }

    // This run was itself the replacement for a superseded exit that left an
    // orphaned card on it. It exited without the handoff ever binding that
    // card (bindTask would have consumed the entry), so settle it now.
    const orphaned = orphanedTasksByReplacement.get(runId)
    if (orphaned) {
      orphanedTasksByReplacement.delete(runId)
      console.log(
        `[RUN EXIT] Settling task #${orphaned.taskId.slice(0, 8)} orphaned by a superseded run of @${orphaned.agentId}`
      )
      settleOwnedTask(orphaned.workspaceId, orphaned.agentId, orphaned.taskId, {
        endedAt: orphaned.endedAt,
        exitCode: orphaned.exitCode,
        reason: orphaned.reason,
      })
    }

    // Merge-back (worktree-first): on clean exit merge the worker's branch
    // into main. Best-effort — conflicts are logged for manual resolution.
    if (input.reason === 'success' && deps.workspaceStorePort?.hasAgent(workspaceId, agentId)) {
      try {
        const wsPath = deps.workspaceStorePath?.(workspaceId)
        let merged = false
        if (wsPath) {
          const result = mergeWorktreeToMain(wsPath, agentId)
          merged = result.merged
          if (result.merged) {
            console.log(`[WORKTREE] merged @${agentId} changes into main`)
          } else if (result.error) {
            console.warn(`[WORKTREE] merge conflict for @${agentId}: ${result.error}`)
          }
        }
        // Opt-in auto-PR: only after an actual merge, never on conflicts.
        if (merged && deps.autoPr?.isEnabled(workspaceId) && deps.taskStorePort?.addTaskLog) {
          const runTask = deps.taskStorePort.getAssignedTaskForWorker(workspaceId, agentId)
          try {
            const published = deps.autoPr.publishBranch(workspaceId, agentId)
            if ('url' in published) {
              console.log(`[WORKTREE] auto-PR for @${agentId}: ${published.url}`)
              try {
                if (runTask) {
                  deps.taskStorePort.addTaskLog(workspaceId, runTask.id, `[PR] ${published.url}`)
                }
              } catch {}
            } else {
              console.warn(`[WORKTREE] auto-PR failed for @${agentId}: ${published.error}`)
              try {
                if (runTask) {
                  deps.taskStorePort.addTaskLog(
                    workspaceId,
                    runTask.id,
                    `[PR FAILED] ${published.error}`
                  )
                }
              } catch {}
            }
          } catch (publishError) {
            const message =
              publishError instanceof Error ? publishError.message : String(publishError)
            console.warn(`[WORKTREE] auto-PR threw for @${agentId}: ${message}`)
            try {
              if (runTask) {
                deps.taskStorePort.addTaskLog(workspaceId, runTask.id, `[PR FAILED] ${message}`)
              }
            } catch {}
          }
        }
        // R4 deploy hook (opt-in): fire-and-forget so a slow deploy never
        // delays dispatch of the next ready task; result is journaled.
        if (merged) {
          const hookCommand = deps.deployHook?.getCommand(workspaceId) ?? null
          const journalDeploy = deps.taskStorePort?.addTaskLog
          if (hookCommand && journalDeploy && deps.taskStorePort) {
            const runTask = deps.taskStorePort.getAssignedTaskForWorker(workspaceId, agentId)
            const execute = deps.deployHook?.execute ?? runDeployHook
            void execute(hookCommand, wsPath ?? '.')
              .then((result) => {
                const seconds = (result.durationMs / 1000).toFixed(1)
                console.log(
                  `[DEPLOY] ${result.ok ? 'ok' : 'failed'} for ws ${workspaceId.slice(0, 8)} in ${seconds}s`
                )
                try {
                  if (runTask) {
                    journalDeploy(
                      workspaceId,
                      runTask.id,
                      result.ok
                        ? `[DEPLOY] ok (${seconds}s)\n${result.output}`
                        : `[DEPLOY FAILED] ${result.output}`
                    )
                  }
                } catch {}
              })
              .catch((hookError: unknown) => {
                console.error('[DEPLOY] hook runner threw:', hookError)
              })
          }
        }
      } catch {
        // Best-effort: merge failure must not break the release pipeline.
      }
    }

    // 6. Этап 5: crash auto-restart ladder (no-op unless the workspace opted
    // in via the app-state flag).
    scheduleCrashRestart(run, input.reason)

    // 7. The dispatcher may pick the next ready task right away.
    void deps
      .dispatchReadyTasks?.(workspaceId)
      ?.catch((error) => console.error('[SUPERVISOR] dispatch after run release failed:', error))
  }

  return {
    async startAgent(workspace, agentId, input) {
      const live = await deps.agentRuntime.startAgent(workspace, agentId, input)
      const run = model.get(live.runId) ?? getAgentRunFallback(workspace.id, agentId)
      if (!run) throw new Error(`Agent run not found after start: ${live.runId}`)
      return refresh(run)
    },
    stopAgent(runId) {
      deps.agentRuntime.stopAgentRun(runId)
      const run = model.get(runId)
      if (run && isActiveRuntimeState(run.runtimeState)) {
        void deps.agentRuntime.waitForAgentRunExit(runId).then(() => {
          const current = model.get(runId)
          if (current && isActiveRuntimeState(current.runtimeState)) {
            releaseAgentRun(runId, {
              exitCode: null,
              endedAt: Date.now(),
              reason: 'manual_stop',
              error: 'Agent process stopped by operator',
            })
          }
        })
      }
    },
    waitForAgentRunExit(runId) {
      return deps.agentRuntime.waitForAgentRunExit(runId)
    },
    bindTask(runId, taskId) {
      model.bindTask(runId, taskId)
      // A superseded exit may have parked its card on this run. Binding the
      // same card is the handoff confirmation (engine switch / restart with
      // session resume); binding anything else means the orphaned card will
      // never be worked by this run — settle it right away.
      const orphaned = orphanedTasksByReplacement.get(runId)
      if (!orphaned) return
      orphanedTasksByReplacement.delete(runId)
      if (orphaned.taskId === taskId) return
      console.log(
        `[RUN BIND] Settling task #${orphaned.taskId.slice(0, 8)} orphaned by a superseded run of @${orphaned.agentId}`
      )
      settleOwnedTask(orphaned.workspaceId, orphaned.agentId, orphaned.taskId, {
        endedAt: orphaned.endedAt,
        exitCode: orphaned.exitCode,
        reason: orphaned.reason,
      })
    },
    getAgentRun(workspaceId, agentId) {
      const run = model.getActiveForAgent(workspaceId, agentId)
      if (run) return refresh(run)
      return getAgentRunFallback(workspaceId, agentId)
    },
    getRun(runId) {
      const run = model.get(runId)
      return run ? refresh(run) : undefined
    },
    listActiveRuns() {
      return model.listActive().map(refresh)
    },
    getRunHistory(limit = 50) {
      return model.listAll().slice(0, limit)
    },
    getOutputBus() {
      return deps.agentRuntime.getPtyOutputBus()
    },
    handleRunStarted(runId, agentId, workspaceId, startedAt, pid) {
      // Register the new run first so the stale-exit guard inside
      // releaseAgentRun can see it and skip touching the task/agent of the
      // superseded run below.
      model.register({ agentId, id: runId, pid, runtimeState: 'starting', startedAt, workspaceId })
      const prior = model.getActiveForAgent(workspaceId, agentId)
      if (prior && prior.id !== runId) {
        releaseAgentRun(prior.id, {
          exitCode: null,
          endedAt: startedAt,
          reason: 'superseded',
          error: 'A new run started while this run was still tracked',
        })
      }
      const unsubscribe = deps.agentRuntime.getPtyOutputBus().subscribe(runId, (chunk) => {
        model.recordOutput(runId, chunk)
        if (model.get(runId)?.runtimeState === 'starting') {
          model.updateRuntimeState(runId, 'running')
        }
      })
      // A duplicate run-start must not orphan the previous listener: call its
      // unsubscribe before overwriting, or the old PTY bus subscription leaks.
      outputUnsubscribers.get(runId)?.()
      outputUnsubscribers.set(runId, unsubscribe)
      console.log(`[RUN CREATED] run=${runId.slice(0, 8)} @${agentId} ws=${workspaceId}`)
    },
    handleRunExited(runId, _agentId, workspaceId, exitCode, endedAt) {
      const run = model.get(runId)
      if (!run) return
      const lifecycle = deps.agentLifecycleStore.get(workspaceId, run.agentId)
      const reason: RunExitReason =
        lifecycle?.state === 'stopping' ? 'manual_stop' : exitCode === 0 ? 'success' : 'crash'
      releaseAgentRun(runId, { exitCode, endedAt, reason })
    },
    releaseAgentRun,
    softenErrorBudget(workspaceId) {
      const current = errorBudgetStreaks.get(workspaceId) ?? 0
      if (current <= 0) return
      errorBudgetStreaks.set(workspaceId, Math.floor(current / 2))
    },
    healthCheck(workspaceId, agentId) {
      const run = model.getActiveForAgent(workspaceId, agentId)
      const live = deps.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
      const heartbeat = deps.agentHeartbeatStore.get(workspaceId, agentId)
      const lastHeartbeat = heartbeat?.lastSeen ?? null
      const now = Date.now()
      const healthyMaxAge = deps.healthyHeartbeatMaxAgeMs ?? HEALTHY_HEARTBEAT_MAX_AGE_MS
      const stuckMaxAge = deps.stuckHeartbeatMaxAgeMs ?? STUCK_HEARTBEAT_MAX_AGE_MS
      let status: AgentHealthStatus
      if (!run && !live) {
        status = 'NOT_RUNNING'
      } else if (live) {
        if (lastHeartbeat === null || now - lastHeartbeat > stuckMaxAge) {
          status = 'STUCK'
        } else if (now - lastHeartbeat > healthyMaxAge) {
          status = 'SUSPECTED'
        } else {
          status = 'HEALTHY'
        }
      } else {
        status = 'DEAD'
      }
      return {
        status,
        agentId,
        workspaceId,
        runId: live?.runId ?? run?.id ?? null,
        lastHeartbeat,
        lastOutput: run?.lastOutput ?? live?.output.slice(-10_000) ?? '',
        lifecycleState: deps.agentLifecycleStore.get(workspaceId, agentId)?.state ?? null,
      }
    },
    reconcile() {
      const summary: ReconcileSummary = { restored: 0, failed: 0, stale: 0 }
      for (const run of model.listActive()) {
        const live = deps.agentRuntime.getActiveRunByAgentId(run.workspaceId, run.agentId)
        if (live && live.runId === run.id) {
          summary.restored += 1
          continue
        }
        if (live && live.runId !== run.id) {
          void reapOrphanProcess(run.pid, 'superseded-by-live-run', run.startedAt)
          releaseAgentRun(run.id, {
            exitCode: null,
            endedAt: Date.now(),
            reason: 'superseded',
            error: 'Active run superseded by a different live run after restart',
          })
          summary.stale += 1
          continue
        }
        // The persisted run has no live registry entry. Its OS process may
        // still be alive from before the restart (Windows ConPTY orphans) —
        // kill it instead of letting it burn tokens with no task attached.
        void reapOrphanProcess(run.pid, 'orphaned-after-restart', run.startedAt)
        releaseAgentRun(run.id, {
          exitCode: null,
          endedAt: Date.now(),
          reason: 'process_dead_after_restart',
          error: 'Process not running after restart',
        })
        summary.failed += 1
      }
      console.log(
        `[RECOVERY] Reconcile done: restored=${summary.restored} failed=${summary.failed} stale=${summary.stale}`
      )
      return summary
    },
    close() {
      for (const unsubscribe of outputUnsubscribers.values()) {
        unsubscribe()
      }
      outputUnsubscribers.clear()
      releasedRuns.clear()
      for (const timer of restartTimers.values()) {
        clearTimeout(timer)
      }
      restartTimers.clear()
      crashStreaks.clear()
    },
  }

  function getAgentRunFallback(workspaceId: string, agentId: string): AgentRun | undefined {
    const active = deps.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (!active) return undefined
    const lifecycle = deps.agentLifecycleStore.get(workspaceId, agentId)
    const heartbeat = deps.agentHeartbeatStore.get(workspaceId, agentId)
    return {
      id: active.runId,
      taskId: null,
      agentId,
      workspaceId,
      pid: active.pid,
      runtimeState: active.status,
      lifecycleState: lifecycle?.state ?? 'starting',
      startedAt: active.startedAt,
      endedAt: null,
      exitCode: active.exitCode,
      lastHeartbeat: heartbeat?.lastSeen ?? null,
      lastOutput: active.output.slice(-10_000),
      error: null,
    }
  }
}
