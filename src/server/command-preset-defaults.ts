import { CLAUDE_DEFAULT_YOLO_ARGS } from './claude-command-defaults.js'
import type { SessionIdCaptureConfig } from './session-capture.js'

export interface BuiltinCommandPresetDefaults {
  id: string
  displayName: string
  command: string
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
  yoloArgsTemplate: string[] | null
}

const CODEX_DEFAULT_YOLO_ARGS = ['--dangerously-bypass-approvals-and-sandbox']
const OPENCODE_DEFAULT_YOLO_ARGS: string[] = []

export const BUILTIN_COMMAND_PRESETS: BuiltinCommandPresetDefaults[] = [
  {
    command: 'claude',
    displayName: 'Claude Code (CC)',
    id: 'claude',
    resumeArgsTemplate: '--resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
      source: 'claude_project_jsonl_dir',
    },
    yoloArgsTemplate: CLAUDE_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'codex',
    displayName: 'Codex',
    id: 'codex',
    resumeArgsTemplate: 'resume {session_id}',
    sessionIdCapture: {
      pattern: '~/.codex/sessions/**/*.jsonl',
      source: 'codex_session_jsonl_dir',
    },
    yoloArgsTemplate: CODEX_DEFAULT_YOLO_ARGS,
  },
  {
    command: 'opencode',
    displayName: 'OpenCode',
    id: 'opencode',
    resumeArgsTemplate: '--session {session_id}',
    sessionIdCapture: {
      pattern: '~/.local/share/opencode/opencode.db',
      source: 'opencode_session_db',
    },
    yoloArgsTemplate: OPENCODE_DEFAULT_YOLO_ARGS,
  },
  {
    // Antigravity (agy) replaces the retired `gemini` CLI preset. Session
    // semantics are not yet mapped — no fabricated resume/capture here.
    command: 'agy',
    displayName: 'Antigravity (AGY)',
    id: 'agy',
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: null,
  },
]

export const getBuiltinCommandPreset = (id: string) =>
  BUILTIN_COMMAND_PRESETS.find((preset) => preset.id === id)

export interface AgentResumeAugmentation {
  resumeArgsTemplate: string | null
  sessionIdCapture: SessionIdCaptureConfig | null
}

/**
 * Derive session-resume fields from the builtin preset matching `command`, if
 * any. Used to let agents that deliberately avoid a full preset bind (e.g. the
 * orchestrator) still capture and reopen their previous session.
 */
export const getBuiltinResumeAugmentation = (
  command: string
): AgentResumeAugmentation | undefined => {
  const preset = getBuiltinCommandPreset(command)
  if (!preset) return undefined
  return {
    resumeArgsTemplate: preset.resumeArgsTemplate ?? null,
    sessionIdCapture: preset.sessionIdCapture ?? null,
  }
}
