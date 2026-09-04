import { ENGINE_ADAPTERS, engineSupportsResume } from './engine-adapter.js'
import {
  getEngineControlProfile,
  REASONING_LEVELS,
  type ReasoningLevel,
} from './engine-control-profiles.js'

/**
 * Control-plane capability record for one interactive engine (spec Part 2 §1).
 * Derived from the engine adapters + control profiles — adding an engine to
 * `AGENT_DRIVERS`/`BUILTIN_COMMAND_PRESETS` updates this automatically.
 */
export interface AgentCapabilityRecord {
  /** Slash commands supported for live context management. */
  contextCommands: { clear: string | null; compact: string | null }
  displayName: string
  features: {
    contextControl: boolean
    modelSwitch: boolean
    reasoningControl: boolean
  }
  provider: string
  /** Whether the engine can reopen a persisted session (migration contract). */
  resumeSupported: boolean
  /** Well-known model ids offered as switch suggestions (not exhaustive). */
  suggestedModels: string[]
  supportedReasoningLevels: ReasoningLevel[]
}

const SUGGESTED_MODELS: Readonly<Record<string, readonly string[]>> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5', 'o3'],
  agy: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  opencode: [],
  qwen: ['qwen3-coder-plus'],
}

export const listAgentCapabilities = (): AgentCapabilityRecord[] =>
  ENGINE_ADAPTERS.map((adapter) => {
    const profile = getEngineControlProfile(adapter.id)
    const supportedReasoningLevels = REASONING_LEVELS.filter(
      (level) => profile?.reasoningArgsByLevel[level] !== undefined
    )
    return {
      contextCommands: profile?.contextCommands ?? { clear: null, compact: null },
      displayName: adapter.displayName,
      features: {
        contextControl: Boolean(profile?.contextCommands.compact || profile?.contextCommands.clear),
        modelSwitch: Boolean(profile?.modelArg),
        reasoningControl: supportedReasoningLevels.length > 0,
      },
      provider: adapter.id,
      resumeSupported: engineSupportsResume(adapter),
      suggestedModels: [...(SUGGESTED_MODELS[adapter.id] ?? [])],
      supportedReasoningLevels,
    }
  })

export const getAgentCapability = (
  provider: string | null | undefined
): AgentCapabilityRecord | undefined =>
  provider ? listAgentCapabilities().find((record) => record.provider === provider) : undefined
