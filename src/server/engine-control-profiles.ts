import type { AgentLaunchConfigInput } from './agent-run-store.js'

/**
 * Reasoning effort levels from the control-plane spec. Not every engine can
 * express every level through launch args; `ENGINE_CONTROL_PROFILES` declares
 * exactly which levels each engine supports.
 */
export type ReasoningLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | 'MAX'

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'VERY_HIGH',
  'MAX',
]

export const parseReasoningLevel = (value: unknown): ReasoningLevel | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
  return REASONING_LEVELS.find((level) => level === normalized)
}

/**
 * A launch-arg override expressed as a flag/value pair. `{value}` renders the
 * raw value, `{value_lc}` its lowercase form.
 */
interface ControlArgTemplate {
  flag: string
  valueTemplate: string
}

const renderTemplate = (template: ControlArgTemplate, value: string): [string, string] => [
  template.flag,
  template.valueTemplate.replace('{value_lc}', value.toLowerCase()).replace('{value}', value),
]

export interface EngineControlProfile {
  engineId: string
  /** Launch args pinning the model; null when the engine has no stable flag. */
  modelArg: ControlArgTemplate | null
  /** Level → launch args. Missing levels are unsupported for this engine. */
  reasoningArgsByLevel: Partial<Record<ReasoningLevel, ControlArgTemplate>>
  /**
   * Slash commands written into the live PTY to manage context. null means the
   * command is not reliably supported by that engine.
   */
  contextCommands: { clear: string | null; compact: string | null }
}

/**
 * Per-engine control operations, kept conservative: an entry exists only when
 * the CLI documents a stable interface for it (launch flag or interactive
 * slash command). Unknown engines get no profile instead of guessed flags.
 */
export const ENGINE_CONTROL_PROFILES: Readonly<Record<string, EngineControlProfile>> = {
  claude: {
    contextCommands: { clear: '/clear', compact: '/compact' },
    engineId: 'claude',
    modelArg: { flag: '--model', valueTemplate: '{value}' },
    reasoningArgsByLevel: {},
  },
  codex: {
    contextCommands: { clear: '/new', compact: '/compact' },
    engineId: 'codex',
    modelArg: { flag: '-m', valueTemplate: '{value}' },
    reasoningArgsByLevel: {
      HIGH: { flag: '-c', valueTemplate: 'model_reasoning_effort={value_lc}' },
      LOW: { flag: '-c', valueTemplate: 'model_reasoning_effort={value_lc}' },
      MEDIUM: { flag: '-c', valueTemplate: 'model_reasoning_effort={value_lc}' },
    },
  },
  agy: {
    contextCommands: { clear: null, compact: '/compress' },
    engineId: 'agy',
    modelArg: { flag: '-m', valueTemplate: '{value}' },
    reasoningArgsByLevel: {},
  },
  qwen: {
    contextCommands: { clear: null, compact: '/compress' },
    engineId: 'qwen',
    modelArg: { flag: '-m', valueTemplate: '{value}' },
    reasoningArgsByLevel: {},
  },
  opencode: {
    // `/compact` is a stable OpenCode TUI command (verified live); `/clear`
    // differs between versions, so it stays disabled until pinned down.
    contextCommands: { clear: null, compact: '/compact' },
    engineId: 'opencode',
    modelArg: { flag: '-m', valueTemplate: '{value}' },
    reasoningArgsByLevel: {},
  },
}

export const getEngineControlProfile = (
  engineId: string | null | undefined
): EngineControlProfile | undefined =>
  engineId ? ENGINE_CONTROL_PROFILES[engineId.toLowerCase()] : undefined

/** Flags produced by any control template of this profile (for stripping). */
const controlFlags = (profile: EngineControlProfile): Set<string> => {
  const flags = new Set<string>()
  if (profile.modelArg) flags.add(profile.modelArg.flag)
  for (const template of Object.values(profile.reasoningArgsByLevel)) {
    if (template) flags.add(template.flag)
  }
  return flags
}

/**
 * Rewrites launch args with fresh control overrides: previously injected
 * control pairs are stripped first so a switch replaces rather than stacks,
 * then the new pairs are appended. Dimensions not present in `overrides`
 * keep their currently pinned value.
 */
export const applyControlOverrides = (
  args: readonly string[],
  profile: EngineControlProfile,
  overrides: { model?: string; reasoning?: ReasoningLevel }
): string[] => {
  const stripFlags = controlFlags(profile)
  const preserved: { model?: string; reasoning?: ReasoningLevel } = {}
  const kept: string[] = []
  let index = 0
  while (index < args.length) {
    const arg = args[index]
    if (arg === undefined) break
    if (stripFlags.has(arg)) {
      const value = args[index + 1]
      // Remember which dimension this pair pinned so switching one control
      // does not silently drop the other.
      if (profile.modelArg && arg === profile.modelArg.flag && value !== undefined) {
        preserved.model = value
      } else {
        for (const [level, template] of Object.entries(profile.reasoningArgsByLevel) as Array<
          [ReasoningLevel, ControlArgTemplate]
        >) {
          if (!template || template.flag !== arg || value === undefined) continue
          const literalPrefix = template.valueTemplate.split(/\{value[^}]*\}/)[0] ?? ''
          if (literalPrefix === '' || value.startsWith(literalPrefix)) preserved.reasoning = level
        }
      }
      // The flag consumes the following token as its value — skip both.
      index += 2
      continue
    }
    kept.push(arg)
    index += 1
  }

  const effective = {
    model: overrides.model ?? preserved.model,
    reasoning: overrides.reasoning ?? preserved.reasoning,
  }

  if (effective.model && profile.modelArg) {
    const [flag, value] = renderTemplate(profile.modelArg, effective.model)
    kept.push(flag, value)
  }
  if (effective.reasoning) {
    const template = profile.reasoningArgsByLevel[effective.reasoning]
    if (template) {
      const [flag, value] = renderTemplate(template, effective.reasoning)
      kept.push(flag, value)
    }
  }
  return kept
}

export interface CurrentControlOverrides {
  model: string | null
  reasoning: ReasoningLevel | null
}

/** Reads the currently pinned model/reasoning out of persisted launch args. */
export const readControlOverrides = (
  config: Pick<AgentLaunchConfigInput, 'args'>,
  profile: EngineControlProfile
): CurrentControlOverrides => {
  const args = config.args ?? []
  let model: string | null = null
  let reasoning: ReasoningLevel | null = null

  if (profile.modelArg) {
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === profile.modelArg.flag) {
        model = args[index + 1] ?? null
        break
      }
    }
  }
  for (const [level, template] of Object.entries(profile.reasoningArgsByLevel) as Array<
    [ReasoningLevel, ControlArgTemplate]
  >) {
    if (!template) continue
    const literalPrefix = template.valueTemplate.split(/\{value[^}]*\}/)[0] ?? ''
    for (let index = 0; index < args.length - 1; index += 1) {
      const value = args[index + 1]
      if (
        args[index] === template.flag &&
        value !== undefined &&
        (literalPrefix === '' || value.startsWith(literalPrefix))
      ) {
        reasoning = level
        break
      }
    }
  }
  return { model, reasoning }
}
