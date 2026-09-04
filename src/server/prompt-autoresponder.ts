/**
 * Auto-unblock (user request: "оркестратор не может дать разрешение"):
 * builtin engines run in bypass-by-design modes, but their CLIs sometimes STILL
 * surface a confirmation dialog (folder access, trust-this-folder, update
 * prompt). When that happens the worker sits frozen while its task burns.
 *
 * This responder scans live PTY tails on a fixed cadence; any dialog pattern
 * triggers a single Enter keystroke into that run. Per-run budget prevents
 * infinite loops on dialogs where Enter doesn't help.
 */

const SCAN_INTERVAL_MS = 5_000
/** Max Enter keystrokes per runId per rolling minute. */
const MAX_SENDS_PER_WINDOW_MS = 60_000
const MAX_SENDS_PER_WINDOW = 5

/**
 * Exported so the stall scanner can escalate dialogs the responder could not
 * clear (budget exhausted) or that must stay for the human (`ask` mode).
 */
export const DIALOG_RE =
  /press enter to continue|bypass permissions|shift\+tab to cycle|do you allow|allow access|grant access|trust this (folder|project)|permission required|confirm\?|yes\/no/i

export interface AutoUnblockTarget {
  runId: string
  /** Last chunk of PTY output for this run. */
  tail: string
}

export interface AutoUnblockDeps {
  getTargets: () => AutoUnblockTarget[]
  sendEnter: (runId: string) => void
  onUnblocked?: (runId: string, attempt: number) => void
  intervalMs?: number
}

export interface AutoUnblockController {
  stop: () => void
  /** Runs one scan synchronously (exposed for tests). */
  tick: () => void
}

export const createPromptAutoResponder = (deps: AutoUnblockDeps): AutoUnblockController => {
  const budget = new Map<string, { windowStart: number; count: number }>()
  let timer: ReturnType<typeof setInterval> | null = null

  const withinBudget = (runId: string): boolean => {
    const now = Date.now()
    const entry = budget.get(runId)
    if (!entry || now - entry.windowStart >= MAX_SENDS_PER_WINDOW_MS) {
      budget.set(runId, { windowStart: now, count: 1 })
      return true
    }
    entry.count += 1
    return entry.count <= MAX_SENDS_PER_WINDOW
  }

  const tick = (): void => {
    try {
      for (const target of deps.getTargets()) {
        if (!DIALOG_RE.test(target.tail)) continue
        if (!withinBudget(target.runId)) {
          console.warn(
            `[AUTO-UNBLOCK] budget exhausted for ${target.runId.slice(0, 8)} — dialog may need manual action`
          )
          continue
        }
        deps.sendEnter(target.runId)
        const entry = budget.get(target.runId)
        deps.onUnblocked?.(target.runId, entry?.count ?? 0)
      }
    } catch {
      // Never let the unblocker kill the runtime.
    }
  }

  const start = (): void => {
    timer = setInterval(tick, deps.intervalMs ?? SCAN_INTERVAL_MS)
    timer.unref?.()
  }
  start()

  return {
    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
      budget.clear()
    },
    tick,
  }
}
