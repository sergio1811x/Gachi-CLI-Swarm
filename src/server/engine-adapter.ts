import { basename } from 'node:path'
import type { AgentDriver } from './cli-driver.js'
import { AGENT_DRIVERS } from './cli-driver.js'
import type { BuiltinCommandPresetDefaults } from './command-preset-defaults.js'
import { BUILTIN_COMMAND_PRESETS } from './command-preset-defaults.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

/**
 * Unified per-engine adapter seam between the runtime supervisor and a coding
 * CLI process.
 *
 * Each interactive engine is described once as an {@link AgentEngineAdapter}
 * that groups the CLI launch/resume facts (from a builtin command preset) with
 * the PTY readiness/input profile (from a CLI driver). Engines that are
 * interactive but have no builtin preset (e.g. agy, qwen) still expose an
 * adapter with `resumeArgsTemplate`/`sessionIdCapture` of `null`, making the
 * missing resume support explicit instead of implicit.
 *
 * The adapter is a composition view over the authoritative `AGENT_DRIVERS` and
 * `BUILTIN_COMMAND_PRESETS` tables (no data is duplicated here). Adding a new
 * engine means registering its driver and, when it supports resume, a builtin
 * preset; the adapter picks both up automatically.
 */
export interface AgentEngineAdapter {
  id: string
  command: string
  displayName: string
  interactive: boolean
  usesBracketedPaste: boolean
  slowRender: boolean
  readyTimeoutMs: number
  terminalInputProfile: AgentDriver['terminalInputProfile']
  hasPromptReady: AgentDriver['hasPromptReady']
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
}

const normalizeCommand = (command: string | null | undefined): string => {
  if (!command) return ''
  return basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/u, '')
}

const toAdapter = (
  driver: AgentDriver,
  preset: BuiltinCommandPresetDefaults | undefined
): AgentEngineAdapter => ({
  id: driver.id,
  command: driver.id,
  displayName: preset?.displayName ?? driver.name,
  interactive: driver.interactive,
  usesBracketedPaste: driver.usesBracketedPaste,
  slowRender: driver.slowRender,
  readyTimeoutMs: driver.readyTimeoutMs,
  terminalInputProfile: driver.terminalInputProfile,
  hasPromptReady: driver.hasPromptReady,
  resumeArgsTemplate: preset?.resumeArgsTemplate ?? null,
  sessionIdCapture: preset?.sessionIdCapture ?? null,
  yoloArgsTemplate: preset?.yoloArgsTemplate ?? null,
})

const presetByCommand = new Map(BUILTIN_COMMAND_PRESETS.map((preset) => [preset.command, preset]))

/**
 * One adapter per interactive engine, keyed by command name. Only interactive
 * engines get an adapter; non-interactive or unknown commands are handled by
 * the generic CLI driver and intentionally have no engine adapter.
 */
export const ENGINE_ADAPTERS: readonly AgentEngineAdapter[] = AGENT_DRIVERS.filter(
  (driver) => driver.interactive
).map((driver) => toAdapter(driver, presetByCommand.get(driver.id)))

const adapterByCommand = new Map(ENGINE_ADAPTERS.map((adapter) => [adapter.command, adapter]))

export const getEngineAdapter = (
  command: string | null | undefined
): AgentEngineAdapter | undefined => adapterByCommand.get(normalizeCommand(command))

export const getEngineAdapterById = (
  id: string | null | undefined
): AgentEngineAdapter | undefined => ENGINE_ADAPTERS.find((adapter) => adapter.id === id)

const implementsResume = (capture: SessionIdCaptureConfig | null | undefined): boolean =>
  capture?.source === 'claude_project_jsonl_dir' ||
  capture?.source === 'codex_session_jsonl_dir' ||
  capture?.source === 'gemini_session_json_dir' ||
  capture?.source === 'opencode_session_db'

const cheapExistenceCheck = (capture: SessionIdCaptureConfig | null | undefined): boolean =>
  capture?.source === 'claude_project_jsonl_dir' || capture?.source === 'opencode_session_db'

/**
 * Whether the engine can reopen a persisted session (has a realizable capture
 * source and a resume template).
 */
export const engineSupportsResume = (adapter: AgentEngineAdapter): boolean =>
  adapter.resumeArgsTemplate !== null && implementsResume(adapter.sessionIdCapture)

/**
 * Whether resuming should first verify the persisted session id still exists.
 * True only when that check is cheap (Claude dir scan, OpenCode DB query);
 * broad session-store scans trust the id and let the CLI fail fast.
 */
export const engineShouldVerifySessionBeforeResume = (adapter: AgentEngineAdapter): boolean =>
  engineSupportsResume(adapter) && cheapExistenceCheck(adapter.sessionIdCapture)
