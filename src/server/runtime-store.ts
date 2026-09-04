import type {
  AgentLifecycleStatus,
  AgentSummary,
  TeamListItem,
  WorkspaceSummary,
} from '../shared/types.js'
import type { AgentControl, ContextAction } from './agent-control.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentRun } from './agent-run-model.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentTelemetry } from './agent-telemetry.js'
import type { createAgentUsageStore } from './agent-usage-store.js'
import type { ApprovalRequest } from './approval-store.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRuntimeStoreLifecycle, createRuntimeStoreServices } from './runtime-store-helpers.js'
import type { AgentHealthResult, ReconcileSummary } from './runtime-supervisor.js'
import type { SettingsStore } from './settings-store.js'
import { taskStore } from './task-store.js'
import type { RuntimeEventPayload } from './tasks-websocket-server.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import type { TelegramLink, TelegramRole } from './telegram-links-store.js'
import type { TelegramConfig, TelegramEventType } from './telegram-service.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkerInput, WorkerUpdateInput, WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  /**
   * Runs startup recovery when the store was created with
   * `deferStartupRecovery` (daemon boot path: only after the port bind
   * succeeded). No-op otherwise.
   */
  runStartupRecovery: () => void
  /**
   * Halves the workspace's consecutive-failure streak (breaker auto-resume /
   * manual resume keeps the breaker armed after a burn-down).
   */
  softenErrorBudget: (workspaceId: string) => void
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  renameWorkspace: (workspaceId: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => ReportTaskResult
  cancelTask: (workspaceId: string, dispatchId: string, input: CancelTaskInput) => ReportTaskResult
  cancelTaskById: (
    workspaceId: string,
    taskId: string,
    input: CancelTaskInput
  ) => ReportTaskResult & { taskId: string }
  deleteTaskCard: (workspaceId: string, taskId: string, input: CancelTaskInput) => boolean
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  listActiveRuns: () => AgentRun[]
  getAgentRun: (workspaceId: string, agentId: string) => AgentRun | undefined
  getRun: (runId: string) => AgentRun | undefined
  getRunHistory: (limit?: number) => AgentRun[]
  getAgentHealth: (workspaceId: string, agentId: string) => AgentHealthResult
  dispatchAllWorkspaceTasks: (workspaceId: string) => Promise<void>
  /** T1: manual schedule tick (tests / admin tooling). */
  runScheduleTick: () => void
  /** Memory-watchdog telemetry: engine RSS in MB, null when unknown/stale. */
  getWorkerRssMb: (workspaceId: string, agentId: string) => number | null
  reconcileRuns: () => ReconcileSummary
  reconcileTasksFromDispatches: (workspaceId: string) => number
  getLastDispatchForWorker: (
    workspaceId: string,
    workerId: string
  ) => { createdAt: number; deliveredAt: number | null } | undefined
  getLastPtyActivityAt: (workspaceId: string, agentId: string) => number | null
  listWorkers: (workspaceId: string) => TeamListItem[]
  getLastPtyLineForAgent: (workspaceId: string, agentId: string) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getAgentLifecycleState: (workspaceId: string, agentId: string) => AgentLifecycleStatus | null
  getAgentLifecycleError: (workspaceId: string, agentId: string) => string | null
  updateWorker: (workspaceId: string, workerId: string, input: WorkerUpdateInput) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  startWorkspaceWatch: (workspaceId: string) => Promise<void>
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  registerRuntimeEventsListener: (
    listener: (workspaceId: string, event: RuntimeEventPayload) => void
  ) => () => void
  /**
   * Recent runtime events (audit trail) for a workspace, newest-last.
   * Shares the same bus that drives the UI WebSocket, so the UI, the audit
   * log and the agent mailbox all observe one source of truth.
   */
  tailEvents: (
    workspaceId: string,
    options?: import('./event-log.js').TailEventLogOptions
  ) => import('./event-log.js').EventLogRecord[]
  /** Recent events relevant to a specific agent (its status/task events + board events). */
  agentEvents: (
    workspaceId: string,
    agentId: string,
    options?: Omit<import('./event-log.js').TailEventLogOptions, 'agentId'>
  ) => import('./event-log.js').EventLogRecord[]
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  pauseTerminalRunOutput: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  resumeTerminalRunOutput: (runId: string) => void
  setRuntimePort: (port: string) => void
  settings: SettingsStore
  /** Usage telemetry (observe/snapshot) — exposed for wiring + tests. */
  telemetry: AgentTelemetry
  draftPlanFromGoal: (
    workspaceId: string,
    goal: string
  ) => { accepted: true; groupId: string } | { accepted: false; reason: string }
  workspaceMetrics: (
    workspaceId: string,
    windowMs?: number
  ) => ReturnType<ReturnType<typeof createAgentUsageStore>['workspaceMetrics']>
  writeRunInput: (runId: string, input: Buffer | string) => void
  /** Dispatch-seam interactive write; false when the agent has no writable run. */
  writeAgentInteractiveInput: (workspaceId: string, agentId: string, text: string) => boolean
  writeTaskQueueUpdate: (
    workspaceId: string,
    action: string,
    task: {
      id: string
      title: string
      status: string
      assignedWorkerName?: string | undefined
      details?: string | undefined
    }
  ) => void
  getUiToken: () => string
  regenerateUiToken: () => string
  stopAgentRun: (runId: string) => Promise<void>
  resetWorker: (workspaceId: string, workerId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
  /** Unified agent control plane (spec Part 2 §2). */
  getAgentControlState: (
    workspaceId: string,
    agentId: string
  ) => ReturnType<AgentControl['getState']>
  listAgentCapabilities: () => ReturnType<AgentControl['listCapabilities']>
  agentSwitchModel: (
    workspaceId: string,
    agentId: string,
    model: unknown
  ) => ReturnType<AgentControl['switchModel']>
  agentSetReasoning: (
    workspaceId: string,
    agentId: string,
    level: unknown
  ) => ReturnType<AgentControl['setReasoning']>
  agentContextAction: (
    workspaceId: string,
    agentId: string,
    action: ContextAction
  ) => ReturnType<AgentControl['runContextAction']>
  agentStart: (
    workspaceId: string,
    agentId: string,
    input?: { gachi_port?: string }
  ) => ReturnType<AgentControl['start']>
  agentStop: (workspaceId: string, agentId: string) => ReturnType<AgentControl['stop']>
  agentRestart: (
    workspaceId: string,
    agentId: string,
    input?: { gachi_port?: string }
  ) => ReturnType<AgentControl['restart']>
  agentResumeSession: (
    workspaceId: string,
    agentId: string,
    input?: { gachi_port?: string }
  ) => ReturnType<AgentControl['resumeSession']>
  /** Telegram interface (spec Part 3). */
  getTelegramConfig: () => TelegramConfig
  setTelegramConfig: (input: {
    enabled?: boolean
    token?: string | null
    events?: TelegramEventType[]
    proxyUrl?: string | null
    apiRoot?: string | null
  }) => Promise<void>
  verifyTelegramToken: (token: string) => Promise<string>
  testTelegramConnection: () => Promise<
    { ok: true; botUsername: string } | { ok: false; error: string }
  >
  createTelegramPairingCode: () => { code: string; expiresAt: number }
  listTelegramLinks: () => TelegramLink[]
  removeTelegramLink: (chatId: string, userId: string) => boolean
  setTelegramLinkRole: (
    chatId: string,
    userId: string,
    role: TelegramRole
  ) => TelegramLink | undefined
  listApprovals: (workspaceId: string) => {
    pending: ApprovalRequest[]
    recent: ApprovalRequest[]
  }
  decideApproval: (
    requestId: string,
    decision: 'approved' | 'denied',
    decidedBy: string
  ) => Promise<ApprovalRequest>
  /** Agent-facing permission request (team request → Telegram approval flow). */
  createApprovalRequest: (input: {
    workspaceId: string
    agentId: string
    command: string
    reason?: string | null
    taskId?: string | null
    dispatchId?: string | null
  }) => ApprovalRequest
  notifyApprovalRequired: (request: ApprovalRequest) => Promise<void>
  /**
   * Absolute path to the runtime data directory where templates and other
   * persisted state live (e.g. `runtime.sqlite`). Returns `null` when the
   * runtime runs fully in-memory (no on-disk location).
   */
  getDataDir: () => string | null
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
  deferStartupRecovery?: boolean
}

interface StartAgentOptions {
  gachiPort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager ? { agentManager: options.agentManager, services } : { services }
  )
  const runDataMutation = (mutation: () => void) => {
    if (!services.db) {
      mutation()
      return
    }
    services.db.transaction(mutation)()
  }
  return {
    close: lifecycle.close,
    runStartupRecovery: () => services.runStartupRecovery(),
    softenErrorBudget: (workspaceId) => services.softenErrorBudget(workspaceId),
    createWorkspace: (path, name) => {
      const workspace = services.workspaceStore.createWorkspace(path, name)
      lifecycle.startWorkspaceWatch(workspace.id).catch((error: unknown) => {
        console.error(`[WORKSPACE] watch start failed for ${workspace.id}:`, error)
      })
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    renameWorkspace: (workspaceId, name) =>
      services.workspaceStore.renameWorkspace(workspaceId, name),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      lifecycle.deleteWorkspaceShell(workspaceId)
      for (const agent of workspace.agents) {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      services.telemetry.removeWorkspace(workspaceId)
      services.forgetTaskStatusesForWorkspace(workspaceId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.workspaceStore.deleteWorkspace(workspaceId)
      })
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    updateWorker: (workspaceId, workerId, input) =>
      services.workspaceStore.updateWorker(workspaceId, workerId, input),
    deleteWorker: (workspaceId, workerId) => {
      // Stop the live run best-effort: a stop failure (e.g. the process already
      // died, or a headless runtime without a PTY driver) must not block the
      // durable deletion of the worker and its records below.
      try {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      } catch (error) {
        console.warn(
          `[DELETE WORKER] Failed to stop run for ${workerId}:`,
          error instanceof Error ? error.message : error
        )
      }
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      services.telemetry.removeAgent(workspaceId, workerId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        // Drop the deleted worker's sticky task affinity: a card bound to a
        // non-existent worker would never dispatch again. ALL statuses count:
        // a `running`/`review` card released later by the reaper would land in
        // `ready` still bound to the ghost unless it is unbound here and now.
        for (const task of taskStore.listTasks(workspaceId)) {
          if (task.assignedAgentId === workerId) {
            taskStore.updateTask(workspaceId, task.id, { assignedAgentId: null })
          }
        }
        services.workspaceStore.deleteWorker(workspaceId, workerId)
      })
    },
    recordUserInput: services.teamOps.recordUserInput,
    cancelTask: services.teamOps.cancelTask,
    cancelTaskById: services.teamOps.cancelTaskById,
    deleteTaskCard: services.teamOps.deleteTaskCard,
    dispatchTask: services.teamOps.dispatchTask,
    dispatchTaskByWorkerName: services.teamOps.dispatchTaskByWorkerName,
    reportTask: services.teamOps.reportTask,
    statusTask: services.teamOps.statusTask,
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    listActiveRuns: services.runtimeSupervisor.listActiveRuns,
    getAgentRun: services.runtimeSupervisor.getAgentRun,
    getRun: services.runtimeSupervisor.getRun,
    getRunHistory: services.runtimeSupervisor.getRunHistory,
    runScheduleTick: services.runScheduleTick,
    getWorkerRssMb: lifecycle.getWorkerRssMb,
    getAgentHealth: services.runtimeSupervisor.healthCheck,
    dispatchAllWorkspaceTasks: services.dispatchAllWorkspaceTasks,
    reconcileRuns: services.runtimeSupervisor.reconcile,
    reconcileTasksFromDispatches: (workspaceId) => {
      // Rows older than a day are leaks from hard kills, not lost cards: the
      // release pipeline cancels rows itself now, and a deleted card already
      // force-cancels its rows. Resurrecting ancient rows only spammed
      // duplicate cards (production: "ENGINE" copies after the restart storm).
      const RESURRECT_MAX_AGE_MS = 24 * 60 * 60 * 1000
      const now = Date.now()
      const dispatches = services.dispatchLedgerStore.listWorkspaceDispatches(workspaceId, {
        limit: 1000,
      })
      const liveWorkerIds = new Set(
        services.workspaceStore.listWorkers(workspaceId).map((worker) => worker.id)
      )
      let restored = 0
      for (const dispatch of dispatches) {
        if (dispatch.status === 'cancelled') continue
        if (now - dispatch.createdAt > RESURRECT_MAX_AGE_MS) continue
        if (taskStore.getTaskByDispatchId(workspaceId, dispatch.id)) continue
        // A row referencing a deleted worker cannot be restored: getWorker
        // throws for missing ids and the rebuilt card would be bound to a
        // ghost forever. Skip the row instead of failing the whole workspace.
        if (!liveWorkerIds.has(dispatch.toAgentId)) continue
        const worker = services.workspaceStore.getWorker(workspaceId, dispatch.toAgentId)
        const title =
          dispatch.text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || `Task for ${worker.name}`
        taskStore.createTask(workspaceId, {
          assignedAgentId: dispatch.toAgentId,
          artifacts: dispatch.artifacts,
          description: dispatch.text,
          dispatchId: dispatch.id,
          result: dispatch.reportText ?? undefined,
          // Same rule as the startup repair: reported work returns as review;
          // never-delivered dispatches go to backlog instead of running, so a
          // deleted card cannot be resurrected straight into an active worker.
          status: dispatch.status === 'reported' ? 'review' : 'backlog',
          title,
        })
        restored++
      }
      return restored
    },
    getLastDispatchForWorker: services.dispatchLedgerStore.getLastDispatchForWorker,
    listWorkers: (workspaceId) => services.workspaceStore.listWorkers(workspaceId),
    getLastPtyActivityAt: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyActivityAt(workspaceId, agentId) ?? null,
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getAgentLifecycleState: (workspaceId, agentId) =>
      services.agentLifecycleStore.get(workspaceId, agentId)?.state ?? null,
    getAgentLifecycleError: (workspaceId, agentId) =>
      services.agentLifecycleStore.get(workspaceId, agentId)?.lastError ?? null,
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: lifecycle.closeWorkspaceShell,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: lifecycle.startAgent,
    autostartConfiguredAgents: lifecycle.autostartConfiguredAgents,
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    startWorkspaceShell: lifecycle.startWorkspaceShell,
    getLiveRun: lifecycle.getLiveRun,
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerTasksListener: lifecycle.registerTasksListener,
    registerRuntimeEventsListener: lifecycle.registerRuntimeEventsListener,
    tailEvents: services.tailEvents,
    agentEvents: services.agentEvents,
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    pauseTerminalRunOutput: lifecycle.pauseTerminalRunOutput,
    resizeAgentRun: lifecycle.resizeTerminalRun,
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    resumeTerminalRunOutput: lifecycle.resumeTerminalRunOutput,
    setRuntimePort: services.setRuntimePort,
    settings: services.settings,
    telemetry: services.telemetry,
    draftPlanFromGoal: services.draftPlanFromGoal,
    workspaceMetrics: (workspaceId, windowMs = 24 * 60 * 60_000) =>
      services.usageStore.workspaceMetrics(workspaceId, windowMs),
    writeRunInput: lifecycle.writeRunInput,
    writeAgentInteractiveInput: (workspaceId, agentId, text) =>
      services.agentRuntime.writeInteractiveInput(workspaceId, agentId, text),
    writeTaskQueueUpdate: services.agentRuntime.writeTaskQueueUpdatePrompt,
    getUiToken: () => services.uiAuth.getToken(),
    regenerateUiToken: () => services.uiAuth.regenerate(),
    stopAgentRun: async (runId) => {
      if (services.shellRuntime.hasRun(runId)) {
        lifecycle.stopTerminalRun(runId)
        return
      }
      lifecycle.stopTerminalRun(runId)
      await services.agentRuntime.waitForAgentRunExit(runId)
    },
    resetWorker: (workspaceId, workerId) => {
      services.workspaceStore.markTaskReported(workspaceId, workerId)
    },
    getAgentControlState: (workspaceId, agentId) =>
      lifecycle.agentControl.getState(workspaceId, agentId),
    listAgentCapabilities: () => lifecycle.agentControl.listCapabilities(),
    agentSwitchModel: (workspaceId, agentId, model) =>
      lifecycle.agentControl.switchModel(workspaceId, agentId, model),
    agentSetReasoning: (workspaceId, agentId, level) =>
      lifecycle.agentControl.setReasoning(workspaceId, agentId, level),
    agentContextAction: (workspaceId, agentId, action) =>
      lifecycle.agentControl.runContextAction(workspaceId, agentId, action),
    agentStart: (workspaceId, agentId, input) =>
      lifecycle.agentControl.start(workspaceId, agentId, { gachiPort: input?.gachi_port ?? '' }),
    agentStop: (workspaceId, agentId) => lifecycle.agentControl.stop(workspaceId, agentId),
    agentRestart: (workspaceId, agentId, input) =>
      lifecycle.agentControl.restart(workspaceId, agentId, {
        gachiPort: input?.gachi_port ?? '',
      }),
    agentResumeSession: (workspaceId, agentId, input) =>
      lifecycle.agentControl.resumeSession(workspaceId, agentId, {
        gachiPort: input?.gachi_port ?? '',
      }),
    getTelegramConfig: () => services.telegramService.getConfig(),
    setTelegramConfig: (input) => services.telegramService.setConfig(input),
    verifyTelegramToken: (token) => services.telegramService.verifyToken(token),
    testTelegramConnection: () => services.telegramService.testConnection(),
    createTelegramPairingCode: () => services.telegramService.createPairingCode(),
    listTelegramLinks: () => services.telegramService.listLinks(),
    removeTelegramLink: (chatId, userId) => services.telegramService.removeLink(chatId, userId),
    setTelegramLinkRole: (chatId, userId, role) =>
      services.telegramService.setLinkRole(chatId, userId, role),
    listApprovals: (workspaceId) => ({
      pending: services.approvalStore.listPending(workspaceId),
      recent: services.approvalStore.listRecent(workspaceId),
    }),
    decideApproval: (requestId, decision, decidedBy) =>
      services.telegramService.decideApproval(requestId, decision, decidedBy),
    createApprovalRequest: (input) => services.approvalStore.create(input),
    notifyApprovalRequired: (request) => services.telegramService.notifyApproval(request),
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateUiToken: (token) => services.uiAuth.validate(token),
    getDataDir: () => options.dataDir ?? null,
  }
}
