import type { AgentRunSnapshot } from './agent-manager.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'

type PersistedRunStatus = PersistedAgentRun['status']

interface AgentRunSyncStore {
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
}

const MAX_RUN_OUTPUT_LENGTH = 1_000_000

const toPersistedStatus = (run: Pick<AgentRunSnapshot, 'status'> & { exitCode: number | null }) => {
  if (run.status === 'error' || run.status === 'exited' || run.status === 'starting') {
    return run.status
  }
  return run.exitCode === null ? 'running' : run.exitCode === 0 ? 'exited' : 'error'
}

export const syncPersistedRun = (
  run: LiveAgentRun,
  snapshot: AgentRunSnapshot,
  store: AgentRunSyncStore
) => {
  const nextStatus = toPersistedStatus(snapshot)
  const output = snapshot.output.slice(-MAX_RUN_OUTPUT_LENGTH)
  const persistedChanged = run.status !== nextStatus || run.exitCode !== snapshot.exitCode

  run.status = nextStatus
  run.output = output
  run.exitCode = snapshot.exitCode
  // Pause state lives only in memory; mirror it so registry consumers (team
  // list enrichment, recovery watchdog) see the current paused flag.
  run.paused = snapshot.paused

  // Output is never persisted to SQLite, so a pure output-growth (e.g. a
  // streaming terminal) must NOT trigger a row UPDATE on every chunk. Only
  // status/exitCode transitions are durable.
  if (persistedChanged) {
    store.updatePersistedRun(
      run.runId,
      nextStatus,
      snapshot.exitCode,
      nextStatus === 'exited' || nextStatus === 'error' ? Date.now() : null
    )
  }
  return run
}

export const completeLiveRun = (
  run: LiveAgentRun,
  exitCode: number | null,
  endedAt: number,
  store: AgentRunSyncStore
) => {
  run.status = exitCode === 0 ? 'exited' : 'error'
  run.exitCode = exitCode
  store.updatePersistedRun(run.runId, run.status, exitCode, endedAt)
}
