import type { AgentSummary } from '../shared/types.js'
import { createPtyAgentDriver } from './agent-driver-runtime.js'
import { createAgentLaunchCache } from './agent-launch-cache.js'
import type { AgentManager, AgentRunSnapshot } from './agent-manager.js'
import { createAgentRunStarter } from './agent-run-starter.js'
import { syncPersistedRun } from './agent-run-sync.js'
import { getActiveRunByAgent } from './agent-runtime-active-run.js'
import { closeAgentRuntime } from './agent-runtime-close.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { createAgentRuntimeFlowAdapter } from './agent-runtime-flow-adapter.js'
import { listRunsWithFallback } from './agent-runtime-list-runs.js'
import type { AgentRunStorePort, AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentStdinDispatcher } from './agent-stdin-dispatcher.js'
import { createAgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SandboxSettings } from './docker-sandbox.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import type { PermissionMode } from './permission-mode.js'
import { createNoopRestartPolicy, type RestartPolicy } from './restart-policy.js'

export const createAgentRuntime = (
  agentManager: AgentManager | undefined,
  agentRunStore: AgentRunStorePort,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  onAgentExit: (workspaceId: string, agentId: string) => void,
  restartPolicy: RestartPolicy = createNoopRestartPolicy(),
  getAgent?: (workspaceId: string, agentId: string) => AgentSummary | undefined,
  onRunStarted?: (
    runId: string,
    agentId: string,
    workspaceId: string,
    startedAt: number,
    pid: number | null
  ) => void,
  onRunExited?: (
    runId: string,
    agentId: string,
    workspaceId: string,
    exitCode: number | null,
    endedAt: number
  ) => void,
  onOrchestratorOutput?: (chunk: string) => void,
  /** R10: per-workspace permission mode reader (`ask` suppresses grants). */
  permissionMode?: (workspaceId: string) => PermissionMode,
  /** R5→R10: opt-in Docker sandbox resolver for worker launches. */
  sandboxFor?: (workspaceId: string) => SandboxSettings
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore)
  const tokenRegistry = createAgentTokenRegistry()
  const driver = agentManager ? createPtyAgentDriver(agentManager) : undefined
  const startPromises = new Map<string, Promise<LiveAgentRun>>()
  let closing = false
  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for PTY terminal operations')
    return agentManager
  }
  const flowAdapter = createAgentRuntimeFlowAdapter(requireManager)

  const syncRun = (run: LiveAgentRun) => {
    if (!agentManager) return run
    // The manager drops dead runs shortly after exit to free PTY objects. The
    // registry still holds the finished run (bounded by TTL), so fall back to
    // the registry snapshot instead of throwing on the already-removed record.
    let snapshot: AgentRunSnapshot
    try {
      snapshot = agentManager.getRun(run.runId)
    } catch {
      return run
    }
    return syncPersistedRun(run, snapshot, agentRunStore)
  }
  const stdinDispatcher = createAgentStdinDispatcher({
    agentManager,
    getLaunchConfig: launchCache.peek,
    getWorkspaceId: launchCache.getWorkspaceId,
    registry,
    syncRun,
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    driver,
    registry,
    onAgentExit,
    ...(onRunStarted ? { onRunStarted } : {}),
    ...(onRunExited ? { onRunExited } : {}),
    store: agentRunStore,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    persistLaunchConfig: (workspaceId, agentId, config) =>
      launchCache.save(workspaceId, agentId, config),
    restartPolicy,
    ...(onOrchestratorOutput ? { onOrchestratorOutput } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(sandboxFor ? { sandboxFor } : {}),
  })

  return {
    async close() {
      closing = true
      await Promise.allSettled([...startPromises.values()])
      await closeAgentRuntime(agentManager, registry, syncRun)
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      launchCache.save(workspaceId, agentId, input)
    },
    deleteAgentLaunchConfig(workspaceId, agentId) {
      launchCache.remove(workspaceId, agentId)
    },
    peekAgentLaunchConfig(workspaceId, agentId) {
      return launchCache.peek(workspaceId, agentId)
    },
    getActiveRunByAgentId(workspaceId, agentId) {
      return getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspaceId,
        agentId
      )
    },
    getLiveRun(runId) {
      const run = registry.get(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return syncRun(run)
    },
    getPtyOutputBus() {
      return flowAdapter.getOutputBus()
    },
    listAgentRuns(agentId) {
      return listRunsWithFallback(registry, agentRunStore.listAgentRuns(agentId), agentId)
    },
    pauseRun(runId) {
      flowAdapter.pauseRun(runId)
    },
    pauseRunOutput(runId) {
      requireManager().pauseRunOutput(runId)
    },
    peekAgentToken(agentId) {
      return tokenRegistry.peek(agentId)
    },
    resizeAgentRun(runId, cols, rows) {
      flowAdapter.resizeRun(runId, cols, rows)
    },
    resumeRun(runId) {
      flowAdapter.resumeRun(runId)
    },
    resumeRunOutput(runId) {
      requireManager().resumeRunOutput(runId)
    },
    async startAgent(workspace, agentId, input) {
      if (closing) throw new Error('Agent runtime is closing')
      launchCache.setWorkspaceId(agentId, workspace.id)
      const key = `${workspace.id}:${agentId}`
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspace.id,
        agentId
      )
      if (activeRun) return activeRun
      const pendingStart = startPromises.get(key)
      if (pendingStart) return pendingStart
      const startPromise = startLiveRun(
        workspace,
        agentId,
        launchCache.get(workspace.id, agentId),
        input.gachiPort
      ).finally(() => {
        if (startPromises.get(key) === startPromise) {
          startPromises.delete(key)
        }
      })
      startPromises.set(key, startPromise)
      return startPromise
    },
    stopAgentRun(runId) {
      stopLiveRun(driver, registry, syncRun, runId)
    },
    waitForAgentRunExit(runId) {
      return registry.getExitEntry(runId)?.promise ?? Promise.resolve()
    },
    validateAgentToken: tokenRegistry.validate,
    writeReportPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeReportPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeStatusPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeStatusPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeInteractiveInput(workspaceId, agentId, text) {
      return stdinDispatcher.writeInteractiveInput(workspaceId, agentId, text)
    },
    writeSendPrompt(
      workspaceId,
      workerId,
      dispatchId,
      fromAgentName,
      workerDescription,
      text,
      onDelivered
    ) {
      stdinDispatcher.writeSendPrompt(
        workspaceId,
        workerId,
        dispatchId,
        fromAgentName,
        workerDescription,
        text,
        onDelivered
      )
    },
    writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input = {}) {
      stdinDispatcher.writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input)
    },
    writeUserInputPrompt(workspaceId, text) {
      return stdinDispatcher.writeUserInputPrompt(workspaceId, text)
    },
    writeHeartbeatPrompt(workspaceId) {
      return stdinDispatcher.writeHeartbeatPrompt(workspaceId)
    },
    writeWorkerReportNudge(workspaceId, workerId, payload) {
      stdinDispatcher.writeWorkerReportNudge(workspaceId, workerId, payload)
    },
    writeOrchestratorPrompt(workspaceId, payload) {
      return stdinDispatcher.writeOrchestratorPrompt(workspaceId, payload)
    },
    writeTaskQueueUpdatePrompt(workspaceId, action, task) {
      stdinDispatcher.writeTaskQueueUpdatePrompt(workspaceId, action, task)
    },
  }
}

export type { AgentRuntime }
