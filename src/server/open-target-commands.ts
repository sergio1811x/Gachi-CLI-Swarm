import { type ExecFileOptions, execFile } from 'node:child_process'

import {
  getDefaultOpenTargetIdForPlatform,
  getEffectiveOpenTargetId,
  isOpenTargetId,
  type OpenTargetId,
  type OpenTargetPlatform,
  type OpenWorkspaceErrorCode,
} from '../shared/open-targets.js'

export type {
  OpenTargetId,
  OpenTargetPlatform,
  OpenWorkspaceErrorCode,
} from '../shared/open-targets.js'
export {
  getEffectiveOpenTargetId,
  isOpenTargetId,
  isOpenTargetSupported,
  OPEN_TARGET_IDS_BY_PLATFORM,
} from '../shared/open-targets.js'

export const resolveOpenTargetPlatform = (platform: NodeJS.Platform): OpenTargetPlatform => {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'other'
}

export interface OpenAttempt {
  command: string
  args: string[]
}

const macAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'open', args: [path] }]
    case 'vscode':
      return [{ command: 'open', args: ['-a', 'Visual Studio Code', path] }]
    case 'vscode-insiders':
      return [{ command: 'open', args: ['-a', 'Visual Studio Code - Insiders', path] }]
    case 'cursor':
      return [{ command: 'open', args: ['-a', 'Cursor', path] }]
    case 'terminal':
      return [{ command: 'open', args: ['-a', 'Terminal', path] }]
    case 'ghostty':
      return [{ command: 'open', args: ['-a', 'Ghostty', path] }]
    case 'zed':
      return [{ command: 'open', args: ['-a', 'Zed', path] }]
  }
}

const linuxAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'xdg-open', args: [path] }]
    case 'vscode':
      return [{ command: 'code', args: [path] }]
    case 'vscode-insiders':
      return [{ command: 'code-insiders', args: [path] }]
    case 'cursor':
      return [{ command: 'cursor', args: [path] }]
    case 'zed':
      return [{ command: 'zed', args: [path] }]
    default:
      return [{ command: 'xdg-open', args: [path] }]
  }
}

const windowsAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'explorer', args: [path] }]
    case 'vscode':
      return [{ command: 'code', args: [path] }]
    case 'vscode-insiders':
      return [{ command: 'code-insiders', args: [path] }]
    case 'cursor':
      return [{ command: 'cursor', args: [path] }]
    case 'zed':
      return [{ command: 'zed', args: [path] }]
    default:
      return [{ command: 'explorer', args: [path] }]
  }
}

/**
 * Returns the ordered list of commands to try. First success wins; remaining
 * entries are fallbacks (e.g. IntelliJ IDEA → IntelliJ IDEA CE on older Macs).
 * Empty list means the requested target is unsupported on this platform —
 * callers should have already routed through `getEffectiveOpenTargetId` to
 * fall back, so this should never happen in practice.
 */
export const buildOpenAttempts = (
  targetId: OpenTargetId,
  path: string,
  platform: OpenTargetPlatform
): OpenAttempt[] => {
  const effectiveTargetId = getEffectiveOpenTargetId(targetId, platform)
  if (platform === 'mac') return macAttempts(effectiveTargetId, path)
  if (platform === 'linux') return linuxAttempts(effectiveTargetId, path)
  if (platform === 'windows') return windowsAttempts(effectiveTargetId, path)
  return [{ command: 'open', args: [path] }]
}

export interface OpenCommandSuccess {
  ok: true
  effectiveTargetId: OpenTargetId
}

export interface OpenCommandFailure {
  ok: false
  effectiveTargetId: OpenTargetId
  errorCode: OpenWorkspaceErrorCode
  stderr: string
}

export type OpenCommandResult = OpenCommandSuccess | OpenCommandFailure

interface SpawnResult {
  stderr: string
  stdout: string
  status: number | null
  signal: string | null
  spawnError: NodeJS.ErrnoException | null
}

export type RunOpenCommand = (
  command: string,
  args: string[],
  options: ExecFileOptions
) => Promise<SpawnResult>

interface ExecFileError extends NodeJS.ErrnoException {
  signal?: NodeJS.Signals | null
}

const defaultRunOpenCommand: RunOpenCommand = (command, args, options) =>
  new Promise<SpawnResult>((resolve) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const errno = error as ExecFileError | null
      resolve({
        stderr: String(stderr ?? ''),
        stdout: String(stdout ?? ''),
        status: typeof errno?.code === 'number' ? errno.code : (child.exitCode ?? 0),
        signal: typeof errno?.signal === 'string' ? errno.signal : null,
        spawnError:
          errno && typeof errno.code === 'string' ? (errno as NodeJS.ErrnoException) : null,
      })
    })
  })

const APP_NOT_INSTALLED_PATTERNS = [
  /unable to find application/i,
  /can'?t find/i,
  /not authorized to send keystrokes/i,
  /application can'?t be found/i,
]

const classifyFailure = (result: SpawnResult): OpenWorkspaceErrorCode => {
  if (result.spawnError?.code === 'ENOENT') return 'command-not-in-path'
  const stderr = result.stderr.toLowerCase()
  if (APP_NOT_INSTALLED_PATTERNS.some((re) => re.test(stderr))) return 'app-not-installed'
  return 'unknown'
}

export interface OpenWorkspaceInput {
  path: string
  targetId: OpenTargetId
}

export interface OpenWorkspaceOptions {
  platform?: NodeJS.Platform
  runCommand?: RunOpenCommand
}

/**
 * Workspace paths originate from the OS folder picker or from manual paste;
 * the picker output is sandbox-validated at create time, but a path stored
 * before path-validation existed (or one pasted into a hypothetical migration
 * future) could contain `\n` / `\0`. Reject those here so we never hand an
 * ambiguous path to `xdg-open`, where shell wrappers split on newline.
 */
export const isOpenWorkspacePathSafe = (path: string): boolean => {
  if (path.length === 0) return false
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code === 0 || code === 10 || code === 13) return false
  }
  return true
}

export const openWorkspace = async (
  input: OpenWorkspaceInput,
  options: OpenWorkspaceOptions = {}
): Promise<OpenCommandResult> => {
  const platform = resolveOpenTargetPlatform(options.platform ?? process.platform)
  const run = options.runCommand ?? defaultRunOpenCommand

  if (!isOpenTargetId(input.targetId)) {
    return {
      ok: false,
      effectiveTargetId: getDefaultOpenTargetIdForPlatform(platform),
      errorCode: 'invalid-target',
      stderr: `Unknown open target: ${String(input.targetId)}`,
    }
  }

  if (!isOpenWorkspacePathSafe(input.path)) {
    return {
      ok: false,
      effectiveTargetId: input.targetId,
      errorCode: 'invalid-path',
      stderr: 'Workspace path contains newline or null byte and was rejected.',
    }
  }

  const effectiveTargetId = getEffectiveOpenTargetId(input.targetId, platform)
  const attempts = buildOpenAttempts(input.targetId, input.path, platform)

  let lastFailure: SpawnResult | null = null
  for (const attempt of attempts) {
    const result = await run(attempt.command, attempt.args, {})

    // Windows `explorer.exe` returns exit code 1 even on success — checking
    // exit code here would surface a spurious error to the user on every
    // File Explorer open. spawnError still catches the "explorer not on PATH"
    // case, which is the only real failure mode worth surfacing.
    if (attempt.command === 'explorer') {
      if (result.spawnError?.code === 'ENOENT') {
        lastFailure = result
        continue
      }
      return { ok: true, effectiveTargetId }
    }

    if (!result.spawnError && (result.status === 0 || result.status === null)) {
      return { ok: true, effectiveTargetId }
    }
    lastFailure = result
  }

  const fallback: SpawnResult = lastFailure ?? {
    stderr: 'No command attempts were made.',
    stdout: '',
    status: null,
    signal: null,
    spawnError: null,
  }
  return {
    ok: false,
    effectiveTargetId,
    errorCode: classifyFailure(fallback),
    stderr: fallback.stderr.trim() || fallback.stdout.trim() || 'Failed to open workspace.',
  }
}
