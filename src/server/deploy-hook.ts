import { exec } from 'node:child_process'

/**
 * R4 deploy hooks: an optional per-workspace shell command executed after the
 * worker's changes were merged back into main (worktree merge-back success).
 * Configured via app-state key `deploy_hook_command_<workspaceId>`; empty or
 * missing value means "no hook".
 */

export const DEPLOY_HOOK_KEY_PREFIX = 'deploy_hook_command_'

/** Hard cap so a hung deploy cannot stall run-exit bookkeeping forever. */
export const DEPLOY_HOOK_TIMEOUT_MS = 300_000

export interface DeployHookResult {
  ok: boolean
  /** Combined stdout/stderr (failure path includes the error message), tail-capped. */
  output: string
  durationMs: number
}

export type DeployHookRunner = (
  command: string,
  cwd: string,
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>

export const defaultDeployHookRunner: DeployHookRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })

const OUTPUT_TAIL_LIMIT = 2000

/**
 * Runs the hook and never throws: failures come back as `{ok:false}` with the
 * captured output so the caller can journal them.
 */
export const runDeployHook = async (
  command: string,
  cwd: string,
  runner: DeployHookRunner = defaultDeployHookRunner,
  timeoutMs: number = DEPLOY_HOOK_TIMEOUT_MS
): Promise<DeployHookResult> => {
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await runner(command, cwd, timeoutMs)
    return {
      ok: true,
      output: `${stdout}${stderr}`.trim().slice(-OUTPUT_TAIL_LIMIT),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean }
    const parts = [err.stdout, err.stderr]
    if (err.killed) parts.push(`deploy hook timed out after ${timeoutMs}ms`)
    parts.push(err.message)
    return {
      ok: false,
      output: parts.filter(Boolean).join('\n').trim().slice(-OUTPUT_TAIL_LIMIT),
      durationMs: Date.now() - startedAt,
    }
  }
}

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

/** Returns the configured command for the workspace, or null when unset/blank. */
export const readDeployHookCommand = (
  settings: AppStateReader,
  workspaceId: string
): string | null => {
  const value = settings.getAppState(`${DEPLOY_HOOK_KEY_PREFIX}${workspaceId}`)?.value ?? ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
