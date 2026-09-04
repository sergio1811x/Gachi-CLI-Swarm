/**
 * Worker health (ROADMAP R3.2): a rolling success-rate over recent terminal
 * runs, consumed by the dispatcher's worker scoring. `null` = not enough
 * signal yet — the agent is treated as neutral.
 */

export interface HealthRun {
  exitCode: number | null
  status: 'starting' | 'running' | 'exited' | 'error'
}

export const ROLLING_HEALTH_WINDOW = 10

/** 1.0 = all recent terminal runs exited cleanly; null when no terminal runs. */
export const rollingSuccessRate = (
  runs: HealthRun[],
  window = ROLLING_HEALTH_WINDOW
): number | null => {
  const terminal = runs.filter((run) => run.status === 'exited' || run.status === 'error')
  const recent = terminal.slice(-window)
  if (recent.length === 0) return null
  const healthy = recent.filter(
    (run) => run.status === 'exited' && (run.exitCode === 0 || run.exitCode === null)
  ).length
  return healthy / recent.length
}

/**
 * Score contribution for worker selection: healthy agents get up to +25,
 * failing ones down to -25, no signal is neutral (+0).
 */
export const healthScoreBonus = (rate: number | null): number =>
  rate === null ? 0 : Math.round((rate - 0.5) * 50)
