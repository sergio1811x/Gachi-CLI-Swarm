import { getAgentCapability, listAgentCapabilities } from './agent-capability-registry.js'
import type { AgentRuntime } from './agent-runtime.js'
import type { AgentTelemetry } from './agent-telemetry.js'
import { engineSupportsResume, getEngineAdapter } from './engine-adapter.js'
import {
  applyControlOverrides,
  getEngineControlProfile,
  parseReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
  readControlOverrides,
} from './engine-control-profiles.js'
import { ConflictError } from './http-errors.js'
import { taskStore } from './task-store.js'

/**
 * Unified agent control surface (control-plane spec Part 2 §2).
 *
 * Model/reasoning switches rewrite the persisted launch args through the
 * engine's control profile and re-run the engine-switch pipeline (stop →
 * relaunch with session resume), so the change survives restarts like any
 * other launch config. Context operations write the engine's slash command
 * into the live PTY. Every unsupported operation fails with a typed conflict
 * instead of a silent no-op.
 */
export interface AgentControlEvent {
  payload: Record<string, unknown>
  type:
    | 'AGENT_CONTEXT_ACTION'
    | 'AGENT_MODEL_CHANGED'
    | 'AGENT_REASONING_CHANGED'
    | 'AGENT_RESTARTED'
}

export interface AgentControlState {
  capability: ReturnType<typeof getAgentCapability> | null
  contextPercent: number | null
  model: string | null
  provider: string | null
  reasoningLevel: ReasoningLevel | null
  running: boolean
  tokensUsed: number | null
  usageUpdatedAt: number | null
}

export interface AgentControlDeps {
  agentRuntime: AgentRuntime
  emitEvent?: (workspaceId: string, event: AgentControlEvent) => void
  getLastSessionId?: (workspaceId: string, agentId: string) => string | undefined
  startAgentRun: (
    workspaceId: string,
    agentId: string,
    input: { gachiPort: string }
  ) => Promise<unknown>
  stopAgentGracefully: (runId: string) => Promise<void>
  telemetry: AgentTelemetry
  writeRunInput: (runId: string, input: Buffer | string) => void
  /**
   * The dispatch seam (prompt-ready wait → bracketed paste → delayed separate
   * CR submit). Preferred for slash commands: a raw single write can land
   * mid-render and its submit keystroke gets eaten by the TUI, leaving the
   * command unsubmitted in the input line.
   */
  writeInteractiveInput?: (workspaceId: string, agentId: string, text: string) => boolean
}

export type ContextAction = 'clear' | 'compact'

export interface AgentControl {
  clearContext: (
    workspaceId: string,
    agentId: string
  ) => Promise<{ action: ContextAction; ok: true }>
  compactContext: (
    workspaceId: string,
    agentId: string
  ) => Promise<{ action: ContextAction; ok: true }>
  getState: (workspaceId: string, agentId: string) => AgentControlState
  listCapabilities: () => ReturnType<typeof listAgentCapabilities>
  restart: (
    workspaceId: string,
    agentId: string,
    input?: { gachiPort?: string }
  ) => Promise<{ restarted: boolean }>
  resumeSession: (
    workspaceId: string,
    agentId: string,
    input?: { gachiPort?: string }
  ) => Promise<{ resumed: boolean; session_id: string }>
  runContextAction: (
    workspaceId: string,
    agentId: string,
    action: ContextAction
  ) => Promise<{ action: ContextAction; ok: true }>
  setReasoning: (
    workspaceId: string,
    agentId: string,
    level: unknown,
    input?: { gachiPort?: string }
  ) => Promise<{ level: ReasoningLevel; restarted: boolean }>
  start: (
    workspaceId: string,
    agentId: string,
    input?: { gachiPort?: string }
  ) => Promise<{ started: boolean }>
  stop: (workspaceId: string, agentId: string) => Promise<{ stopped: boolean }>
  switchModel: (
    workspaceId: string,
    agentId: string,
    model: unknown,
    input?: { gachiPort?: string }
  ) => Promise<{ model: string; restarted: boolean }>
}

export const createAgentControl = ({
  agentRuntime,
  emitEvent,
  getLastSessionId,
  startAgentRun,
  stopAgentGracefully,
  telemetry,
  writeInteractiveInput,
  writeRunInput,
}: AgentControlDeps): AgentControl => {
  const resolveEngine = (workspaceId: string, agentId: string) => {
    const config = agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
    if (!config) {
      throw new ConflictError(`No launch configuration for agent ${agentId}`)
    }
    const adapter = getEngineAdapter(config.interactiveCommand ?? config.command)
    const provider = adapter?.id ?? null
    return {
      adapter,
      config,
      profile: provider ? getEngineControlProfile(provider) : undefined,
      provider,
    }
  }

  const getActiveRun = (workspaceId: string, agentId: string) =>
    agentRuntime.getActiveRunByAgentId(workspaceId, agentId)

  const requireActiveRun = (workspaceId: string, agentId: string) => {
    const active = getActiveRun(workspaceId, agentId)
    if (!active) {
      throw new ConflictError('Agent is not running')
    }
    return active
  }

  const requireNoInFlightTask = (workspaceId: string, agentId: string) => {
    const task = taskStore.getAssignedTaskForWorker(workspaceId, agentId)
    if (task) {
      throw new ConflictError(
        `Worker owns in-flight task #${task.id.slice(0, 8)} ("${task.title}"); finish or cancel it before changing engine settings`
      )
    }
  }

  /** Persists new args and bounces a live run so they take effect now. */
  const applyLaunchArgsAndRestart = async (
    workspaceId: string,
    agentId: string,
    args: string[],
    gachiPort: string
  ): Promise<boolean> => {
    const { config } = resolveEngine(workspaceId, agentId)
    agentRuntime.configureAgentLaunch(workspaceId, agentId, { ...config, args })

    const active = getActiveRun(workspaceId, agentId)
    if (!active) return false
    await stopAgentGracefully(active.runId)
    await startAgentRun(workspaceId, agentId, { gachiPort })
    return true
  }

  return {
    async clearContext(workspaceId, agentId) {
      return this.runContextAction(workspaceId, agentId, 'clear')
    },

    async compactContext(workspaceId, agentId) {
      return this.runContextAction(workspaceId, agentId, 'compact')
    },

    getState(workspaceId, agentId): AgentControlState {
      let provider: string | null = null
      let overrides: { model: string | null; reasoning: ReasoningLevel | null } = {
        model: null,
        reasoning: null,
      }
      const config = agentRuntime.peekAgentLaunchConfig(workspaceId, agentId)
      if (config) {
        provider = getEngineAdapter(config.interactiveCommand ?? config.command)?.id ?? null
        const profile = provider ? getEngineControlProfile(provider) : undefined
        if (profile) overrides = readControlOverrides(config, profile)
      }
      const usage = telemetry.snapshot(workspaceId, agentId)
      return {
        capability: provider ? (getAgentCapability(provider) ?? null) : null,
        contextPercent: usage?.contextPercent ?? null,
        model: overrides.model,
        provider,
        reasoningLevel: overrides.reasoning,
        running: Boolean(getActiveRun(workspaceId, agentId)),
        tokensUsed: usage?.tokensUsed ?? null,
        usageUpdatedAt: usage?.updatedAt ?? null,
      }
    },

    listCapabilities: listAgentCapabilities,

    async restart(workspaceId, agentId, input = {}) {
      requireActiveRun(workspaceId, agentId)
      resolveEngine(workspaceId, agentId)
      await this.stop(workspaceId, agentId)
      await startAgentRun(workspaceId, agentId, { gachiPort: input.gachiPort ?? '' })
      emitEvent?.(workspaceId, { payload: { agentId }, type: 'AGENT_RESTARTED' })
      return { restarted: true }
    },

    async resumeSession(workspaceId, agentId, input = {}) {
      const { adapter, provider } = resolveEngine(workspaceId, agentId)
      if (!adapter || !engineSupportsResume(adapter)) {
        throw new ConflictError(
          `Engine ${provider ?? 'unknown'} does not support persisted-session resume`
        )
      }
      const sessionId = getLastSessionId?.(workspaceId, agentId)
      if (!sessionId) {
        throw new ConflictError('No persisted session to resume')
      }
      // A running agent is bounced so the relaunch actually reopens the
      // persisted session (the run bootstrap resumes whenever an id exists).
      if (getActiveRun(workspaceId, agentId)) {
        await this.stop(workspaceId, agentId)
      }
      await startAgentRun(workspaceId, agentId, { gachiPort: input.gachiPort ?? '' })
      return { resumed: true, session_id: sessionId }
    },

    async runContextAction(workspaceId, agentId, action) {
      const active = requireActiveRun(workspaceId, agentId)
      const { profile, provider } = resolveEngine(workspaceId, agentId)
      const command = profile?.contextCommands[action]
      if (!profile || !command) {
        throw new ConflictError(
          `Engine ${provider ?? 'unknown'} does not support /${action === 'clear' ? 'clear' : 'compact'}`
        )
      }
      if (writeInteractiveInput) {
        const accepted = writeInteractiveInput(workspaceId, agentId, command)
        if (!accepted) {
          throw new ConflictError(`No writable run for agent: ${agentId}`)
        }
      } else {
        // Fallback: raw write. CR is the Enter keystroke — a bare LF never
        // submits in ink/bubbletea TUIs, and even CR can be eaten when the
        // TUI is mid-render, so prefer the interactive seam when wired.
        writeRunInput(active.runId, `${command}\r`)
      }
      emitEvent?.(workspaceId, { payload: { action, agentId }, type: 'AGENT_CONTEXT_ACTION' })
      return { action, ok: true }
    },

    async setReasoning(workspaceId, agentId, rawLevel, input = {}) {
      const level = parseReasoningLevel(rawLevel)
      if (!level) {
        throw new ConflictError(
          `Unknown reasoning level; expected one of: ${REASONING_LEVELS.join(', ')}`
        )
      }
      const { config, profile, provider } = resolveEngine(workspaceId, agentId)
      if (!profile?.reasoningArgsByLevel[level]) {
        const supported = Object.keys(profile?.reasoningArgsByLevel ?? {}).join(', ') || 'none'
        throw new ConflictError(
          `Engine ${provider ?? 'unknown'} does not support reasoning level ${level}; supported: ${supported}`
        )
      }
      requireNoInFlightTask(workspaceId, agentId)
      const args = applyControlOverrides(config.args ?? [], profile, { reasoning: level })
      const restarted = await applyLaunchArgsAndRestart(
        workspaceId,
        agentId,
        args,
        input.gachiPort ?? ''
      )
      emitEvent?.(workspaceId, { payload: { agentId, level }, type: 'AGENT_REASONING_CHANGED' })
      return { level, restarted }
    },

    async start(workspaceId, agentId, input = {}) {
      if (getActiveRun(workspaceId, agentId)) {
        return { started: false }
      }
      resolveEngine(workspaceId, agentId)
      await startAgentRun(workspaceId, agentId, { gachiPort: input.gachiPort ?? '' })
      return { started: true }
    },

    async stop(workspaceId, agentId) {
      const active = requireActiveRun(workspaceId, agentId)
      await stopAgentGracefully(active.runId)
      return { stopped: true }
    },

    async switchModel(workspaceId, agentId, rawModel, input = {}) {
      const model = typeof rawModel === 'string' ? rawModel.trim() : ''
      if (!model) {
        throw new ConflictError('A non-empty model id is required')
      }
      const { config, profile, provider } = resolveEngine(workspaceId, agentId)
      if (!profile?.modelArg) {
        throw new ConflictError(
          `Engine ${provider ?? 'unknown'} does not support model switching via launch args`
        )
      }
      requireNoInFlightTask(workspaceId, agentId)
      const args = applyControlOverrides(config.args ?? [], profile, { model })
      const restarted = await applyLaunchArgsAndRestart(
        workspaceId,
        agentId,
        args,
        input.gachiPort ?? ''
      )
      emitEvent?.(workspaceId, { payload: { agentId, model }, type: 'AGENT_MODEL_CHANGED' })
      return { model, restarted }
    },
  }
}

export type { AgentUsageSnapshot } from './agent-telemetry.js'
