import { createAgentControl } from './agent-control.js'
import { createAgentSnapshot, persistAgentSnapshot } from './agent-handoff.js'
import { createAgentHeartbeatStore } from './agent-heartbeat-store.js'
import { canTransitionAgentLifecycle } from './agent-lifecycle.js'
import { createAgentLifecycleStore } from './agent-lifecycle-store.js'
import type { AgentManager } from './agent-manager.js'
import { createAgentRunRecordStore } from './agent-run-record-store.js'
import { type AgentLaunchConfigInput, createAgentRunStore } from './agent-run-store.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  buildScheduledTaskInput,
  hasOpenScheduledTask,
  isScheduleDue,
  readLastFiredAt,
  readSchedule,
  SCHEDULE_KEY_PREFIX,
  scheduledMarker,
  writeLastFiredAt,
} from './agent-scheduler.js'
import { readAgentSessionSnapshot } from './agent-session-journal.js'
import { createAgentSessionStore } from './agent-session-store.js'
import { createAgentStallScanner } from './agent-stall-scanner.js'
import { type AgentTelemetry, createAgentTelemetry } from './agent-telemetry.js'
import { createAgentUsageStore } from './agent-usage-store.js'
import { APPROVAL_TTL_MS, type ApprovalRequest, createApprovalStore } from './approval-store.js'
import { readDeployHookCommand } from './deploy-hook.js'
import { createDispatchLedgerStore } from './dispatch-ledger-store.js'
import { readSandboxSettings } from './docker-sandbox.js'
import { getEngineAdapter } from './engine-adapter.js'
import { getEngineControlProfile } from './engine-control-profiles.js'
import {
  BREAKER_STAGE_KEY_PREFIX,
  BREAKER_UNTIL_KEY_PREFIX,
  breakerPauseMs,
  isBreakerCoolingDown,
  isMemoryHoldActive,
  readBreakerStage,
} from './error-budget-breaker.js'
import {
  createEventLog,
  type EventLog,
  type EventLogRecord,
  type TailEventLogOptions,
} from './event-log.js'
import { buildTaskContextReinjectionPayload } from './gachi-team-guidance.js'
import { createBranchPr, listOpenPrs, type OpenPrSummary } from './github-pr.js'
import { dispatchReadyKanbanTasks } from './kanban-dispatcher.js'
import {
  createMemoryWatchdog,
  type MemoryWatchdog,
  type RotationCandidate,
} from './memory-watchdog.js'
import { createMessageLogStore } from './message-log-store.js'
import { autostartOrchestrator } from './orchestrator-autostart.js'
import { createOrchestratorHeartbeat, readHeartbeatIntervalMs } from './orchestrator-heartbeat.js'
import { createOrchestratorInbox } from './orchestrator-inbox.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { createOrchestratorSelfHeal } from './orchestrator-self-heal.js'
import {
  DISPATCH_PAUSED_KEY_PREFIX,
  readPermissionMode,
  WORKER_AUTORESTART_KEY_PREFIX,
} from './permission-mode.js'
import { buildPlannerPrompt, createPlanDraftCapture } from './plan-draft.js'
import {
  buildPrReviewTaskInput,
  hasOpenAutopilotTask,
  readAutopilotMode,
  readRoundsLimit,
  readSeenMap,
  selectPrsToReview,
  writeSeenMap,
} from './pr-autopilot.js'
import { createPromptAutoResponder } from './prompt-autoresponder.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRecoveryWatchdog } from './recovery-watchdog.js'
import { routeReadyReviewTasks } from './reviewer-pipeline.js'
import { openRuntimeDatabase } from './runtime-database.js'
import { createRuntimeEventBus, type RuntimeEventBus } from './runtime-event-bus.js'
import { buildRuntimeRestartPolicy } from './runtime-restart-policy.js'
import type { RuntimeSupervisor } from './runtime-supervisor.js'
import { createRuntimeSupervisor, type RuntimeSupervisorDeps } from './runtime-supervisor.js'
import { createSettingsStore } from './settings-store.js'
import { reapDeadRunningTasks } from './task-reaper.js'
import { taskStore } from './task-store.js'
import { createTasksFileService, syncTasksMarkdownFile } from './tasks-file.js'
import { createTasksFileWatcher } from './tasks-file-watcher.js'
import type { RuntimeEventPayload } from './tasks-websocket-server.js'
import { createTeamOperations } from './team-operations.js'
import { createTelegramLinksStore } from './telegram-links-store.js'
import {
  createTelegramService,
  createTgReplyLineForwarder,
  type TelegramService,
} from './telegram-service.js'
import { resolveTerminalInputProfile } from './terminal-input-profile.js'
import { createUiAuth } from './ui-auth.js'
import { rollingSuccessRate } from './worker-health.js'
import { createWorkerOutputTracker, type WorkerOutputTracker } from './worker-output-tracker.js'
import { createWorkerReportNudge } from './worker-report-nudge.js'
import { createWorkspaceShellRuntime } from './workspace-shell-runtime.js'
import { createWorkspaceStore } from './workspace-store.js'
import { resolveWorkerBranchName } from './worktree-manager.js'

/**
 * An agent is considered quiet / free when it has produced no PTY output for
 * this window. Replaces the previous blocking 400ms stdout-sampling heuristic.
 */
export const HEARTBEAT_QUIET_WINDOW_MS = 8_000

export interface RuntimeStoreServices {
  agentHeartbeatStore: ReturnType<typeof createAgentHeartbeatStore>
  agentLifecycleStore: ReturnType<typeof createAgentLifecycleStore>
  agentRunRecordStore: ReturnType<typeof createAgentRunRecordStore>
  agentRunStore: ReturnType<typeof createAgentRunStore>
  agentRuntime: ReturnType<typeof createAgentRuntime>
  agentSessionStore: ReturnType<typeof createAgentSessionStore>
  usageStore: ReturnType<typeof createAgentUsageStore>
  db: ReturnType<typeof openRuntimeDatabase>
  dispatchAllWorkspaceTasks: (workspaceId: string) => Promise<void>
  runScheduleTick: () => void
  /** Memory watchdog instance: dispatch hold + RSS telemetry + rotation. */
  memoryWatchdog: MemoryWatchdog
  dispatchLedgerStore: ReturnType<typeof createDispatchLedgerStore>
  eventLog: EventLog
  messageLogStore: ReturnType<typeof createMessageLogStore>
  tailEvents: (workspaceId: string, options?: TailEventLogOptions) => EventLogRecord[]
  agentEvents: (
    workspaceId: string,
    agentId: string,
    options?: Omit<TailEventLogOptions, 'agentId'>
  ) => EventLogRecord[]
  orchestratorHeartbeat: ReturnType<typeof createOrchestratorHeartbeat>
  setRuntimePort: (port: string) => void
  workerReportNudge: ReturnType<typeof createWorkerReportNudge>
  settings: ReturnType<typeof createSettingsStore>
  shellRuntime: ReturnType<typeof createWorkspaceShellRuntime>
  tasksFileWatcher: ReturnType<typeof createTasksFileWatcher>
  runtimeEventBus: RuntimeEventBus
  runtimeSupervisor: RuntimeSupervisor
  /** Registers the writer invoked when the auto-compact policy fires. */
  registerAutoCompactHandler: (
    handler: (
      workspaceId: string,
      agentId: string,
      info: {
        contextPercent: number | null
        tokensUsed: number | null
        trigger: 'context' | 'tokens'
      }
    ) => void
  ) => void
  approvalStore: ReturnType<typeof createApprovalStore>
  /** Drops task-status dedup cache entries for a deleted workspace (audit M-1). */
  forgetTaskStatusesForWorkspace: (workspaceId: string) => void
  telegramLinks: ReturnType<typeof createTelegramLinksStore>
  /** Auto-unblock timer cleanup (prompt-autoresponder). */
  autoUnblockStop: () => void
  telegramService: TelegramService
  /** Canonical PTY stdin write (shell runs first, then agent runs). */
  writeRunInput: (runId: string, input: Buffer | string) => void
  tasksFileWatchCallbacks: Set<(workspaceId: string, content: string) => void>
  tasksFileService: ReturnType<typeof createTasksFileService>
  teamOps: ReturnType<typeof createTeamOperations>
  telemetry: AgentTelemetry
  draftPlanFromGoal: (
    workspaceId: string,
    goal: string
  ) => { accepted: true; groupId: string } | { accepted: false; reason: string }
  uiAuth: ReturnType<typeof createUiAuth>
  workerOutputTracker: WorkerOutputTracker | null
  workspaceStore: ReturnType<typeof createWorkspaceStore>
  /**
   * Runs the deferred startup-recovery steps (lifecycle settle, task requeue,
   * run reconcile, initial dispatch). No-op when recovery already ran inline.
   */
  runStartupRecovery: () => void
  /** Halves the workspace failure streak (error-budget breaker resume). */
  softenErrorBudget: (workspaceId: string) => void
}

interface CreateRuntimeStoreServicesOptions {
  agentManager?: AgentManager
  dataDir?: string
  /**
   * Defer startup recovery (lifecycle settle, task requeue, run reconcile,
   * initial dispatch) until `runStartupRecovery()` is called. The daemon boot
   * path sets this so a port-conflict exit cannot touch SQLite state — during
   * the 2026-08-30 incident a restart loop ran recovery BEFORE failing to
   * bind, killing the live instance's workers and burning its error budget
   * every cycle.
   */
  deferStartupRecovery?: boolean
}

interface CreateRuntimeStoreLifecycleOptions {
  agentManager?: AgentManager
  services: RuntimeStoreServices
}

const notifyTasksUpdated = (
  callbacks: Set<(workspaceId: string, content: string) => void>,
  workspaceId: string,
  content: string
) => {
  for (const callback of callbacks) {
    callback(workspaceId, content)
  }
}

export const createRuntimeStoreServices = (
  options: CreateRuntimeStoreServicesOptions = {}
): RuntimeStoreServices => {
  const db = openRuntimeDatabase(options.dataDir)
  const autoUnblock: { stop: (() => void) | null } = { stop: null }
  taskStore.init(db)
  /**
   * Startup-recovery steps registered here run inline (previous behavior) or
   * are held back for `runStartupRecovery()` when the boot path defers them
   * past the port bind.
   */
  const deferredRecoverySteps: Array<() => void> = []
  const runNowOrDefer = (step: () => void) => {
    if (options.deferStartupRecovery) deferredRecoverySteps.push(step)
    else step()
  }
  const agentHeartbeatStore = createAgentHeartbeatStore(db)
  const messageLogStore = createMessageLogStore(db)
  const dispatchLedgerStore = createDispatchLedgerStore(db)
  const agentLifecycleStore = createAgentLifecycleStore(db)
  const agentRunStore = createAgentRunStore(db)
  const agentRunRecordStore = createAgentRunRecordStore(db)
  const agentSessionStore = createAgentSessionStore(db)
  const settings = createSettingsStore(db)
  const tasksFileService = createTasksFileService()
  const runtimeEventBus = createRuntimeEventBus()
  const tasksFileWatchCallbacks = new Set<(workspaceId: string, content: string) => void>()
  const tasksFileWatcher = createTasksFileWatcher({
    onTasksUpdated: (workspaceId, content) => {
      notifyTasksUpdated(tasksFileWatchCallbacks, workspaceId, content)
    },
  })
  const uiAuth = createUiAuth()
  const shellRuntime = createWorkspaceShellRuntime(options.agentManager)

  // Usage telemetry (context %/tokens scraped from PTY output) with the
  // auto-compact policy. The actual `/compact` write is registered by the
  // lifecycle layer once the runtime wiring exists; the usage warning is
  // routed to Telegram once that service exists (Discovery spec §7).
  let autoCompactHandler:
    | ((
        workspaceId: string,
        agentId: string,
        info: {
          contextPercent: number | null
          tokensUsed: number | null
          trigger: 'context' | 'tokens'
        }
      ) => void)
    | null = null
  let usageWarningHandler:
    | ((workspaceId: string, agentId: string, contextPercent: number) => void)
    | null = null
  // Token-budget compaction (user policy): all workers compact at N tokens.
  // Configured globally via app-state `auto_compact_tokens`; absent → off.
  const compactTokensRaw = settings.getAppState('auto_compact_tokens')?.value
  const compactTokensParsed =
    typeof compactTokensRaw === 'string' ? Number.parseInt(compactTokensRaw, 10) : Number.NaN
  const autoCompactTokens =
    Number.isFinite(compactTokensParsed) && compactTokensParsed > 0 ? compactTokensParsed : null
  const telemetry = createAgentTelemetry({
    autoCompactTokens,
    // Context-guard threshold (Этап 4): app-state `context_guard_threshold_percent`,
    // default 85; "0" (or garbage ≤ 0) turns the percent trigger off.
    getThresholdPercent: () => {
      const raw = settings.getAppState('context_guard_threshold_percent')?.value
      if (raw === undefined || raw === null || raw.trim() === '') return 85
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) return null
      return parsed
    },
    // Quiet window: ignore scraped percentages for the first 2 minutes of a
    // fresh run — the tail of the PREVIOUS session (or the launcher banner) can
    // still repaint old numbers and would trigger a pointless compaction.
    isInQuietWindow: (workspaceId, agentId) => {
      const run = agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
      return run !== undefined && Date.now() - run.startedAt < 2 * 60_000
    },
    onAutoCompact: (workspaceId, agentId, info) => {
      autoCompactHandler?.(workspaceId, agentId, info)
    },
    onUsageWarning: (workspaceId, agentId, contextPercent) => {
      usageWarningHandler?.(workspaceId, agentId, contextPercent)
    },
  })
  const usageStore = createAgentUsageStore(db)

  // Active run recovery is owned by RuntimeSupervisor.reconcile() (called once
  // the dispatcher is wired below): it fails orphaned runs, requeues their tasks
  // and frees their agents in one consistent pipeline. Workers whose lifecycle
  // was mid-flight get `stopped`, not `failed` — the daemon died, they didn't.
  runNowOrDefer(() => {
    agentLifecycleStore.markUnfinishedAsStopped()
  })

  const workspaceStore = createWorkspaceStore(db, dispatchLedgerStore.listOpenDispatchKinds())

  // The event log is the durable/agent-facing consumer of the SAME RuntimeEventBus
  // that drives the UI WebSocket: audit trail + per-agent mailbox (see event-log.ts).
  const eventLog = createEventLog({
    getWorkspacePath: (workspaceId) => {
      try {
        return workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        return null
      }
    },
  })
  eventLog.attach(runtimeEventBus)

  // Startup recovery для задач: если приложение перезапущено, любые задачи в running/assigned
  // без активных процессов освобождаются и возвращаются в 'ready'
  runNowOrDefer(() => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      for (const task of taskStore.listTasks(workspace.id)) {
        if (task.status === 'running' || task.status === 'assigned') {
          console.log(
            `[STARTUP RECOVERY] Task #${task.id.slice(0, 8)} ("${task.title}") was left in status "${task.status}". Returning to READY.`
          )
          taskStore.releaseTask(
            workspace.id,
            task.id,
            'Приложение было перезапущено, активный процесс сброшен'
          )
        }
      }
    }
  })

  // Task semantic events: emit TASK_STARTED/COMPLETED/FAILED on status transitions.
  // Deduped by diffing against the last-seen status per task id. Keys include
  // the workspace id so per-workspace cleanup is possible; a FIFO cap keeps
  // long-lived processes bounded (M-1).
  const LAST_TASK_STATUS_CACHE_CAP = 4000
  const lastTaskStatus = new Map<string, string>()
  const forgetTaskStatusesForWorkspace = (workspaceId: string) => {
    const prefix = `${workspaceId}:`
    for (const cacheKey of [...lastTaskStatus.keys()]) {
      if (cacheKey.startsWith(prefix)) lastTaskStatus.delete(cacheKey)
    }
  }
  const emitTaskSemanticEvent = (
    workspaceId: string,
    task: { agentId?: string; id: string; status: string; title: string }
  ) => {
    const cacheKey = `${workspaceId}:${task.id}`
    const previous = lastTaskStatus.get(cacheKey)
    if (previous === task.status) return
    while (lastTaskStatus.size >= LAST_TASK_STATUS_CACHE_CAP) {
      const oldest = lastTaskStatus.keys().next().value
      if (oldest === undefined) break
      lastTaskStatus.delete(oldest)
    }
    lastTaskStatus.set(cacheKey, task.status)
    const payload = {
      agentId: task.agentId,
      previousStatus: previous,
      status: task.status,
      taskId: task.id,
      title: task.title,
    }
    if (task.status === 'running' && previous !== 'running') {
      runtimeEventBus.emit(workspaceId, { type: 'TASK_STARTED', payload })
    } else if ((task.status === 'review' || task.status === 'done') && previous !== task.status) {
      runtimeEventBus.emit(workspaceId, { type: 'TASK_COMPLETED', payload })
    } else if (task.status === 'failed' && previous !== task.status) {
      runtimeEventBus.emit(workspaceId, { type: 'TASK_FAILED', payload })
    }
  }

  // Reactive kanban: any mutation that leaves (or creates) a `ready` card
  // schedules an immediate debounced dispatch pass instead of waiting up to a
  // minute for the heartbeat/nudge timers. The timers stay as watchdogs.
  const REACTIVE_DISPATCH_DEBOUNCE_MS = 200
  const reactiveDispatchPending = new Set<string>()
  let reactiveDispatchTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleReactiveDispatch = (workspaceId: string) => {
    reactiveDispatchPending.add(workspaceId)
    if (reactiveDispatchTimer) return
    reactiveDispatchTimer = setTimeout(() => {
      reactiveDispatchTimer = null
      const batch = [...reactiveDispatchPending]
      reactiveDispatchPending.clear()
      for (const id of batch) {
        void dispatchAllWorkspaceTasks(id).catch((error) =>
          console.error(
            '[DISPATCH] reactive dispatch failed:',
            error instanceof Error ? error.message : error
          )
        )
      }
    }, REACTIVE_DISPATCH_DEBOUNCE_MS)
    reactiveDispatchTimer.unref?.()
  }

  // При любых изменениях в TaskStore автоматически синкаем tasks.md для воркспейса
  taskStore.onTaskChanged((workspaceId, tasks) => {
    try {
      const snap = workspaceStore.getWorkspaceSnapshot(workspaceId)
      if (snap?.summary?.path) {
        syncTasksMarkdownFile(snap.summary.path, tasks)
      }
    } catch {
      // Игнорируем если воркспейс ещё не загружен или не найден
    }
    for (const task of tasks) {
      emitTaskSemanticEvent(
        workspaceId,
        task.assignedAgentId
          ? {
              agentId: task.assignedAgentId,
              id: task.id,
              status: task.status,
              title: task.title,
            }
          : { id: task.id, status: task.status, title: task.title }
      )
    }
    runtimeEventBus.emit(workspaceId, {
      type: 'QUEUE_UPDATED',
      payload: {
        taskCount: tasks.length,
      },
    })
    if (tasks.some((task) => task.status === 'ready')) {
      scheduleReactiveDispatch(workspaceId)
    }
  })
  // The dispatch ledger is durable independently from the Kanban snapshot. Repair
  // the projection during runtime startup so a restart can never leave a live or
  // reported worker task invisible on the board.
  for (const workspace of workspaceStore.listWorkspaces()) {
    let repaired = false
    const liveWorkerIds = new Set(
      workspaceStore.listWorkers(workspace.id).map((worker) => worker.id)
    )
    for (const dispatch of dispatchLedgerStore.listWorkspaceDispatches(workspace.id, {
      limit: 1000,
    })) {
      if (
        dispatch.status === 'cancelled' ||
        taskStore.getTaskByDispatchId(workspace.id, dispatch.id)
      )
        continue
      // Same rule as the board-load reconcile: a row whose worker was deleted
      // is neither restorable (getWorker throws) nor wanted (the card would be
      // bound to a ghost). Skip it instead of aborting the boot repair.
      if (!liveWorkerIds.has(dispatch.toAgentId)) continue
      const worker = workspaceStore.getWorker(workspace.id, dispatch.toAgentId)
      const title =
        dispatch.text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || `Task for ${worker.name}`
      taskStore.createTask(workspace.id, {
        assignedAgentId: dispatch.toAgentId,
        artifacts: dispatch.artifacts,
        description: dispatch.text,
        dispatchId: dispatch.id,
        result: dispatch.reportText ?? undefined,
        // Only actually-reported work returns as review. Never-delivered
        // dispatches come back as BACKLOG — visible on the board, but not
        // auto-dispatched to idle workers right after a restart.
        status: dispatch.status === 'reported' ? 'review' : 'backlog',
        title,
      })
      repaired = true
    }
    if (repaired) {
      syncTasksMarkdownFile(workspace.path, taskStore.listTasks(workspace.id))
    }
  }
  const startExistingWorkspaceWatches = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      // A single workspace with an unwritable tasks.md (locked file, flaky
      // disk) must not take down daemon startup for every other workspace.
      tasksFileWatcher.start(workspace.id, workspace.path).catch((error: unknown) => {
        console.error(`[TASKS FILE] watcher start failed for ${workspace.id}:`, error)
      })
    }
  }
  // Единая точка запуска следующего диспатча. Заполняется после создания
  // heartbeat/nudge (когда teamOps уже доступен), но вызывается из onAgentExit
  // и reportTask, которые создаются раньше, поэтому используется let-замыкание.
  let dispatchAllWorkspaceTasks: (workspaceId: string) => Promise<void> = async () => {}
  const restartPolicy = buildRuntimeRestartPolicy({
    agentRunStore,
    messageLogStore,
    tasksFileService,
    workspaceStore,
  })
  const workerOutputTracker = options.agentManager
    ? createWorkerOutputTracker(
        options.agentManager.getOutputBus(),
        agentHeartbeatStore,
        (workspaceId, agentId, line) => {
          runtimeEventBus.emit(workspaceId, {
            type: 'RUN_PROGRESS',
            payload: {
              agentId,
              line,
            },
          })
        },
        (workspaceId, agentId, taskId) => {
          // Handshake: the worker acknowledged receipt of its dispatched task.
          // If delivery hasn't transitioned it yet, promote assigned → running;
          // otherwise just stamp the ack in the log so the event is visible.
          const assigned = taskId
            ? taskStore.getTask(workspaceId, taskId)
            : taskStore.getAssignedTaskForWorker(workspaceId, agentId)
          if (!assigned) return
          if (assigned.status === 'assigned') {
            taskStore.updateTask(workspaceId, assigned.id, { status: 'running' })
          }
          taskStore.addLog(
            workspaceId,
            assigned.id,
            '[TASK_ACK] Worker acknowledged receipt of the task'
          )
          runtimeEventBus.emit(workspaceId, {
            type: 'TASK_ACCEPTED',
            payload: {
              agentId,
              taskId: assigned.id,
              title: assigned.title,
            },
          })
        },
        (workspaceId, agentId) => {
          // The CLI just compacted its conversation history — re-inject the
          // current task binding so the worker keeps working and still knows
          // how to report. The ack reply is prompted, not real work.
          const assigned = taskStore.getAssignedTaskForWorker(workspaceId, agentId)
          const payload = buildTaskContextReinjectionPayload(
            assigned
              ? {
                  dispatchId: assigned.dispatchId ?? assigned.id,
                  taskId: assigned.id,
                  title: assigned.title,
                }
              : undefined
          )
          workerOutputTracker?.notePromptInjection(workspaceId, agentId)
          agentRuntime.writeWorkerReportNudge(workspaceId, agentId, payload)
        },
        (workspaceId, agentId, chunk) => {
          telemetry.observe(workspaceId, agentId, chunk)
          // R1: durable usage timeline — the store throttles to 1 sample/min.
          const snapshot = telemetry.snapshot(workspaceId, agentId)
          if (snapshot) {
            usageStore.recordSample({
              workspaceId,
              agentId,
              contextPercent: snapshot.contextPercent,
              tokensUsed: snapshot.tokensUsed,
            })
          }
        },
        (workspaceId, agentId, message) => {
          const assigned = taskStore.getAssignedTaskForWorker(workspaceId, agentId)
          runtimeEventBus.emit(workspaceId, {
            type: 'TASK_PROGRESS',
            payload: {
              agentId,
              message,
              taskId: assigned?.id ?? null,
            },
          })
        }
      )
    : null
  let runtimeSupervisor: RuntimeSupervisor
  // Telegram `[TG_REPLY]` bridge: the starter forwards orchestrator PTY
  // chunks here; the forwarder assembles lines and broadcasts to chats.
  // Late-bound — telegramService is created further down this factory.
  let tgReplyForwarder: ((chunk: string) => void) | null = null
  const agentRuntime = createAgentRuntime(
    options.agentManager,
    agentRunStore,
    agentSessionStore,
    settings.getCommandPreset,
    (workspaceId, agentId) => {
      workerOutputTracker?.detach(workspaceId, agentId)
      agentHeartbeatStore.record(workspaceId, agentId, {
        status: 'stopped',
        phase: 'process_exited',
      })
      // Agent release (lifecycle transition, markAgentStopped, AGENT_STATUS_CHANGED)
      // and task settlement are owned by RuntimeSupervisor.releaseAgentRun so the
      // stale-exit guard applies uniformly. Dispatch so the next task can start.
      void dispatchAllWorkspaceTasks(workspaceId).catch((error) =>
        console.error('[DISPATCH] dispatch after agent exit failed:', error)
      )
    },
    restartPolicy,
    (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
    (runId, agentId, workspaceId, startedAt, pid) => {
      runtimeSupervisor?.handleRunStarted(runId, agentId, workspaceId, startedAt, pid)
    },
    (runId, agentId, workspaceId, exitCode, endedAt) => {
      runtimeSupervisor?.handleRunExited(runId, agentId, workspaceId, exitCode, endedAt)
    },
    (chunk: string) => {
      tgReplyForwarder?.(chunk)
      planCapture.push(chunk)
    },
    // R10: `ask` permission mode suppresses blanket opencode grants.
    (workspaceId) => readPermissionMode(settings, workspaceId),
    // R5→R10: opt-in Docker sandbox for worker launches.
    (workspaceId) => readSandboxSettings(settings, workspaceId, false)
  )
  // R4.1 auto-issue port methods, typed via Pick so the surface stays honest.
  const issuePortMethods: Pick<
    NonNullable<RuntimeSupervisorDeps['taskStorePort']>,
    'hasOpenChildIssue' | 'createIssueCard'
  > = {
    hasOpenChildIssue: (workspaceId: string, taskId: string) =>
      taskStore
        .listTasks(workspaceId)
        .some(
          (t) =>
            t.parentTaskId === taskId &&
            ['backlog', 'ready', 'assigned', 'claimed', 'running'].includes(t.status)
        ),
    createIssueCard: (
      workspaceId: string,
      input: { parentTaskId: string; title: string; description: string }
    ) => {
      try {
        const issue = taskStore.createTask(workspaceId, {
          title: input.title,
          description: input.description,
          parentTaskId: input.parentTaskId,
          role: 'custom',
          priority: 'high',
        })
        return { id: issue.id }
      } catch {
        return undefined
      }
    },
  }
  const supervisorDeps: RuntimeSupervisorDeps = {
    agentRuntime,
    agentHeartbeatStore,
    agentLifecycleStore,
    recordStore: agentRunRecordStore,
    taskStorePort: {
      getAssignedTaskForWorker: (workspaceId, workerIdOrName) =>
        taskStore.getAssignedTaskForWorker(workspaceId, workerIdOrName),
      getTask: (workspaceId, taskId) => taskStore.getTask(workspaceId, taskId),
      addTaskLog: (workspaceId, taskId, message) =>
        void taskStore.addLog(workspaceId, taskId, message),
      releaseTask: (workspaceId, taskId, reason) =>
        taskStore.releaseTask(workspaceId, taskId, reason),
      updateTask: (workspaceId, taskId, updates) =>
        taskStore.updateTask(workspaceId, taskId, updates),
    },
    workspaceStorePort: {
      getAgent: (workspaceId, agentId) => workspaceStore.getAgent(workspaceId, agentId),
      hasAgent: (workspaceId, agentId) => workspaceStore.hasAgent(workspaceId, agentId),
      markAgentStopped: (workspaceId, agentId) =>
        workspaceStore.markAgentStopped(workspaceId, agentId),
    },
    workspaceStorePath: (workspaceId: string) => {
      try {
        return workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        return null
      }
    },
    // R3.3: bench workers whose CLI vanished or whose auth expired — clearing
    // the launch config removes them from dispatcher selection until a human
    // re-configures the engine (UI or `team engine`).
    disableWorker: (workspaceId, agentId, reason) => {
      void reason
      try {
        agentRuntime.deleteAgentLaunchConfig(workspaceId, agentId)
      } catch {
        // Nothing configured — the supervisor already journaled the bench.
      }
    },
    // R10 error-budget circuit breaker: open the breaker with a cooldown —
    // dispatch resumes AUTOMATICALLY when the deadline elapses (isDispatchPaused
    // below); repeated breaches escalate the cooldown via the stage counter.
    onErrorBudgetExceeded: (workspaceId) => {
      const stage = readBreakerStage(settings, workspaceId)
      const pauseMs = breakerPauseMs(stage)
      const until = Date.now() + pauseMs
      settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`, '1')
      settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${workspaceId}`, String(until))
      settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${workspaceId}`, String(stage + 1))
      console.warn(
        `[BREAKER] ws ${workspaceId.slice(0, 8)}: dispatch paused for ${Math.round(pauseMs / 60_000)}m ` +
          `(stage ${stage + 1}), auto-resume at ${new Date(until).toLocaleTimeString()}`
      )
      // Telegram is best-effort — the console warn already happened. A sync
      // try/catch cannot catch an async rejection, so attach .catch instead.
      telegramService
        .notifyOrchestratorReply(
          `⛔ Circuit breaker: dispatch paused on ${workspaceId.slice(0, 8)} — ` +
            `${Math.round(pauseMs / 60_000)}m cooldown (stage ${stage + 1}), then auto-resume`
        )
        .catch(() => {})
      runtimeEventBus.emit(workspaceId, {
        type: 'QUEUE_UPDATED',
        payload: { taskCount: taskStore.listTasks(workspaceId).length },
      })
    },
    // A clean run closed the streak — the breaker fully resets (cooldown
    // deadline and escalation stage cleared), ready to trip from stage 0.
    onBreakerRecovered: (workspaceId) => {
      settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`, '0')
      settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${workspaceId}`, '0')
      settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${workspaceId}`, '0')
    },
    // R4.1 auto-issue: incident cards linked via parentTaskId; one open card
    // per failing task (statuses that still can act on it).
    ...issuePortMethods,
    autoPr: {
      isEnabled: (workspaceId) =>
        settings.getAppState(`auto_pr_after_merge_${workspaceId}`)?.value === '1',
      publishBranch: (workspaceId, agentId) => {
        const wsPath = workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
        try {
          return createBranchPr({
            branch: resolveWorkerBranchName(wsPath, agentId),
            cwd: wsPath,
            title: `Worker ${agentId.slice(0, 8)} changes`,
          })
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    },
    emitEvent: (workspaceId, event) => runtimeEventBus.emit(workspaceId, event),
    dispatchReadyTasks: (workspaceId) => dispatchAllWorkspaceTasks(workspaceId),
    // Этап 5 crash auto-restart: strictly opt-in per workspace. Restarting
    // mirrors `ensureWorkerRun` (persisted launch config, empty gachiPort
    // like the dispatcher's own relaunches); a startup failure exits the
    // fresh run as a crash and keeps climbing the supervisor's ladder.
    autoRestart: {
      isEnabled: (workspaceId) =>
        settings.getAppState(`${WORKER_AUTORESTART_KEY_PREFIX}${workspaceId}`)?.value === '1',
      start: async (workspaceId, agentId) => {
        if (agentRuntime.getActiveRunByAgentId(workspaceId, agentId)) return
        if (!agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)) {
          throw new Error(`No launch config for @${agentId} — cannot auto-restart`)
        }
        agentLifecycleStore.transition(workspaceId, agentId, 'starting', {
          error: null,
          reason: 'crash_autorestart',
          runId: null,
        })
        workspaceStore.markAgentStarted(workspaceId, agentId)
        const run = await agentRuntime.startAgent(
          workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
          agentId,
          { gachiPort: '' }
        )
        workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
      },
    },
    // R4 deploy hooks: per-workspace command from app-state, executed after
    // a successful worktree merge-back.
    deployHook: {
      getCommand: (workspaceId) => readDeployHookCommand(settings, workspaceId),
    },
    cancelOpenDispatches: (workspaceId, agentId, reason) => {
      dispatchLedgerStore.cancelOpenForAgent(workspaceId, agentId, reason)
    },
  }
  runtimeSupervisor = createRuntimeSupervisor(supervisorDeps)
  // Push-first channel for worker report notifications to the orchestrator:
  // immediate PTY injection with a bounded queued retry on the heartbeat tick.
  const orchestratorInbox = createOrchestratorInbox()
  const flushOrchestratorInbox = (workspaceId: string) =>
    orchestratorInbox.flush(
      workspaceId,
      (payload) => agentRuntime.writeOrchestratorPrompt?.(workspaceId, payload) ?? false
    )
  const teamOps = createTeamOperations({
    bindRunTask: (workspaceId, agentId, taskId) => {
      const run = runtimeSupervisor.getAgentRun(workspaceId, agentId)
      if (run) runtimeSupervisor.bindTask(run.id, taskId)
    },
    agentRuntime,
    createDispatch: dispatchLedgerStore.createDispatch,
    deleteDispatch: dispatchLedgerStore.deleteDispatch,
    deleteDispatchForced: (input) =>
      dispatchLedgerStore.forceCancel({
        id: input.id,
        reason: input.reason,
        workspaceId: input.workspaceId,
      }),
    deleteMessage: messageLogStore.deleteMessage,
    findOpenDispatch: dispatchLedgerStore.findOpenDispatch,
    findOpenDispatchById: dispatchLedgerStore.findOpenDispatchById,
    insertMessage: messageLogStore.insertMessage,
    markDispatchCancelled: dispatchLedgerStore.markCancelled,
    markDispatchDelivered: dispatchLedgerStore.markDelivered,
    markDispatchReportedByWorker: dispatchLedgerStore.markReportedByWorker,
    markDispatchSubmitted: dispatchLedgerStore.markSubmitted,
    recordHeartbeat: (workspaceId, agentId, phase) => {
      agentHeartbeatStore.record(workspaceId, agentId, {
        phase,
        status: 'working',
      })
    },
    onWorkerReleased: (workspaceId) => {
      void dispatchAllWorkspaceTasks(workspaceId).catch((error) =>
        console.error('[DISPATCH] dispatch after worker released failed:', error)
      )
    },
    pushOrchestratorUpdate: (workspaceId, payload) => {
      orchestratorInbox.submit(workspaceId, payload)
      flushOrchestratorInbox(workspaceId)
    },
    transitionLifecycle: agentLifecycleStore.transition,
    workerOutputTracker,
    workspaceStore,
  })
  startExistingWorkspaceWatches()

  // Breaker auto-resume: the cooldown elapsed — clear the pause and halve the
  // failure streak so repeated breaches re-trip on the escalation ladder.
  const resumeDispatchAfterCooldown = (workspaceId: string): void => {
    settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`, '0')
    settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${workspaceId}`, '0')
    runtimeSupervisor?.softenErrorBudget(workspaceId)
    console.warn(`[BREAKER] ws ${workspaceId.slice(0, 8)}: cooldown elapsed — dispatch resumed`)
    // Telegram is best-effort — the console warn already happened.
    telegramService
      .notifyOrchestratorReply(
        `▶️ Circuit breaker: cooldown elapsed on ${workspaceId.slice(0, 8)} — dispatch resumed`
      )
      .catch(() => {})
    runtimeEventBus.emit(workspaceId, {
      type: 'QUEUE_UPDATED',
      payload: { taskCount: taskStore.listTasks(workspaceId).length },
    })
  }

  dispatchAllWorkspaceTasks = async (workspaceId) => {
    // Reap `running` tasks whose owner process died before they could settle, so
    // they return to `ready` immediately instead of blocking the worker and
    // triggering recovery restarts minutes later.
    reapDeadRunningTasks(workspaceId, {
      getActiveRunByAgentId: (id, agentId) => agentRuntime.getActiveRunByAgentId(id, agentId),
      getHeartbeat: (id, agentId) => agentHeartbeatStore.get(id, agentId),
      isHeartbeatStale: (id, agentId, maxAgeMs, at) =>
        agentHeartbeatStore.isStale(id, agentId, maxAgeMs, at),
      listTasks: (id) => taskStore.listTasks(id),
      releaseTask: (id, taskId, reason) => taskStore.releaseTask(id, taskId, reason),
    })
    routeReadyReviewTasks({
      dispatch: (id, workerId, text) =>
        teamOps.dispatchTask(id, workerId, text, {
          fromAgentId: `${id}:orchestrator`,
          gachiPort: '',
        }),
      getAgents: (id) => workspaceStore.getWorkspaceSnapshot(id).agents,
      workspaceId,
    })
    await dispatchReadyKanbanTasks(workspaceId, {
      canStartWorker: (id, workerId) => Boolean(agentRuntime.peekAgentLaunchConfig(id, workerId)),
      // R3.2: rolling health from persisted runs steers auto-selection toward
      // reliable workers (neutral when there is no terminal history yet).
      getWorkerHealth: (_id, workerId) =>
        rollingSuccessRate(
          agentRunStore.listAgentRuns(workerId).map((run) => ({
            exitCode: run.exitCode,
            status: run.status,
          }))
        ),
      dispatch: (id, workerId, text) =>
        teamOps.dispatchTask(id, workerId, text, {
          fromAgentId: `${id}:orchestrator`,
          gachiPort: '',
        }),
      getAgents: (id) => workspaceStore.getWorkspaceSnapshot(id).agents,
      isWorkerActive: (id, workerId) => Boolean(agentRuntime.getActiveRunByAgentId(id, workerId)),
      // Dispatch gate: the global memory hold (auto-resumed by the watchdog),
      // or the error-budget breaker — which auto-resumes once its cooldown
      // elapses. A legacy flag written before the breaker (no deadline) also
      // counts as elapsed, so it self-clears on the first tick.
      isDispatchPaused: (id) => {
        if (isMemoryHoldActive(settings)) return true
        if (settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${id}`)?.value !== '1') return false
        if (isBreakerCoolingDown(settings, id, Date.now())) return true
        resumeDispatchAfterCooldown(id)
        return false
      },
    })
  }

  // Startup recovery: restore runs whose process survived a restart, fail the
  // rest, requeue their tasks and free their agents so nothing stays stuck.
  runNowOrDefer(() => {
    runtimeSupervisor.reconcile()

    // Kick the dispatcher immediately at boot so already-`ready` tasks reach
    // workers without waiting for the first heartbeat tick (which defaults to up
    // to 2 minutes). Previously those tasks sat idle until the first tick.
    for (const workspace of workspaceStore.listWorkspaces()) {
      void dispatchAllWorkspaceTasks(workspace.id).catch((error) =>
        console.error('[BOOT] initial dispatch failed:', error)
      )
    }
  })

  // The bound HTTP port is injected after listen (gachi.ts) so heartbeat-driven
  // orchestrator restarts can hand agents a working GACH_PORT.
  let runtimeGachiPort = ''
  const orchestratorSelfHeal = createOrchestratorSelfHeal({
    hasActiveRun: (wsId, orchestratorId) =>
      Boolean(agentRuntime.getActiveRunByAgentId(wsId, orchestratorId)),
    autostart: (wsId) =>
      autostartOrchestrator(
        {
          startAgent: async (agentWsId, agentId, input) => {
            const workspace = workspaceStore.getWorkspaceSnapshot(agentWsId)
            const run = await agentRuntime.startAgent(workspace.summary, agentId, {
              gachiPort: input.gachiPort,
            })
            return { runId: run.runId, status: run.status, exitCode: run.exitCode }
          },
          getLiveRun: (runId) => {
            const run = agentRuntime.getLiveRun(runId)
            return { status: run.status, exitCode: run.exitCode }
          },
          peekAgentLaunchConfig: agentRuntime.peekAgentLaunchConfig,
        },
        wsId,
        `${wsId}:orchestrator`,
        runtimeGachiPort
      ),
  })
  const ensureOrchestratorRunning = orchestratorSelfHeal

  const orchestratorHeartbeat = createOrchestratorHeartbeat({
    dispatchReadyTasks: dispatchAllWorkspaceTasks,
    flushPendingNotifications: flushOrchestratorInbox,
    ensureOrchestratorRunning,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    getIntervalMs: () => readHeartbeatIntervalMs(settings),
    listWorkspaces: workspaceStore.listWorkspaces,
    writeHeartbeatPrompt: (workspaceId) => {
      // Heartbeat summaries are injected prompts: the orchestrator's reply is
      // not real work, so don't let it reset idle recovery.
      workerOutputTracker?.notePromptInjection(workspaceId, `${workspaceId}:orchestrator`)
      return agentRuntime.writeHeartbeatPrompt(workspaceId)
    },
    // Non-blocking health: an agent is "free" only when it has produced no
    // PTY output for `HEARTBEAT_QUIET_WINDOW_MS`. The old implementation
    // sampled stdout length over a blocking 400ms sleep; heartbeats replace
    // that entirely (see AGENTS.md: do not use stdout as health).
    isOrchestratorFree: (workspaceId) => {
      const orchestratorId = `${workspaceId}:orchestrator`
      const active = agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)
      if (!active) return true
      const heartbeat = agentHeartbeatStore.get(workspaceId, orchestratorId)
      if (!heartbeat) return true
      return agentHeartbeatStore.isStale(workspaceId, orchestratorId, HEARTBEAT_QUIET_WINDOW_MS)
    },
  })

  const isAgentQuiet = (workspaceId: string, agentId: string) => {
    const active = agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (!active) return false
    const heartbeat = agentHeartbeatStore.get(workspaceId, agentId)
    if (!heartbeat) return false
    return agentHeartbeatStore.isStale(workspaceId, agentId, HEARTBEAT_QUIET_WINDOW_MS)
  }

  const workerReportNudge = createWorkerReportNudge({
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    listWorkspaces: workspaceStore.listWorkspaces,
    writeWorkerReportNudge: (workspaceId, agentId, payload) => {
      // The nudge is an injected prompt: the worker's acknowledgement is not
      // real work, so don't let it reset idle recovery for the nudged agent.
      workerOutputTracker?.notePromptInjection(workspaceId, agentId)
      agentRuntime.writeWorkerReportNudge(workspaceId, agentId, payload)
    },
    markTaskReported: workspaceStore.markTaskReported,
    reinjectUndeliveredDispatch: (workspaceId, agentId, minAgeMs) =>
      teamOps.reinjectUndeliveredDispatch(workspaceId, agentId, minAgeMs),
    hasActiveRun: (wsId, agId) => Boolean(agentRuntime.getActiveRunByAgentId(wsId, agId)),
    isAgentQuiet,
    dispatchReadyTasks: dispatchAllWorkspaceTasks,
  })

  const writeRunInput = (runId: string, input: Buffer | string) => {
    if (!options.agentManager) throw new Error('Agent manager is required for PTY stdin writes')
    if (shellRuntime.hasRun(runId)) {
      shellRuntime.writeInput(runId, input)
      return
    }
    options.agentManager.writeInput(runId, input)
  }

  // Telegram interface (spec Part 3): pairing/links/approvals are durable in
  // SQLite; polling starts only when a token is configured AND enabled.
  const telegramLinks = createTelegramLinksStore(db)
  // Approval TTL is configurable via settings (`approval_ttl_ms`, min 10s);
  // expirations are surfaced to the wiring layer so the waiting worker gets an
  // explicit `PERMISSION EXPIRED` verdict instead of hanging (audit M-4).
  let approvalExpiredHandler: ((requests: ApprovalRequest[]) => void) | null = null
  const approvalTtlMs = (): number => {
    const raw = settings.getAppState('approval_ttl_ms')?.value
    const parsed = raw ? Number(raw) : Number.NaN
    return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : APPROVAL_TTL_MS
  }
  const approvalStore = createApprovalStore(
    db,
    { onExpired: (requests) => approvalExpiredHandler?.(requests) },
    approvalTtlMs
  )
  // T1 morning digest: aggregate the last 24h across workspaces.
  const DAY_MS = 24 * 60 * 60_000
  const buildDailyDigest = (): string => {
    const since = Date.now() - DAY_MS
    const lines: string[] = []
    let totalDone = 0
    let totalFailed = 0
    let totalTokens = 0
    let stallCount = 0
    let riskCount = 0
    for (const workspace of workspaceStore.listWorkspaces()) {
      const name = workspace.name ?? workspace.id.slice(0, 8)
      const tasks = taskStore.listTasks(workspace.id)
      const done = tasks.filter((task) => task.status === 'done' && (task.finishedAt ?? 0) >= since)
      const failed = tasks.filter((task) => task.status === 'failed')
      let stall = 0
      let risk = 0
      for (const task of tasks) {
        for (const line of task.logs ?? []) {
          if (line.includes('[STALL')) stall += 1
          if (line.includes('[RISK]')) risk += 1
        }
      }
      stallCount += stall
      riskCount += risk
      totalDone += done.length
      totalFailed += failed.length
      const metrics = usageStore.workspaceMetrics(workspace.id, DAY_MS)
      const tokens = metrics.agents.reduce((sum, agent) => sum + (agent.lastTokensUsed ?? 0), 0)
      totalTokens += tokens
      lines.push(
        `• ${name}: done ${done.length}, failed ${failed.length}` +
          (stall > 0 ? `, stalls ${stall}` : '') +
          (risk > 0 ? `, risks ${risk}` : '') +
          (tokens > 0 ? `, ~${tokens.toLocaleString('en-US')} tok` : '')
      )
    }
    const header =
      totalDone + totalFailed === 0
        ? 'No task outcomes in the last 24h.'
        : `Last 24h: ✅ ${totalDone} done, ❌ ${totalFailed} failed`
    return [
      header,
      ...lines,
      totalTokens > 0 ? `Tokens: ~${totalTokens.toLocaleString('en-US')}` : '',
      stallCount + riskCount > 0
        ? '⚠️ Escalations present — check [STALL]/[RISK] entries on the board.'
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const telegramService = createTelegramService({
    approvals: approvalStore,
    links: telegramLinks,
    settings,
    addTaskLog: taskStore.addLog,
    cancelTaskById: (workspaceId, taskId) => {
      try {
        teamOps.cancelTaskById(workspaceId, taskId, {
          fromAgentId: `${workspaceId}:orchestrator`,
          reason: 'canceled from Telegram',
        })
        return true
      } catch {
        return false
      }
    },
    getActiveRunByAgentId: (workspaceId, agentId) =>
      agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    getWorkspaceName: (workspaceId) => {
      try {
        return workspaceStore.getWorkspaceSnapshot(workspaceId).summary.name
      } catch {
        return undefined
      }
    },
    listWorkspaceIds: () => workspaceStore.listWorkspaces().map((workspace) => workspace.id),
    listWorkers: (workspaceId) =>
      workspaceStore.listWorkers(workspaceId).map((worker) => ({
        name: worker.name,
        status: worker.status,
      })),
    sendToOrchestrator: (workspaceId, text) => {
      // Honest delivery: `false` means the orchestrator PTY is not writable —
      // Telegram queues the message instead of claiming success.
      return teamOps.recordUserInput(workspaceId, `${workspaceId}:orchestrator`, text)
    },
    writeRunInput,
    // T1 morning digest: 24h outcomes, token spend, escalations, commits.
    getDailyDigest: () => buildDailyDigest(),
  })
  telegramService.start()

  // T1 Autonomy Loop: workspace schedules create work on their own. A 30s
  // tick checks every `schedule_<wsId>` rule, respects the anti-flood
  // marker and persists last-fired timestamps across restarts.
  const SCHEDULE_TICK_MS = 30_000
  const runScheduleTick = (): void => {
    try {
      for (const ws of workspaceStore.listWorkspaces()) {
        const config = readSchedule(settings, ws.id)
        if (!config) continue
        if (!isScheduleDue(config, readLastFiredAt(settings, ws.id), Date.now())) continue
        const marker = scheduledMarker(ws.id)
        if (hasOpenScheduledTask(taskStore.listTasks(ws.id), marker)) continue

        const input = buildScheduledTaskInput(config, ws.id)
        const created = taskStore.createTask(ws.id, { status: 'ready', ...input })
        taskStore.addLog(
          ws.id,
          created.id,
          `[SCHEDULED] auto-created by ${SCHEDULE_KEY_PREFIX}${ws.id}`
        )
        writeLastFiredAt(settings, ws.id, Date.now())
        console.log(`[SCHEDULE] fired "${created.title}" for ${ws.id.slice(0, 8)}`)
        void dispatchAllWorkspaceTasks(ws.id).catch((error) =>
          console.error('[SCHEDULE] dispatch after fire failed:', error)
        )
      }
    } catch (error) {
      console.error('[SCHEDULE] tick failed:', error)
    }
  }
  const scheduleTimer = setInterval(runScheduleTick, SCHEDULE_TICK_MS)
  scheduleTimer.unref?.()

  // T2 Review Autopilot: every 60s, per opted-in workspace, list open PRs
  // via `gh` and hand new/updated heads to a worker as review cards.
  const runAutopilotTick = (): void => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      const mode = readAutopilotMode(settings, workspace.id)
      if (mode === 'off') continue
      let wsPath: string
      try {
        wsPath = workspaceStore.getWorkspaceSnapshot(workspace.id).summary.path
      } catch {
        continue
      }
      let prs: OpenPrSummary[]
      try {
        prs = listOpenPrs(wsPath)
      } catch {
        continue
      }
      const seen = readSeenMap(settings, workspace.id)
      const limit = readRoundsLimit(settings, workspace.id)
      const openTasks = taskStore.listTasks(workspace.id)
      for (const candidate of selectPrsToReview(prs, seen, limit)) {
        if (hasOpenAutopilotTask(openTasks, workspace.id, candidate.number)) continue
        const input = buildPrReviewTaskInput({
          mode,
          pr: { number: candidate.number, title: candidate.title, url: candidate.url },
          reReview: candidate.reReview,
          workspaceId: workspace.id,
        })
        const created = taskStore.createTask(workspace.id, {
          requiredSkills: ['code-review'],
          status: 'ready',
          ...input,
        })
        taskStore.addLog(
          workspace.id,
          created.id,
          `[PR AUTOPILOT] queued review of #${candidate.number} (${mode}${candidate.reReview ? ', re-review' : ''})`
        )
        console.log(`[PR AUTOPILOT] ws ${workspace.id.slice(0, 8)} → review #${candidate.number}`)
        seen[String(candidate.number)] = {
          rounds: (seen[String(candidate.number)]?.rounds ?? 0) + 1,
          sha: candidate.headSha ?? candidate.head,
        }
      }
      writeSeenMap(settings, workspace.id, seen)
    }
  }
  const AUTOPILOT_TICK_MS = 60_000
  const autopilotTimer = setInterval(runAutopilotTick, AUTOPILOT_TICK_MS)
  autopilotTimer.unref?.()

  // Memory watchdog: 10+ engine processes can exhaust the machine's memory —
  // historically that killed the daemon (and Chrome tabs) silently. On low
  // memory the watchdog holds FRESH dispatch globally (running tasks stay
  // untouched) and auto-resumes with hysteresis. On the same tick it samples
  // every live idle engine's RSS and, per opted-in workspace, session-resume
  // restarts ballooned workers between tasks.
  const memoryWatchdog = createMemoryWatchdog({
    settings,
    listWorkspaceIds: () => workspaceStore.listWorkspaces().map((workspace) => workspace.id),
    emitQueueUpdated: (workspaceId) => {
      runtimeEventBus.emit(workspaceId, {
        type: 'QUEUE_UPDATED',
        payload: { taskCount: taskStore.listTasks(workspaceId).length },
      })
    },
    notify: (text) => {
      // Telegram is best-effort; a sync try/catch cannot catch an async
      // rejection, so attach .catch instead.
      telegramService.notifyOrchestratorReply(text).catch(() => {})
    },
    listRotationCandidates: () =>
      workspaceStore.listWorkspaces().flatMap((workspace) =>
        workspaceStore
          .getWorkspaceSnapshot(workspace.id)
          .agents.filter((agent) => agent.role !== 'orchestrator' && agent.status === 'idle')
          .flatMap((agent): RotationCandidate[] => {
            if (taskStore.getAssignedTaskForWorker(workspace.id, agent.id)) return []
            if (taskStore.getAssignedTaskForWorker(workspace.id, agent.name)) return []
            const run = agentRuntime.getActiveRunByAgentId(workspace.id, agent.id)
            if (!run?.pid) return []
            if (!agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)) return []
            return [
              {
                agentId: agent.id,
                name: agent.name,
                pid: run.pid,
                startedAt: run.startedAt,
                workspaceId: workspace.id,
              },
            ]
          })
      ),
    restartWorker: async (workspaceId, agentId) => {
      // Same release-then-relaunch pipeline as the crash auto-restart: awaited
      // PTY exit, persisted launch config, empty gachiPort, output tracker
      // re-attach. Session resume happens inside startAgent via the session
      // store, so rotation keeps the worker's context.
      const activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
      if (activeRun) {
        runtimeSupervisor.stopAgent(activeRun.runId)
        await agentRuntime.waitForAgentRunExit(activeRun.runId)
      }
      if (!agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)) {
        throw new Error(`No launch config for @${agentId} — cannot rotate`)
      }
      agentLifecycleStore.transition(workspaceId, agentId, 'starting', {
        error: null,
        reason: 'memory_rotation',
        runId: null,
      })
      workspaceStore.markAgentStarted(workspaceId, agentId)
      const run = await agentRuntime.startAgent(
        workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        agentId,
        { gachiPort: '' }
      )
      workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
    },
  })

  // Usage limit warning → Telegram (Discovery spec §7). The telemetry layer
  // owns edge detection + cooldowns; here we only format and fan out.
  usageWarningHandler = (workspaceId, agentId, contextPercent) => {
    const workerName = workspaceStore.getWorker(workspaceId, agentId)?.name ?? agentId.slice(0, 8)
    const workspaceName = (() => {
      try {
        return workspaceStore.getWorkspaceSnapshot(workspaceId).summary.name
      } catch {
        return workspaceId.slice(0, 8)
      }
    })()
    void telegramService
      .notifyEvent(
        'usage_limit_warning',
        workspaceId,
        `⚠️ Контекст @${workerName} (${workspaceName}): ${contextPercent}% использовано. Приближается авто-компакция.`
      )
      .catch(() => {})
  }

  // Orchestrator replies → paired Telegram chats ([TG_REPLY] bridge). Direct
  // channel on purpose: replies are part of an explicit dialogue, not a
  // notification, so event preferences must not gate them.
  tgReplyForwarder = createTgReplyLineForwarder((text) => {
    void telegramService.notifyOrchestratorReply(text).catch(() => {})
  })

  // R2.2 plan drafts: pending groups requested via draftPlanFromGoal; the
  // capture turns the orchestrator's [PLAN_*] reply into backlog cards.
  interface PendingPlan {
    workspaceId: string
    goal: string
    createdAt: number
  }
  const pendingPlanGroups = new Map<string, PendingPlan>()
  /** Ordinal → created task id, per group (deps reference backward positions). */
  const planGroupOrdinalIds = new Map<string, string[]>()
  const planCapture = createPlanDraftCapture({
    isPending: (groupId) => {
      const pending = pendingPlanGroups.get(groupId)
      if (!pending) return false
      // Stale requests (orchestrator never answered in 10 min) expire.
      if (Date.now() - pending.createdAt > 10 * 60_000) {
        pendingPlanGroups.delete(groupId)
        planGroupOrdinalIds.delete(groupId)
        return false
      }
      return true
    },
    createTask: (groupId, task) => {
      const meta = pendingPlanGroups.get(groupId)
      if (!meta) return false
      const ids = planGroupOrdinalIds.get(groupId) ?? []
      const dependencies = task.dependencyOrdinals
        .map((ordinal) => ids[ordinal - 1])
        .filter((id): id is string => Boolean(id))
      try {
        const record = taskStore.createTask(meta.workspaceId, {
          title: task.title,
          description: task.description,
          dependencies,
          requiredSkills: task.requiredSkills,
          role: task.role,
          planGroupId: groupId,
          plannedAt: meta.createdAt,
        })
        ids.push(record.id)
        planGroupOrdinalIds.set(groupId, ids)
        return true
      } catch {
        return false
      }
    },
    finish: (groupId, acceptedCount) => {
      const meta = pendingPlanGroups.get(groupId)
      if (!meta) return
      console.log(
        `[PLAN] draft ready for ${meta.workspaceId.slice(0, 8)}: ${acceptedCount} tasks (group ${groupId.slice(0, 8)})`
      )
      runtimeEventBus.emit(meta.workspaceId, {
        type: 'RUN_PROGRESS',
        payload: {
          agentId: 'plan',
          line: `[PLAN] draft ready: ${acceptedCount} tasks awaiting approval`,
        },
      })
    },
  })

  // Auto-unblock (user request): scan live PTY tails for permission dialogs
  // and send Enter. Builtin engines are bypass-by-design; residual TUI
  // prompts (folder trust, update nag) freeze workers — this clears them
  // without human intervention.
  if (options.agentManager) {
    // Shared target list for the responder and the stall scanner: live
    // worker runs with a recent PTY tail, tagged with ws/agent coordinates.
    const listLiveWorkerTargets = (): Array<{
      runId: string
      workspaceId: string
      agentId: string
      tail: string
    }> => {
      const targets: Array<{
        runId: string
        workspaceId: string
        agentId: string
        tail: string
      }> = []
      try {
        for (const ws of workspaceStore.listWorkspaces()) {
          for (const agent of workspaceStore.getWorkspaceSnapshot(ws.id).agents) {
            if (agent.role === 'orchestrator') continue
            const run = agentRuntime.getActiveRunByAgentId(ws.id, agent.id)
            if (!run || run.status !== 'running') continue
            try {
              const manager = options.agentManager
              if (!manager) continue
              const snap = manager.getRun(run.runId)
              targets.push({
                agentId: agent.id,
                runId: run.runId,
                tail: snap.output.slice(-2000),
                workspaceId: ws.id,
              })
            } catch {
              // Run record may have been cleaned up.
            }
          }
        }
      } catch {
        // Best-effort diagnostics.
      }
      return targets
    }

    const unblocker = createPromptAutoResponder({
      getTargets() {
        // R10: `ask` permission mode — dialogs stay for the human, the
        // autoresponder must not answer them.
        return listLiveWorkerTargets()
          .filter((target) => readPermissionMode(settings, target.workspaceId) !== 'ask')
          .map((target) => ({ runId: target.runId, tail: target.tail }))
      },
      sendEnter(runId) {
        writeRunInput(runId, '\r')
      },
      onUnblocked(runId, attempt) {
        console.log(`[AUTO-UNBLOCK] sent Enter to ${runId.slice(0, 8)} (#${attempt})`)
      },
    })
    autoUnblock.stop = unblocker.stop

    // R10 stall scanner: a LIVE worker stuck on a rate limit / quota / auth
    // prompt / unanswered dialog looks productive to everyone. Escalate each
    // fresh signal straight into the orchestrator's PTY (plus task journal
    // and lifecycle) so the swarm does not silently stall.
    const stallScanner = createAgentStallScanner({
      getTargets: () => listLiveWorkerTargets(),
      onStall(event) {
        const label = event.agentId.split(':').pop() ?? event.agentId
        console.warn(
          `[STALL] ${event.category} @${label} (${event.workspaceId.slice(0, 8)}): ${event.detail}`
        )
        try {
          agentLifecycleStore.transition(event.workspaceId, event.agentId, 'waiting_input', {
            reason: `stall:${event.category}`,
          })
        } catch {
          // Transition may be illegal from the current state — the journal
          // and orchestrator notice below still fire.
        }
        try {
          const stallTask = taskStore.getAssignedTaskForWorker(event.workspaceId, event.agentId)
          if (stallTask) {
            taskStore.addLog(
              event.workspaceId,
              stallTask.id,
              `[STALL ${event.category}] ${event.detail}`
            )
          }
        } catch {}
        orchestratorInbox.submit(
          event.workspaceId,
          [
            `[Gachi system message] Worker @${label} is NOT making progress (${event.category}).`,
            `Evidence: ${event.detail}`,
            'It needs your decision: check team list, fix the blocker, re-send, rework or cancel its task. Do not assume it is working.',
          ].join(' ')
        )
        flushOrchestratorInbox(event.workspaceId)
      },
    })
    autoUnblock.stop = (() => {
      const previous = autoUnblock.stop
      return () => {
        previous()
        stallScanner.stop()
      }
    })()
  }

  // Approval TTL expiry: deliver an explicit verdict to the waiting worker's
  // PTY and journal, mirroring decideApprovalInternal (audit M-4).
  approvalExpiredHandler = (requests) => {
    for (const request of requests) {
      const verdictLine = `[Gachi system message: permission EXPIRED] command: ${request.command}${
        request.reason ? ` (reason: ${request.reason})` : ''
      }`
      try {
        const run = agentRuntime.getActiveRunByAgentId(request.workspaceId, request.agentId)
        if (run) writeRunInput(run.runId, `${verdictLine}\n`)
      } catch (error) {
        console.error(
          '[APPROVALS] expired PTY write failed:',
          error instanceof Error ? error.message : error
        )
      }
      if (request.taskId) {
        try {
          taskStore.addLog(
            request.workspaceId,
            request.taskId,
            `[APPROVAL EXPIRED] ${request.command} (${request.id.slice(0, 8)}) — TTL истёк, запрос отменён`
          )
        } catch {
          // Journal entry is best-effort; the durable expiry is already stored.
        }
      }
    }
    void telegramService
      .notifyEvent(
        'approval_decided',
        requests[0]?.workspaceId ?? '',
        `⏰ Expired: ${requests.length} permission request(s) timed out without a decision.`
      )
      .catch(() => {})
  }

  // Fan runtime events out to paired Telegram chats (spec Part 3 §Events).
  runtimeEventBus.subscribe((workspaceId, event) => {
    if (!['TASK_COMPLETED', 'TASK_FAILED', 'AGENT_STUCK', 'AGENT_RECOVERED'].includes(event.type)) {
      return
    }
    const eventType =
      event.type === 'TASK_COMPLETED'
        ? 'task_completed'
        : event.type === 'TASK_FAILED'
          ? 'task_failed'
          : event.type === 'AGENT_STUCK'
            ? 'agent_stuck'
            : 'agent_recovered'
    const payload = event.payload as { title?: string; taskId?: string; status?: string }
    // TASK_COMPLETED fires for both `review` (worker handed work in) and
    // `done` (reviewer approved). Telegram should only announce the terminal
    // state — otherwise every reviewed task notifies twice.
    if (eventType === 'task_completed' && payload.status === 'review') return
    void telegramService
      .notifyEvent(
        eventType,
        workspaceId,
        `${event.type}: #${payload.taskId ? payload.taskId.slice(0, 8) : '?'} ${payload.title ?? ''}`.trim()
      )
      .catch((error) =>
        console.error('[TELEGRAM] notify failed:', error instanceof Error ? error.message : error)
      )
  })

  return {
    agentHeartbeatStore,
    agentLifecycleStore,
    agentRunRecordStore,
    agentRunStore,
    agentRuntime,
    writeRunInput,
    agentSessionStore,
    approvalStore,
    usageStore,
    forgetTaskStatusesForWorkspace,
    db,
    dispatchAllWorkspaceTasks,
    runScheduleTick,
    memoryWatchdog,
    dispatchLedgerStore,
    eventLog,
    messageLogStore,
    orchestratorHeartbeat,
    registerAutoCompactHandler: (handler) => {
      autoCompactHandler = handler
    },
    setRuntimePort: (port: string) => {
      runtimeGachiPort = port
    },
    /** Auto-unblock timer cleanup (prompt-autoresponder). */
    autoUnblockStop: () => {
      autoUnblock.stop?.()
    },
    telegramLinks,
    telegramService,
    workerReportNudge,
    settings,
    shellRuntime,
    runtimeEventBus,
    runtimeSupervisor,
    tasksFileWatcher,
    tasksFileWatchCallbacks,
    tasksFileService,
    teamOps,
    telemetry,
    draftPlanFromGoal: (workspaceId, goal) => {
      const orchestratorId = `${workspaceId}:orchestrator`
      const active = agentRuntime.getActiveRunByAgentId(workspaceId, orchestratorId)
      if (!active) {
        return { accepted: false as const, reason: 'orchestrator is not running' }
      }
      const groupId = crypto.randomUUID()
      pendingPlanGroups.set(groupId, { workspaceId, goal, createdAt: Date.now() })
      try {
        writeRunInput(active.runId, buildPlannerPrompt(goal, groupId))
      } catch (error) {
        pendingPlanGroups.delete(groupId)
        return {
          accepted: false as const,
          reason: error instanceof Error ? error.message : 'PTY write failed',
        }
      }
      return { accepted: true as const, groupId }
    },
    uiAuth,
    workerOutputTracker,
    workspaceStore,
    runStartupRecovery: () => {
      for (const step of deferredRecoverySteps.splice(0)) step()
    },
    softenErrorBudget: (workspaceId) => runtimeSupervisor.softenErrorBudget(workspaceId),
    tailEvents: (workspaceId: string, options?: TailEventLogOptions) =>
      eventLog.tail(workspaceId, options),
    agentEvents: (
      workspaceId: string,
      agentId: string,
      options?: Omit<TailEventLogOptions, 'agentId'>
    ) => eventLog.tail(workspaceId, { ...options, agentId }),
  }
}

export const createRuntimeStoreLifecycle = ({
  agentManager,
  services,
}: CreateRuntimeStoreLifecycleOptions) => {
  const stopAgentAndWait = async (runId: string) => {
    // Mark the run as operator-initiated BEFORE the kill. Without this the PTY
    // exit handler reads the lifecycle (still `working`/`ready`) and classifies
    // the kill as a crash — the worker lifecycle lands on `failed` instead of
    // `stopped` and every stop+start burns a workspace failure streak until the
    // error-budget breaker trips.
    const live = services.agentRuntime.getLiveRun(runId)
    if (live) {
      const agentId = live.agentId
      const workspaceId = services.workspaceStore
        .listWorkspaces()
        .find((workspace) => services.workspaceStore.hasAgent(workspace.id, agentId))?.id
      if (workspaceId) {
        const currentState = services.agentLifecycleStore.get(workspaceId, agentId)?.state
        if (
          currentState &&
          canTransitionAgentLifecycle(currentState, 'stopping') &&
          currentState !== 'stopping'
        ) {
          services.agentLifecycleStore.transition(workspaceId, agentId, 'stopping', {
            reason: 'stop_requested',
            runId,
          })
        }
      }
    }
    services.agentRuntime.stopAgentRun(runId)
    await services.agentRuntime.waitForAgentRunExit(runId)
  }
  // Auto-compact policy (control-plane spec §6/§13 + token budget): fires on a
  // context-percent threshold OR an absolute token budget (app-state
  // `auto_compact_tokens`), then writes the engine's /compact into the PTY.
  // Engines without a compact command are skipped.
  services.registerAutoCompactHandler((workspaceId, agentId, info) => {
    const active = services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (!active) return
    const config = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
    const adapter = getEngineAdapter(config?.interactiveCommand ?? config?.command)
    const compactCommand = adapter
      ? getEngineControlProfile(adapter.id)?.contextCommands.compact
      : undefined
    if (!compactCommand) return
    const triggerLine =
      info.trigger === 'tokens'
        ? `[POLICY] tokens ${info.tokensUsed?.toLocaleString() ?? '?'} ≥ budget — auto-compact triggered`
        : `[POLICY] context ${info.contextPercent}% — auto-compact triggered`
    const usageLabel =
      info.trigger === 'tokens' ? `tokens ${info.tokensUsed}` : `context ${info.contextPercent}%`
    console.log(`[POLICY] ${usageLabel} — writing ${compactCommand} for @${agentId}`)
    // Этап 4: journal the guard action into the worker's current card so the
    // timeline shows WHY the engine suddenly compacts.
    const journalLine =
      info.trigger === 'tokens'
        ? `[CONTEXT] compact requested (tokens ${info.tokensUsed?.toLocaleString() ?? '?'} ≥ budget)`
        : `[CONTEXT] compact requested (${info.contextPercent ?? '?'}%)`
    const card =
      taskStore.getAssignedTaskForWorker(workspaceId, agentId) ??
      taskStore.getAssignedTaskForWorker(workspaceId, agentId.split(':').pop() ?? agentId)
    if (card) taskStore.addLog(workspaceId, card.id, journalLine)
    try {
      // Same dispatch seam as runContextAction: paste + delayed separate CR —
      // a raw write can be eaten by a mid-render TUI and never submits.
      services.agentRuntime.writeInteractiveInput(workspaceId, agentId, compactCommand)
      services.runtimeEventBus.emit(workspaceId, {
        type: 'RUN_PROGRESS',
        payload: { agentId, line: triggerLine },
      })
    } catch (error) {
      console.error(
        '[POLICY] auto-compact write failed:',
        error instanceof Error ? error.message : error
      )
    }
  })
  const agentControl = createAgentControl({
    agentRuntime: services.agentRuntime,
    emitEvent: (workspaceId, event) => {
      services.runtimeEventBus.emit(workspaceId, event)
    },
    getLastSessionId: services.agentSessionStore.getLastSessionId,
    startAgentRun: (workspaceId, agentId, input) => startAgent(workspaceId, agentId, input),
    stopAgentGracefully: async (runId) => {
      // Same release pipeline as the UI stop path (supervisor owns settle +
      // agent release), but awaited so a relaunch starts from a clean exit.
      services.runtimeSupervisor.stopAgent(runId)
      await services.agentRuntime.waitForAgentRunExit(runId)
    },
    telemetry: services.telemetry,
    writeRunInput: services.writeRunInput,
    writeInteractiveInput: (workspaceId, agentId, text) =>
      services.agentRuntime.writeInteractiveInput(workspaceId, agentId, text),
  })
  const startAgent = async (
    workspaceId: string,
    agentId: string,
    input: { gachiPort: string }
  ): Promise<LiveAgentRun> => {
    services.workspaceStore.getAgent(workspaceId, agentId)
    // Idempotent start: if the worker already owns a live run (the UI/CLI
    // retried `start` while the PTY sits in `working`/`waiting_input`), return
    // it instead of re-transitioning — `waiting_input -> starting` is not a
    // legal lifecycle transition and used to 500 every double-start.
    const existingRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
    if (existingRun) return existingRun
    const currentState = services.agentLifecycleStore.get(workspaceId, agentId)?.state
    if (currentState === 'stopping') {
      // A previous stop pipeline died before completing (daemon killed
      // mid-stop, PTY exit never observed) — `stopping -> starting` is not a
      // legal transition, so settle the stale state first or every restart
      // attempt would throw forever.
      services.agentLifecycleStore.transition(workspaceId, agentId, 'stopped', {
        error: null,
        reason: 'stale_stopping_resolved',
        runId: null,
      })
    }
    services.agentLifecycleStore.transition(workspaceId, agentId, 'starting', {
      error: null,
      reason: 'start_requested',
      runId: null,
    })
    services.workspaceStore.markAgentStarted(workspaceId, agentId)
    const startingAgent = services.workspaceStore.getAgent(workspaceId, agentId)
    services.runtimeEventBus.emit(workspaceId, {
      type: 'AGENT_STATUS_CHANGED',
      payload: {
        agentId,
        name: startingAgent?.name ?? agentId,
        role: startingAgent?.role ?? 'custom',
        status: 'working',
      },
    })
    services.agentHeartbeatStore.record(workspaceId, agentId, {
      phase: 'starting',
      status: 'starting',
    })
    try {
      const run = await services.agentRuntime.startAgent(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary,
        agentId,
        input
      )
      if (run.status === 'error') {
        services.agentHeartbeatStore.record(workspaceId, agentId, {
          phase: 'startup_failed',
          status: 'failed',
        })
        services.agentLifecycleStore.transition(workspaceId, agentId, 'failed', {
          error: 'Agent process failed during startup',
          reason: 'startup_failed',
          runId: run.runId,
        })
        services.workspaceStore.markAgentStopped(workspaceId, agentId)
      } else {
        services.agentLifecycleStore.transition(workspaceId, agentId, 'ready', {
          error: null,
          reason: 'process_started',
          runId: run.runId,
        })
        services.workerOutputTracker?.attach(workspaceId, agentId, run.runId, run.output)
        services.agentHeartbeatStore.record(workspaceId, agentId, {
          phase: 'process_started',
          status: 'ready',
        })
        const readyAgent = services.workspaceStore.getAgent(workspaceId, agentId)
        services.runtimeEventBus.emit(workspaceId, {
          type: 'AGENT_READY',
          payload: {
            agentId,
            name: readyAgent?.name ?? agentId,
            role: readyAgent?.role ?? 'custom',
            runId: run.runId,
            status: 'ready',
          },
        })
      }
      return run
    } catch (error) {
      services.agentHeartbeatStore.record(workspaceId, agentId, {
        phase: 'startup_failed',
        status: 'failed',
      })
      services.agentLifecycleStore.transition(workspaceId, agentId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        reason: 'startup_failed',
        runId: null,
      })
      services.workspaceStore.markAgentStopped(workspaceId, agentId)
      throw error
    }
  }

  const recoveryWatchdog = createRecoveryWatchdog({
    agentHeartbeatStore: services.agentHeartbeatStore,
    agentLifecycleStore: services.agentLifecycleStore,
    agentRuntime: services.agentRuntime,
    dispatchReadyTasks: services.dispatchAllWorkspaceTasks,
    getWorkspacePath: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path,
    listWorkspaces: services.workspaceStore.listWorkspaces,
    releaseTask: (workspaceId, taskId, reason, options) => {
      taskStore.releaseTask(workspaceId, taskId, reason, options)
    },
    markTaskReleased: (workspaceId, agentId) => {
      // A recovery release frees the worker's in-flight task, so its pending
      // count must drop back to idle — otherwise the worker stays `working`
      // and the orchestrator keeps dispatching to an agent that is actually
      // down. Bounded at 0 (markTaskReported clamps).
      services.workspaceStore.markTaskReported(workspaceId, agentId)
    },
    ...(services.workerOutputTracker
      ? {
          getLastPtyActivityAt: services.workerOutputTracker.getLastPtyActivityAt,
          getLastSpontaneousActivityAt: services.workerOutputTracker.getLastSpontaneousActivityAt,
        }
      : {}),
    emitEvent: (workspaceId, type, payload) => {
      services.runtimeEventBus.emit(workspaceId, { type, payload })
    },
    startAgent,
    stopAgentRun: stopAgentAndWait,
    workspaceStore: services.workspaceStore,
  })

  const autostartConfiguredAgents = async (input: { gachiPort: string }) => {
    if (!agentManager) return []
    const starts = services.workspaceStore.listWorkspaces().flatMap((workspace) => {
      seedOrchestratorLaunchConfig(services.agentRuntime, services.settings, workspace.id)
      return services.workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter(
          (agent) =>
            !services.agentRuntime.getActiveRunByAgentId(workspace.id, agent.id) &&
            services.agentRuntime.peekAgentLaunchConfig(workspace.id, agent.id)
        )
        .map(async (agent) => {
          try {
            const run = await startAgent(workspace.id, agent.id, input)
            return {
              agent_id: agent.id,
              error: null,
              ok: true,
              run_id: run.runId,
              workspace_id: workspace.id,
            }
          } catch (error) {
            return {
              agent_id: agent.id,
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              run_id: null,
              workspace_id: workspace.id,
            }
          }
        })
    })
    return Promise.all(starts)
  }

  return {
    close: async () => {
      services.autoUnblockStop?.()
      services.orchestratorHeartbeat.stop()
      services.workerReportNudge.stop()
      recoveryWatchdog.stop()
      services.memoryWatchdog.stop()
      services.telegramService.stop()
      services.telemetry.dispose()
      services.eventLog.close()
      services.shellRuntime.close()
      await services.agentRuntime.close()
      services.runtimeSupervisor.close()
      await services.tasksFileWatcher.close()
      services.workerOutputTracker?.closeAll()
      services.agentRunStore.close?.()
      taskStore.detachDatabase()
      services.db.close()
    },
    configureAgentLaunch: async (
      workspaceId: string,
      agentId: string,
      input: AgentLaunchConfigInput
    ) => {
      services.workspaceStore.getAgent(workspaceId, agentId)
      // При смене конфигурации (например Codex -> AGY / Claude Code):
      // 1. Очищаем устаревший session_id, чтобы новый CLI не пытался возобновить несовместимую сессию
      services.agentSessionStore.clearLastSessionId(workspaceId, agentId)
      // 2. Сохраняем новую конфигурацию ПЕРВОЙ, чтобы любой перезапуск ниже
      //    (вызванный через release-пайплайн) поднял уже новый движок.
      services.agentRuntime.configureAgentLaunch(workspaceId, agentId, input)
      // 3. Если процесс жив, останавливаем его через supervisor.stopAgent —
      //    это ждёт реального выхода PTY и прогоняет полный release-пайплайн
      //    (settle task -> release agent -> re-dispatch), который и поднимает
      //    замену с новым движком. Раньше здесь был fire-and-forget без
      //    ожидания, поэтому старый run оставался "активным" и блокировал
      //    запуск нового движка — смена не срабатывала.
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId)
      if (activeRun) {
        // Persist a handoff snapshot BEFORE the old PTY exits. Engine switches
        // mid-task previously relied on whatever the last report/watchdog pass
        // had saved, so the replacement engine could start with a stale or
        // missing task context. Same best-effort pattern as recovery-watchdog.
        try {
          const workspacePath =
            services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
          const snapshot = createAgentSnapshot(readAgentSessionSnapshot(workspacePath, agentId))
          persistAgentSnapshot(workspacePath, snapshot)
        } catch (error) {
          console.error(
            '[ENGINE SWITCH] pre-switch snapshot failed:',
            error instanceof Error ? error.message : error
          )
        }
        services.runtimeSupervisor.stopAgent(activeRun.runId)
      }
    },
    peekAgentLaunchConfig: (workspaceId: string, agentId: string) =>
      services.agentRuntime.peekAgentLaunchConfig(workspaceId, agentId),
    deleteWorkspaceShell: (workspaceId: string) => {
      services.shellRuntime.deleteWorkspace(workspaceId)
    },
    closeWorkspaceShell: (workspaceId: string, runId: string) =>
      services.shellRuntime.closeRun(workspaceId, runId),
    getLiveRun: (runId: string) =>
      services.shellRuntime.getLiveRun(runId) ?? services.agentRuntime.getLiveRun(runId),
    getPtyOutputBus: (): PtyOutputBus => {
      if (!agentManager) throw new Error('Agent manager is required for PTY output subscriptions')
      return agentManager.getOutputBus()
    },
    listTerminalRuns: (workspaceId: string) => [
      ...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents.flatMap((agent) => {
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (!run) return []
        const launchConfig = services.agentRuntime.peekAgentLaunchConfig(workspaceId, agent.id)
        return [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            run_id: run.runId,
            status: run.status,
            terminal_input_profile: resolveTerminalInputProfile(launchConfig),
          },
        ]
      }),
      ...services.shellRuntime.listTerminalRuns(workspaceId),
    ],
    startAgent,
    startWorkspaceShell: (workspaceId: string) =>
      services.shellRuntime.start(
        services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary
      ),
    getWorkerRssMb: (workspaceId: string, agentId: string): number | null =>
      services.memoryWatchdog.getWorkerRssMb(workspaceId, agentId),
    autostartConfiguredAgents,
    registerTasksListener: (listener: (workspaceId: string, content: string) => void) => {
      services.tasksFileWatchCallbacks.add(listener)
      return () => {
        services.tasksFileWatchCallbacks.delete(listener)
      }
    },
    registerRuntimeEventsListener: (
      listener: (workspaceId: string, event: RuntimeEventPayload) => void
    ) => services.runtimeEventBus.subscribe(listener),
    startWorkspaceWatch: async (workspaceId: string) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      await services.tasksFileWatcher.start(workspaceId, workspace.summary.path)
    },
    writeRunInput: services.writeRunInput,
    agentControl,
    pauseTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.pauseRun(runId)
      else services.agentRuntime.pauseRun(runId)
    },
    // Terminal-viewer backpressure: pause the OUTPUT FLOW only. Suspending the
    // OS process from a slow browser tab froze working agents (and then the
    // recovery watchdog killed them for "no output").
    pauseTerminalRunOutput: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.pauseRunOutput(runId)
      else services.agentRuntime.pauseRunOutput?.(runId)
    },
    resizeTerminalRun: (runId: string, cols: number, rows: number) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resizeRun(runId, cols, rows)
      else services.agentRuntime.resizeAgentRun(runId, cols, rows)
    },
    resumeTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resumeRun(runId)
      else services.agentRuntime.resumeRun(runId)
    },
    resumeTerminalRunOutput: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.resumeRunOutput(runId)
      else services.agentRuntime.resumeRunOutput?.(runId)
    },
    stopTerminalRun: (runId: string) => {
      if (services.shellRuntime.hasRun(runId)) services.shellRuntime.stopRun(runId)
      else {
        const run = services.agentRuntime.getLiveRun(runId)
        const workspaceId = services.workspaceStore
          .listWorkspaces()
          .find((workspace) => services.workspaceStore.hasAgent(workspace.id, run.agentId))?.id
        if (workspaceId) {
          // The lifecycle may already be terminal (crashed worker reported
          // `stopped` by its PTY exit handler) — `stopped -> stopping` used to
          // throw and turn `team worker start`/`restart-all-crashed` into a
          // 500 even though the actual stop below is a harmless no-op.
          const lifecycleState = services.agentLifecycleStore.get(workspaceId, run.agentId)?.state
          if (
            lifecycleState &&
            canTransitionAgentLifecycle(lifecycleState, 'stopping') &&
            lifecycleState !== 'stopping'
          ) {
            services.agentLifecycleStore.transition(workspaceId, run.agentId, 'stopping', {
              reason: 'stop_requested',
              runId,
            })
          }
        }
        services.agentRuntime.stopAgentRun(runId)
      }
    },
  }
}
