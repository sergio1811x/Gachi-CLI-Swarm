import type { OrchestratorStartResult } from './orchestrator-autostart.js'

/**
 * Restart attempt delays mirror the worker crash ladder (1m/5m/15m), but the
 * orchestrator never gives up: a headless swarm is worse than a periodic
 * retry. The index clamps at the last entry, so repeated failures keep a
 * 15-minute cadence until the underlying cause clears.
 */
const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000]

export interface OrchestratorSelfHealDeps {
  hasActiveRun: (workspaceId: string, orchestratorId: string) => boolean
  autostart: (workspaceId: string) => Promise<OrchestratorStartResult>
  /** Injectable clock for tests. */
  now?: () => number
}

export interface OrchestratorSelfHeal {
  (workspaceId: string): Promise<boolean>
  consecutiveFailures: (workspaceId: string) => number
}

/**
 * Wraps orchestrator autostart with per-workspace restart bookkeeping.
 *
 * Without this, a crashed orchestrator whose engine now insta-dies on start
 * (quota exhausted, broken session resume, CLI update) produced a silent
 * `{ok: false}` every heartbeat tick: the swarm stayed headless with nothing
 * in the logs. Attempts now back off on a ladder and every failed attempt is
 * logged with the real reason.
 */
export const createOrchestratorSelfHeal = (
  deps: OrchestratorSelfHealDeps
): OrchestratorSelfHeal => {
  const now = deps.now ?? Date.now
  const attempts = new Map<string, { failures: number; lastAttemptAt: number }>()

  const attemptState = (workspaceId: string) => {
    let state = attempts.get(workspaceId)
    if (!state) {
      state = { failures: 0, lastAttemptAt: 0 }
      attempts.set(workspaceId, state)
    }
    return state
  }

  const selfHeal: OrchestratorSelfHeal = async (workspaceId) => {
    const orchestratorId = `${workspaceId}:orchestrator`
    if (deps.hasActiveRun(workspaceId, orchestratorId)) {
      attempts.delete(workspaceId)
      return true
    }
    const state = attemptState(workspaceId)
    const delay = RETRY_DELAYS_MS[Math.min(state.failures, RETRY_DELAYS_MS.length - 1)] ?? 900_000
    if (now() - state.lastAttemptAt < delay) return false
    state.lastAttemptAt = now()
    const result = await deps.autostart(workspaceId)
    if (result.ok) {
      attempts.delete(workspaceId)
      return true
    }
    state.failures += 1
    console.warn(
      `[ORCHESTRATOR] autorestart unavailable for ${workspaceId.slice(0, 8)}: ${
        result.error ?? 'unknown reason'
      } (consecutive failures: ${state.failures})`
    )
    return false
  }

  selfHeal.consecutiveFailures = (workspaceId) => attemptState(workspaceId).failures
  return selfHeal
}
