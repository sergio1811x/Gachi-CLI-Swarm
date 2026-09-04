import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readEnv } from './env.js'

/**
 * Orchestrator feedback follow-up to S-1: the startup-instruction paste only
 * lands when the CLI's TUI is ready. A cold start with a large context can
 * swallow the paste for MINUTES (evidence: session file created 6 min after
 * run start), so one-shot delivery starved both the agent of its instructions
 * AND session capture of the ownership marker.
 *
 * The monitor re-pastes on a fixed cadence until the binding marker shows up
 * inside a Claude session JSONL written after `sinceMs`, giving up after
 * `maxAttempts`. Claude-family engines only; other engines keep single-shot.
 */

const MARKER = 'Gachi session binding: workspace_id='

const encodeClaudeProjectPath = (cwd: string): string => cwd.replace(/[\\/:\s]/g, '-')

const projectsRoot = (): string =>
  readEnv('CLAUDE_PROJECTS_DIR') ?? join(homedir(), '.claude', 'projects')

const TAIL_BYTES = 512 * 1024

/** Reads the last TAIL_BYTES of a file as utf8 — markers land in appended messages, so the tail is enough and 16 MB transcripts stay cheap to probe. */
const readFileTail = (path: string): string | null => {
  let fd: number | null = null
  try {
    const stats = statSync(path)
    const start = Math.max(0, stats.size - TAIL_BYTES)
    const length = stats.size - start
    const buffer = Buffer.alloc(length)
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

/** True when any session JSONL modified after `sinceMs` contains the marker. */
export const claudeMarkerConfirmed = (cwd: string, sinceMs: number): boolean => {
  const dir = join(projectsRoot(), encodeClaudeProjectPath(cwd))
  if (!existsSync(dir)) return false
  let candidates: Array<{ path: string; mtimeMs: number }>
  try {
    candidates = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const path = join(dir, entry.name)
        try {
          return { path, mtimeMs: statSync(path).mtimeMs }
        } catch {
          return { path, mtimeMs: 0 }
        }
      })
      .filter((entry) => entry.mtimeMs >= sinceMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3)
      .map((entry) => ({ path: entry.path, mtimeMs: entry.mtimeMs }))
  } catch {
    return false
  }
  for (const candidate of candidates) {
    const content = readFileTail(candidate.path)
    if (content?.includes(MARKER)) return true
  }
  return false
}

export interface DeliveryMonitorOptions {
  /** Returns true while the PTY run is still alive. */
  isRunAlive: () => boolean
  /** Re-delivers the instruction payload. */
  repaste: () => void
  /** Confirms whether the payload has landed (marker seen). */
  isConfirmed: () => boolean
  intervalMs?: number
  maxAttempts?: number
  onGiveUp?: () => void
  onConfirmed?: () => void
}

/**
 * Re-paste loop: first check waits one interval (the initial paste already
 * happened synchronously); every unconfirmed tick fires another paste. Stops
 * on confirmation, dead run, or attempt budget exhaustion.
 */
export const startDeliveryMonitor = (options: DeliveryMonitorOptions): void => {
  const intervalMs = options.intervalMs ?? 5_000
  // 120 × 5s = 10 minutes — matches the capture window; a cold TUI stuck in
  // "connecting…" can delay the first accepted paste by many minutes.
  const maxAttempts = options.maxAttempts ?? 120
  let attempts = 0
  const tick = (): void => {
    attempts += 1
    try {
      if (!options.isRunAlive()) return
      if (options.isConfirmed()) {
        options.onConfirmed?.()
        return
      }
      if (attempts > maxAttempts) {
        options.onGiveUp?.()
        return
      }
      options.repaste()
    } catch {
      // Never let diagnostics kill the runtime.
    }
    setTimeout(tick, intervalMs).unref?.()
  }
  setTimeout(tick, intervalMs).unref?.()
}

export { MARKER as BINDING_MARKER_PREFIX }
