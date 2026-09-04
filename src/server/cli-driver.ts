import { basename } from 'node:path'

/**
 * CLI-specific behavior used by the engine-agnostic agent runtime.
 *
 * A new coding CLI is added by registering one driver; the PTY lifecycle,
 * persistence, and workspace orchestration remain shared.
 */
export interface AgentDriver {
  id: string
  name: string
  interactive: boolean
  usesBracketedPaste: boolean
  slowRender: boolean
  readyTimeoutMs: number
  terminalInputProfile: 'default' | 'opencode'
  hasPromptReady(output: string): boolean
}

/** @deprecated Use AgentDriver for new runtime code. */
export type CliDriver = AgentDriver

const DEFAULT_READY_TIMEOUT_MS = 3000
const SLOW_RENDER_TIMEOUT_MS = 15000

const hasGenericPrompt = (output: string) => /(?:^|[\r\n])\s*[❯›?>]\s*/u.test(output)
const hasGeminiPrompt = (output: string) => /\bType your message\b/u.test(output)

const driver = (definition: AgentDriver): AgentDriver => definition

export const AGENT_DRIVERS: readonly AgentDriver[] = [
  driver({
    id: 'claude',
    name: 'Claude Code',
    interactive: true,
    usesBracketedPaste: true,
    slowRender: false,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    terminalInputProfile: 'default',
    hasPromptReady: hasGenericPrompt,
  }),
  driver({
    id: 'codex',
    name: 'Codex',
    interactive: true,
    usesBracketedPaste: true,
    slowRender: false,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    terminalInputProfile: 'default',
    hasPromptReady: hasGenericPrompt,
  }),
  driver({
    id: 'agy',
    name: 'Antigravity',
    interactive: true,
    usesBracketedPaste: true,
    slowRender: true,
    readyTimeoutMs: SLOW_RENDER_TIMEOUT_MS,
    terminalInputProfile: 'default',
    hasPromptReady: hasGeminiPrompt,
  }),
  driver({
    id: 'opencode',
    name: 'OpenCode',
    interactive: true,
    usesBracketedPaste: true,
    slowRender: true,
    readyTimeoutMs: SLOW_RENDER_TIMEOUT_MS,
    terminalInputProfile: 'opencode',
    hasPromptReady: hasGenericPrompt,
  }),
  driver({
    id: 'qwen',
    name: 'Qwen Code',
    interactive: true,
    usesBracketedPaste: false,
    slowRender: true,
    readyTimeoutMs: SLOW_RENDER_TIMEOUT_MS,
    terminalInputProfile: 'default',
    hasPromptReady: hasGenericPrompt,
  }),
]

/**
 * Fallback driver for any unknown command (node, python, shell scripts, custom
 * binaries). These are treated as non-interactive so post-start input is written
 * immediately instead of waiting for a prompt that never arrives. Known generic
 * agent CLIs (e.g. qwen) get an explicit interactive driver above.
 */
const GENERIC_DRIVER: AgentDriver = driver({
  id: 'generic',
  name: 'Generic CLI',
  interactive: false,
  usesBracketedPaste: false,
  slowRender: false,
  readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
  terminalInputProfile: 'default',
  hasPromptReady: hasGenericPrompt,
})

const normalizeCommand = (command: string | null | undefined): string => {
  if (!command) return ''
  const name = basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/u, '')
  // Retired CLI names map to their replacement driver.
  return name === 'gemini' ? 'agy' : name
}

export const getAgentDriver = (command: string | null | undefined): AgentDriver => {
  const name = normalizeCommand(command)
  if (!name) return GENERIC_DRIVER
  return AGENT_DRIVERS.find((item) => item.id === name) ?? GENERIC_DRIVER
}

export const getAgentDriverById = (id: string | null | undefined): AgentDriver | undefined =>
  AGENT_DRIVERS.find((item) => item.id === id)

/** @deprecated Use AGENT_DRIVERS for new runtime code. */
export const CLI_DRIVERS = AGENT_DRIVERS

/** @deprecated Use getAgentDriver for new runtime code. */
export const getCliDriver = getAgentDriver

/** @deprecated Use getAgentDriverById for new runtime code. */
export const getCliDriverById = getAgentDriverById

export const isInteractiveAgentCommand = (command: string | null | undefined): boolean =>
  getAgentDriver(command).interactive
