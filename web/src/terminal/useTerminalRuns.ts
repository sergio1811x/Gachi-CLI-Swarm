import { useEffect, useState } from 'react'

import { listTerminalRuns, type TerminalRunSummary } from '../api.js'

const REFRESH_INTERVAL_MS = 500
const MAX_REFRESH_INTERVAL_MS = 5000

const getRefreshDelay = (failureCount: number) =>
  Math.min(REFRESH_INTERVAL_MS * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)

export const orchestratorAgentId = (workspaceId: string) => `${workspaceId}:orchestrator`

const areTerminalRunsEqual = (a: TerminalRunSummary[], b: TerminalRunSummary[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((run, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      run.agent_id === other.agent_id &&
      run.agent_name === other.agent_name &&
      run.run_id === other.run_id &&
      run.status === other.status &&
      run.terminal_input_profile === other.terminal_input_profile
    )
  })
}

export const useTerminalRuns = (workspaceId: string | null): TerminalRunSummary[] => {
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunSummary[]>([])

  useEffect(() => {
    if (!workspaceId) {
      setTerminalRuns([])
      return
    }
    let cancelled = false
    let failureCount = 0
    let inFlight = false
    let timeout: number | undefined
    const scheduleNextLoad = () => {
      if (!cancelled) timeout = window.setTimeout(loadRuns, getRefreshDelay(failureCount))
    }
    const loadRuns = () => {
      if (inFlight) return
      inFlight = true
      void listTerminalRuns(workspaceId)
        .then((runs) => {
          if (cancelled) return
          failureCount = 0
          setTerminalRuns((current) => (areTerminalRunsEqual(current, runs) ? current : runs))
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            failureCount = Math.min(failureCount + 1, 4)
            setTerminalRuns((current) => (current.length === 0 ? current : []))
          }
          console.error('[gachi] swallowed:terminalRuns.list', error)
        })
        .finally(() => {
          inFlight = false
          scheduleNextLoad()
        })
    }
    loadRuns()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [workspaceId])

  return terminalRuns
}

export const findOrchestratorRun = (
  runs: TerminalRunSummary[],
  workspaceId: string
): TerminalRunSummary | undefined =>
  runs.find((run) => run.agent_id === orchestratorAgentId(workspaceId))

export const findRunByAgentId = (
  runs: TerminalRunSummary[],
  agentId: string
): TerminalRunSummary | undefined => runs.find((run) => run.agent_id === agentId)
