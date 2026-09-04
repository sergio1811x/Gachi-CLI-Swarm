import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'

/**
 * Wave 1.3 (audit H-2/L-3): Windows test-stability helpers.
 *
 * - `IS_WINDOWS` gates suites that genuinely require POSIX mechanics
 *   (shebang fakes executed directly, `/bin/bash -lc`), so they skip cleanly
 *   instead of producing environment noise that masks real regressions.
 * - `rmWithRetry` rides out the better-sqlite3/WAL vs antivirus EBUSY race
 *   on temp-dir cleanup.
 */

export const IS_WINDOWS = process.platform === 'win32'

/** Force-enable PTY-heavy suites on Windows from an interactive console. */
export const FORCE_PTY_TESTS = process.env.GACH_FORCE_PTY_TESTS === '1'

export const SKIP_POSIX_ONLY = IS_WINDOWS

/** ConPTY agent can fail to attach in non-interactive consoles on Windows. */
export const SKIP_CONPTY_WINDOWS = IS_WINDOWS && !FORCE_PTY_TESTS

const isBusyError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM'
}

const delaySync = (ms: number): void => {
  // Synchronous sleep (Atomics) keeps afterEach-compatible signatures while
  // yielding the thread — no busy-wait.
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, ms)
}

/**
 * rmSync with bounded retries for Windows AV/SQLite handle races.
 * Throws the last error if the path still cannot be removed.
 */
export const rmWithRetry = (
  path: string,
  options: { recursive?: boolean; force?: boolean; attempts?: number; backoffMs?: number } = {}
): void => {
  const attempts = options.attempts ?? 6
  const backoffMs = options.backoffMs ?? 150
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: options.recursive ?? true, force: options.force ?? true })
      return
    } catch (error) {
      if (attempt === attempts || !isBusyError(error)) throw error
      delaySync(backoffMs * attempt)
    }
  }
}

export const execFileText = async (
  file: string,
  args: string[],
  timeoutMs = 10_000
): Promise<string> => {
  const run = promisify(execFile)
  try {
    const { stdout } = await run(file, args, { timeout: timeoutMs, windowsHide: true })
    return stdout
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
