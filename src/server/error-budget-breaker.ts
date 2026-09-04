/**
 * R10 error-budget circuit breaker (replaces the human-only sticky pause).
 *
 * Semantics: crossing the failure threshold opens the breaker — dispatch
 * pauses for a cooldown — and then RESUMES AUTOMATICALLY. Repeated breaches
 * without an intervening success escalate the cooldown (5m → 10m → 20m → 40m
 * → 60m cap); a clean run or a manual resume fully closes the breaker. This
 * keeps the protective property (a broken workspace stops hammering) without
 * the old behavior of freezing the board until a human clicked resume.
 *
 * State (app-state, per workspace):
 * - `dispatch_paused_<wsId>`  '1' while open (UI banner + gate reads).
 * - `dispatch_pause_until_<wsId>`  epoch ms when the cooldown elapses.
 * - `dispatch_pause_stage_<wsId>`  consecutive trips for the ladder.
 */

import { DISPATCH_PAUSED_KEY_PREFIX, MEMORY_PAUSE_KEY } from './permission-mode.js'

export const BREAKER_UNTIL_KEY_PREFIX = 'dispatch_pause_until_'
export const BREAKER_STAGE_KEY_PREFIX = 'dispatch_pause_stage_'

export const ERROR_BUDGET_BASE_PAUSE_MS = 5 * 60_000
export const ERROR_BUDGET_MAX_PAUSE_MS = 60 * 60_000

/** Pure cooldown ladder: stage 0 → base, doubling, capped. */
export const breakerPauseMs = (stage: number): number =>
  Math.min(
    ERROR_BUDGET_MAX_PAUSE_MS,
    ERROR_BUDGET_BASE_PAUSE_MS * 2 ** Math.max(0, Math.floor(stage))
  )

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

export const readBreakerUntilMs = (settings: AppStateReader, workspaceId: string): number => {
  const raw = settings.getAppState(`${BREAKER_UNTIL_KEY_PREFIX}${workspaceId}`)?.value
  const parsed = Number(raw)
  return raw !== undefined && Number.isFinite(parsed) ? parsed : 0
}

export const readBreakerStage = (settings: AppStateReader, workspaceId: string): number => {
  const raw = settings.getAppState(`${BREAKER_STAGE_KEY_PREFIX}${workspaceId}`)?.value
  const parsed = Number(raw)
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/** True while the breaker is open and the cooldown has NOT elapsed yet. */
export const isBreakerCoolingDown = (
  settings: AppStateReader,
  workspaceId: string,
  now: number
): boolean =>
  settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`)?.value === '1' &&
  now < readBreakerUntilMs(settings, workspaceId)

/** True when the breaker flag is set but its cooldown already elapsed. */
export const isBreakerCooldownElapsed = (
  settings: AppStateReader,
  workspaceId: string,
  now: number
): boolean =>
  settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`)?.value === '1' &&
  !isBreakerCoolingDown(settings, workspaceId, now)

/** Memory watchdog hold — global, auto-cleared by the watchdog's hysteresis. */
export const isMemoryHoldActive = (settings: AppStateReader): boolean =>
  settings.getAppState(MEMORY_PAUSE_KEY)?.value === '1'
