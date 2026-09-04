import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentDriverRuntime } from './agent-driver-runtime.js'
import type { AgentManager } from './agent-manager.js'
import { buildAgentRunBootstrap, startAgentRunCapture } from './agent-run-bootstrap.js'
import { handleAgentRunExit } from './agent-run-exit-handler.js'
import type { AgentRunExitContext, AgentRunStarterStorePort } from './agent-run-start-context.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  appendAgentSessionEvent,
  appendAgentSessionTranscript,
  readExistingAgentSessionSnapshot,
  writeAgentSessionSnapshot,
} from './agent-session-journal.js'
import {
  buildAgentStartupInstructions,
  buildAssignedTaskPrompt,
} from './agent-startup-instructions.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import { isInteractiveAgentCommand } from './cli-driver.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SandboxSettings } from './docker-sandbox.js'
import { claudeMarkerConfirmed, startDeliveryMonitor } from './instruction-delivery-monitor.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { ensureOpencodePermissions } from './opencode-permissions.js'
import { type PermissionMode, shouldGrantOpencodePermissions } from './permission-mode.js'
import { createPostStartInputWriter } from './post-start-input-writer.js'
import type { RestartPolicy } from './restart-policy.js'
import { taskStore } from './task-store.js'
import { createAgentWorktree, isGitWorkspaceRoot } from './worktree-manager.js'

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  driver: AgentDriverRuntime | undefined
  registry: LiveRunRegistry
  onAgentExit: (workspaceId: string, agentId: string) => void
  onRunStarted?: (
    runId: string,
    agentId: string,
    workspaceId: string,
    startedAt: number,
    pid: number | null
  ) => void
  onRunExited?: (
    runId: string,
    agentId: string,
    workspaceId: string,
    exitCode: number | null,
    endedAt: number
  ) => void
  store: AgentRunStarterStorePort
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  getAgent: ((workspaceId: string, agentId: string) => AgentSummary | undefined) | undefined
  persistLaunchConfig?: (
    workspaceId: string,
    agentId: string,
    config: AgentLaunchConfigInput
  ) => void
  /** Orchestrator PTY chunks, for the Telegram `[TG_REPLY]` bridge. */
  onOrchestratorOutput?: (chunk: string) => void
  /** R10: per-workspace permission mode; `ask` suppresses blanket grants. */
  permissionMode?: (workspaceId: string) => PermissionMode
  /** R5→R10: opt-in Docker sandbox resolved from workspace app-state. */
  sandboxFor?: (workspaceId: string) => SandboxSettings
  restartPolicy: RestartPolicy
}

export const createAgentRunStarter =
  ({
    agentManager,
    driver,
    registry,
    onAgentExit,
    onRunStarted,
    onRunExited,
    store,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    persistLaunchConfig,
    restartPolicy,
    onOrchestratorOutput,
    permissionMode,
    sandboxFor,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    gachiPort: string
  ) => {
    if (!agentManager || !driver) throw new Error('Agent driver is required to start agents')

    const agent = getAgent?.(workspace.id, agentId)

    // Compute working directory FIRST so session capture and resume check
    // the correct project dir (the one claude/opencode actually writes to).
    const agentWorkingDirectory =
      agent && agent.role !== 'orchestrator' && isGitWorkspaceRoot(workspace.path)
        ? createAgentWorktree(workspace.path, agentId)
        : workspace.path

    // OpenCode gates folder/bash access through its own config — write an
    // allow-all file so workers don't freeze on the first edit (user request).
    // R10: suppressed in `ask` permission mode.
    if (
      shouldGrantOpencodePermissions(
        { role: agent?.role, commandPresetId: config.commandPresetId, command: config.command },
        permissionMode?.(workspace.id) ?? 'allow-all'
      )
    ) {
      ensureOpencodePermissions(agentWorkingDirectory)
    }

    const { persistedConfig, sessionCaptureSnapshot, startConfig, startEnv } =
      buildAgentRunBootstrap(
        workspace,
        agentId,
        config,
        sessionStore,
        getCommandPreset,
        agent,
        agentWorkingDirectory,
        sandboxFor?.(workspace.id)
      )
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const token = tokenRegistry.issue(agentId)
    let unsubscribeTranscript: (() => void) | undefined
    const exitContext: AgentRunExitContext = {
      agentId,
      handledRunExits,
      onAgentExit,
      ...(onRunExited ? { onRunExited } : {}),
      registry,
      sessionStore,
      startConfig,
      store,
      token,
      tokenRegistry,
      workspace,
    }
    // If the dispatcher is starting this worker for an already-assigned task, it
    // must not grab a different open task too (one worker, one task). Only auto-
    // assign an open task when the worker has no assigned work yet.
    const alreadyAssigned =
      agent && agent.role !== 'orchestrator'
        ? taskStore.getAssignedTaskForWorker(workspace.id, agentId)
        : undefined
    const assignedTask =
      !alreadyAssigned && agent && agent.role !== 'orchestrator'
        ? taskStore.findOpenTask(workspace.id)
        : undefined
    if (assignedTask && agent) {
      // ready → assigned: первый разрешённый переход.
      // running ставится позже через dispatchTask когда промпт реально уходит в PTY.
      taskStore.updateTask(workspace.id, assignedTask.id, {
        assignedAgentId: agentId,
        status: 'assigned',
      })
      taskStore.addLog(
        workspace.id,
        assignedTask.id,
        `Воркер @${agent.name} назначен на задачу при старте (ready → assigned)`
      )
    }

    // (cwd was computed above — before bootstrap — so capture/resume use it)

    const startInput = {
      agentId,
      command: startConfig.command,
      cwd: agentWorkingDirectory,
      env: {
        ...startEnv,
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'gachi',
        GACH_PORT: gachiPort,
        GACH_AGENT_TOKEN: token,
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        unsubscribeTranscript?.()
        const sessionStatus = exitCode === null || exitCode === 0 ? 'stopped' : 'failed'
        // The journal write must never block the exit pipeline (B6): a
        // transient fs failure here (Windows EPERM/EBUSY on the rename) used
        // to skip handleAgentRunExit entirely, leaving the agent summary
        // `working` and its task in flight while the process was dead.
        try {
          writeAgentSessionSnapshot(workspace.path, {
            agentId,
            command: startConfig.command,
            runId,
            status: sessionStatus,
            updatedAt: endedAt,
          })
          appendAgentSessionEvent(workspace.path, agentId, {
            at: endedAt,
            runId,
            type: sessionStatus,
          })
        } catch (error) {
          console.error(
            `[RUNTIME] session journal write on exit failed for @${agentId} (${sessionStatus}):`,
            error instanceof Error ? error.message : error
          )
        }
        // Task settlement (review/requeue), agent release and re-dispatch are
        // handled by the RuntimeSupervisor.releaseAgentRun pipeline so every
        // exit path (clean exit, crash, manual stop, recovery, restart) shares
        // the same idempotent logic.
        if (
          !handleAgentRunExit(exitContext, { exitCode, endedAt, runId }) &&
          abortedRunIds.has(runId)
        ) {
          registry.clearPendingExitCode(runId)
          return
        }
      },
    }

    const continuation = readExistingAgentSessionSnapshot(workspace.path, agentId)
    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      run = await driver.start(
        startConfig.args ? { ...startInput, args: startConfig.args } : startInput
      )
    } catch (error) {
      tokenRegistry.revokeIfMatches(agentId, token)
      throw error
    }
    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      startedAt,
      status: run.status === 'error' ? 'error' : 'starting',
    }
    writeAgentSessionSnapshot(workspace.path, {
      agentId,
      command: startConfig.command,
      runId: run.runId,
      status: run.status === 'error' ? 'failed' : 'running',
      task: continuation?.task,
      updatedAt: startedAt,
    })
    appendAgentSessionEvent(workspace.path, agentId, {
      at: startedAt,
      runId: run.runId,
      type: run.status === 'error' ? 'failed' : 'started',
    })
    if (run.status !== 'error') {
      unsubscribeTranscript = agentManager.getOutputBus().subscribe(run.runId, (chunk) => {
        appendAgentSessionTranscript(workspace.path, agentId, chunk)
        // Orchestrator → Telegram reply bridge ([TG_REPLY] lines).
        if (agent?.role === 'orchestrator') onOrchestratorOutput?.(chunk)
      })
    }
    try {
      store.insertAgentRun(run.runId, agentId, startedAt, run.pid, liveRun.status, liveRun.exitCode)
    } catch (error) {
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(agentId, token)
      unsubscribeTranscript?.()
      agentManager.stopRun(run.runId)
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)
    onRunStarted?.(run.runId, agentId, workspace.id, startedAt, run.pid)

    if (run.status === 'error') {
      store.updatePersistedRun(run.runId, 'error', run.exitCode, Date.now())
      if (startConfig.resumedSessionId) {
        sessionStore.clearLastSessionId(workspace.id, agentId)
      }
      tokenRegistry.revokeIfMatches(agentId, token)
      // Ensure §12 three-state: failed spawn must flip AgentSummary to stopped.
      // Route it through the supervisor exit pipeline so the run record is
      // completed and any task the starter assigned is requeued, not left stuck.
      onRunExited?.(run.runId, agentId, workspace.id, run.exitCode, Date.now())
      onAgentExit(workspace.id, agentId)
      registry.resolveExit(run.runId)
      registry.clearPendingExitCode(run.runId)
      return liveRun
    }

    startAgentRunCapture({
      agentId,
      sessionCaptureSnapshot,
      sessionStore,
      startConfig,
      workspace,
      workingDirectory: agentWorkingDirectory,
    })
    // Remember the actual command that launched this agent so a later restart
    // comes up the same way (custom commands, engine switches, resume args).
    persistLaunchConfig?.(workspace.id, agentId, persistedConfig)
    const postStartWriter = createPostStartInputWriter(
      agentManager,
      startConfig.interactiveCommand ?? startConfig.command
    )
    queueMicrotask(() => {
      try {
        const interactive =
          agent && isInteractiveAgentCommand(startConfig.interactiveCommand ?? startConfig.command)
        const injectedRestartMessage = restartPolicy.injectPostStartMessage({
          agentId,
          runId: run.runId,
          startConfig,
          workspace,
          writeToRun: postStartWriter,
        })
        if (!startConfig.resumedSessionId && !injectedRestartMessage && interactive && agent) {
          const instructions = buildAgentStartupInstructions({
            agent,
            assignedTask,
            continuation,
            workspace,
            workingDirectory: agentWorkingDirectory,
          })
          postStartWriter(run.runId, instructions)
          if (startConfig.sessionIdCapture?.source === 'claude_project_jsonl_dir') {
            // Claude-family: a cold TUI can swallow the paste for minutes.
            // Re-paste on cadence until the binding marker shows up in the
            // session store — this is what feeds capture AND ownership.
            startDeliveryMonitor({
              isRunAlive: () => {
                const live = agentManager.getRun(run.runId)
                return live.status === 'starting' || live.status === 'running'
              },
              repaste: () => {
                console.warn(
                  `[RUNTIME] startup instructions not confirmed yet — re-delivering to @${agentId}`
                )
                postStartWriter(run.runId, instructions)
              },
              isConfirmed: () => claudeMarkerConfirmed(agentWorkingDirectory, startedAt),
              onGiveUp: () => {
                console.error(
                  `[RUNTIME] startup instructions for @${agentId} never confirmed within the delivery window`
                )
              },
            })
          } else {
            // Non-claude engines: single delayed retry, no cheap confirmation.
            const retryTimer = setTimeout(() => {
              try {
                if (sessionStore.getLastSessionId(workspace.id, agentId)) return
                const live = agentManager.getRun(run.runId)
                if (!live || (live.status !== 'starting' && live.status !== 'running')) return
                console.warn(
                  `[RUNTIME] startup instructions for @${agentId} not confirmed — re-delivering once`
                )
                postStartWriter(run.runId, instructions)
              } catch {
                // Run already exited — nothing to re-deliver.
              }
            }, 6_000)
            retryTimer.unref?.()
          }
        } else if (assignedTask && interactive) {
          // The resume/restart path skips the full startup instructions, so the
          // task auto-assigned at start would otherwise never reach the terminal.
          // Deliver it as a standalone block so it isn't left stuck in `assigned`.
          postStartWriter(run.runId, buildAssignedTaskPrompt(assignedTask))
        }
      } catch {
        // The agent may have exited before post-start guidance could be written.
      }
    })

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        handleAgentRunExit(exitContext, { exitCode, endedAt: Date.now(), runId: run.runId })
      })
    }

    return liveRun
  }
