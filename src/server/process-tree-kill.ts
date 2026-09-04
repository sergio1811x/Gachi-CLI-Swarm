import { execFile } from 'node:child_process'

/**
 * Windows ConPTY reality check (production incident): killing the PTY host
 * (`pty.kill()`) routinely LEAVES the spawned CLI tree alive — claude.exe /
 * opencode.exe keep burning tokens while the UI shows the worker as stopped.
 *
 * Helpers here close that gap: verify liveness, escalate to a full tree kill
 * (`taskkill /T /F` on Windows), and never throw to callers — worst case an
 * orphan survives and the reconcile logger reports it.
 */

export const isPidAlive = (pid: number | null | undefined): boolean => {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Hard-kills the whole process tree; resolves even when the pid already died. */
export const killTree = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: 10_000 },
        () => resolve()
      )
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

export interface ProcessIdentity {
  creationMs: number
  commandLine: string | null
}

/**
 * Windows process identity for PID-reuse detection. Windows recycles PIDs
 * aggressively; a persisted pid from a previous daemon session may belong to
 * ANY process by the time a boot sweep runs (production: flow2api's python
 * was killed this way). The creation timestamp is the only reliable check
 * that the process is still the one the run spawned.
 *
 * Returns `null` when the process is gone or the query fails — callers must
 * treat "unknown identity" as "nothing to kill".
 */
export const getWindowsProcessIdentity = (pid: number): Promise<ProcessIdentity | null> => {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1 | ForEach-Object { '{0}|{1}' -f $_.CreationDate.ToFileTime(), $_.CommandLine })`,
      ],
      { windowsHide: true, timeout: 8_000 },
      (error, stdout) => {
        const line =
          String(stdout ?? '')
            .trim()
            .split(/\r?\n/)[0] ?? ''
        if (error || line === '') {
          resolve(null)
          return
        }
        const separator = line.indexOf('|')
        const ticks = Number.parseInt(separator === -1 ? line : line.slice(0, separator), 10)
        if (!Number.isFinite(ticks)) {
          resolve(null)
          return
        }
        resolve({
          // FILETIME is 100ns ticks since 1601-01-01 UTC.
          creationMs: Math.floor(ticks / 10_000) - 11_644_473_600_000,
          commandLine: separator === -1 ? null : line.slice(separator + 1),
        })
      }
    )
  })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Pending escalations registry: a daemon shutdown must not exit before the
 * spawned taskkill children had their chance — otherwise we reintroduce the
 * exact orphan problem this module exists to fix.
 */
const pendingEscalations = new Set<Promise<void>>()

export const trackStopEscalation = (task: Promise<void>): void => {
  const tracked = task.finally(() => pendingEscalations.delete(tracked))
  void tracked.catch(() => {})
  pendingEscalations.add(tracked)
}

export const waitForStopEscalations = async (timeoutMs = 4_000): Promise<void> => {
  if (pendingEscalations.size === 0) return
  await Promise.race([Promise.allSettled([...pendingEscalations]), delay(timeoutMs)])
}

/**
 * Graceful-then-hard stop: run the PTY's own stop(), give it a moment, then
 * escalate to a tree kill if the direct child is still alive. Fire-and-forget
 * safe — errors are logged, never thrown.
 */
export const stopRunProcessTree = async (
  pid: number | null | undefined,
  stop: () => void,
  graceMs = 600
): Promise<void> => {
  let stopError: unknown
  try {
    stop()
  } catch (error) {
    stopError = error
  }
  await delay(graceMs)
  if (!pid || !isPidAlive(pid)) {
    if (stopError && pid) {
      console.error(
        '[PROCESS] PTY stop failed but process is gone:',
        stopError instanceof Error ? stopError.message : stopError
      )
    }
    return
  }
  console.warn(`[PROCESS] PID ${pid} survived PTY stop — escalating to tree kill`)
  await killTree(pid)
  await delay(200)
  if (isPidAlive(pid)) {
    console.error(`[PROCESS] PID ${pid} STILL alive after tree kill`)
  }
}
