import type { LiveAgentRun } from './agent-runtime-types.js'

export interface RunExitEntry {
  promise: Promise<void>
  resolve: () => void
}

export interface LiveRunRetentionOptions {
  /** Max number of finished runs kept in memory after the active cap is enforced. */
  maxFinishedRuns: number
  /** How long a finished run stays in memory before it is evicted. */
  finishedRunTtlMs: number
}

export interface LiveRunRegistry {
  add: (run: LiveAgentRun) => void
  createExitEntry: (runId: string) => void
  deleteExitEntry: (runId: string) => void
  get: (runId: string) => LiveAgentRun | undefined
  getExitEntry: (runId: string) => RunExitEntry | undefined
  clearPendingExitCode: (runId: string) => void
  getPendingExitCode: (runId: string) => number | null | undefined
  hasPendingExitCode: (runId: string) => boolean
  /** Flags a run as killed by us (manual stop, restart, shutdown) — not a CLI crash. */
  markStopRequested: (runId: string) => void
  wasStopRequested: (runId: string) => boolean
  list: () => LiveAgentRun[]
  listExitEntries: () => RunExitEntry[]
  remove: (runId: string) => void
  resolveExit: (runId: string) => void
  setPendingExitCode: (runId: string, exitCode: number | null) => void
}

const isFinished = (run: LiveAgentRun) => run.status === 'exited' || run.status === 'error'

export const createLiveRunRegistry = (
  retention: LiveRunRetentionOptions = {
    maxFinishedRuns: 20,
    finishedRunTtlMs: 10 * 60 * 1000,
  }
): LiveRunRegistry => {
  const liveRuns = new Map<string, LiveAgentRun>()
  const pendingExitCodes = new Map<string, number | null>()
  const runExitPromises = new Map<string, RunExitEntry>()
  const finishedAt = new Map<string, number>()
  const stopRequestedRunIds = new Set<string>()

  const evict = () => {
    const now = Date.now()
    for (const [runId, run] of liveRuns) {
      if (!isFinished(run)) continue
      const finishedTime = finishedAt.get(runId)
      if (finishedTime !== undefined && now - finishedTime > retention.finishedRunTtlMs) {
        liveRuns.delete(runId)
        finishedAt.delete(runId)
      }
    }

    const finished = Array.from(liveRuns.entries())
      .filter(([, run]) => isFinished(run))
      .sort(([leftId], [rightId]) => (finishedAt.get(leftId) ?? 0) - (finishedAt.get(rightId) ?? 0))
    const overflow = finished.length - retention.maxFinishedRuns
    for (const [runId] of finished.slice(0, Math.max(0, overflow))) {
      liveRuns.delete(runId)
      finishedAt.delete(runId)
    }
  }

  return {
    add(run) {
      liveRuns.set(run.runId, run)
      if (isFinished(run) && !finishedAt.has(run.runId)) {
        finishedAt.set(run.runId, Date.now())
      }
      evict()
    },
    createExitEntry(runId) {
      let resolve = () => {}
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve
      })
      runExitPromises.set(runId, { promise, resolve })
    },
    deleteExitEntry(runId) {
      runExitPromises.delete(runId)
    },
    clearPendingExitCode(runId) {
      pendingExitCodes.delete(runId)
    },
    get(runId) {
      return liveRuns.get(runId)
    },
    getExitEntry(runId) {
      return runExitPromises.get(runId)
    },
    getPendingExitCode(runId) {
      return pendingExitCodes.get(runId)
    },
    hasPendingExitCode(runId) {
      return pendingExitCodes.has(runId)
    },
    markStopRequested(runId) {
      stopRequestedRunIds.add(runId)
    },
    wasStopRequested(runId) {
      return stopRequestedRunIds.has(runId)
    },
    list() {
      return Array.from(liveRuns.values())
    },
    listExitEntries() {
      return Array.from(runExitPromises.values())
    },
    remove(runId) {
      liveRuns.delete(runId)
      pendingExitCodes.delete(runId)
      runExitPromises.delete(runId)
      finishedAt.delete(runId)
      stopRequestedRunIds.delete(runId)
    },
    resolveExit(runId) {
      const run = liveRuns.get(runId)
      if (run && isFinished(run) && !finishedAt.has(runId)) {
        finishedAt.set(runId, Date.now())
      }
      runExitPromises.get(runId)?.resolve()
      evict()
    },
    setPendingExitCode(runId, exitCode) {
      pendingExitCodes.set(runId, exitCode)
    },
  }
}
