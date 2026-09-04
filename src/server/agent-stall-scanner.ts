import type { FailureCategory } from './failure-classifier.js'
import {
  detectLiveDistress,
  LIVE_DISTRESS_TAIL_LINES,
  lastTailLines,
} from './failure-classifier.js'
import { DIALOG_RE } from './prompt-autoresponder.js'

/**
 * R10 stall problem (owner): workers freeze mid-run — a provider rate limit,
 * exhausted quota, an auth prompt or a TUI permission dialog the responder
 * could not clear — while their process stays ALIVE. Heartbeats keep ticking,
 * so everyone believes the worker is productive and the whole swarm stalls.
 *
 * The scanner rides the same PTY-tail tick as the prompt autoresponder and
 * edge-detects explicit distress signals in LIVE output. Every fresh signal
 * is escalated once per cooldown via `onStall` so the orchestrator gets a
 * direct push instead of silence.
 */

export type StallCategory = FailureCategory | 'permission-dialog'

export interface StallTarget {
  runId: string
  workspaceId: string
  agentId: string
  /** Recent PTY output for this run. */
  tail: string
}

export interface StallEvent {
  category: StallCategory
  /** One-line evidence, control chars stripped. */
  detail: string
  runId: string
  workspaceId: string
  agentId: string
}

export interface StallScannerDeps {
  getTargets: () => StallTarget[]
  onStall: (event: StallEvent) => void
  /** Same signal is re-escalated only after this long. */
  cooldownMs?: number
  intervalMs?: number
}

export interface StallScannerController {
  stop: () => void
  /** Runs one scan synchronously (exposed for tests). */
  tick: (now?: number) => void
  /** Test/inspection hook: true when this run+category fired recently. */
  recentlyNotified: (runId: string, category: StallCategory, now?: number) => boolean
}

const DEFAULT_COOLDOWN_MS = 10 * 60_000
const DEFAULT_INTERVAL_MS = 15_000

export const createAgentStallScanner = (deps: StallScannerDeps): StallScannerController => {
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const lastNotified = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null

  const detect = (tail: string): { category: StallCategory; detail: string } | null => {
    // Same trailing window as distress detection (B4): a dialog answered
    // moments ago scrolls out of the current screen as the CLI redraws, so
    // only a dialog that is STILL the worker's latest output escalates.
    const recent = lastTailLines(tail, LIVE_DISTRESS_TAIL_LINES)
    // A permission dialog still on screen after the responder's pass means
    // either `ask` mode or an exhausted Enter budget — both need a human.
    if (DIALOG_RE.test(recent)) {
      const line =
        recent.split(/\r?\n/).find((candidate) => DIALOG_RE.test(candidate)) ?? 'permission dialog'
      return { category: 'permission-dialog', detail: line.trim().slice(0, 200) }
    }
    return detectLiveDistress(tail)
  }

  const tick = (now = Date.now()): void => {
    try {
      for (const target of deps.getTargets()) {
        if (!target.tail) continue
        const hit = detect(target.tail)
        if (!hit) continue
        const key = `${target.runId}:${hit.category}`
        const previous = lastNotified.get(key)
        if (previous !== undefined && now - previous < cooldownMs) continue
        lastNotified.set(key, now)
        deps.onStall({
          agentId: target.agentId,
          category: hit.category,
          detail: hit.detail,
          runId: target.runId,
          workspaceId: target.workspaceId,
        })
      }
    } catch {
      // Never let the scanner kill the runtime.
    }
  }

  const start = (): void => {
    timer = setInterval(() => tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
    timer.unref?.()
  }
  start()

  return {
    recentlyNotified: (runId, category, now = Date.now()) => {
      const previous = lastNotified.get(`${runId}:${category}`)
      return previous !== undefined && now - previous < cooldownMs
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
