import { describe, expect, test } from 'vitest'

import {
  breakerPauseMs,
  ERROR_BUDGET_BASE_PAUSE_MS,
  ERROR_BUDGET_MAX_PAUSE_MS,
  isBreakerCooldownElapsed,
  isBreakerCoolingDown,
  readBreakerStage,
  readBreakerUntilMs,
} from '../../src/server/error-budget-breaker.js'

const makeSettings = (entries: Record<string, string>) => ({
  getAppState: (key: string) => (key in entries ? { value: entries[key] ?? null } : undefined),
})

describe('breaker cooldown ladder', () => {
  test('stage 0 pauses for the base 5 minutes', () => {
    expect(ERROR_BUDGET_BASE_PAUSE_MS).toBe(5 * 60_000)
    expect(breakerPauseMs(0)).toBe(ERROR_BUDGET_BASE_PAUSE_MS)
  })

  test('doubles per consecutive trip and caps at 60 minutes', () => {
    expect(breakerPauseMs(1)).toBe(10 * 60_000)
    expect(breakerPauseMs(2)).toBe(20 * 60_000)
    expect(breakerPauseMs(3)).toBe(40 * 60_000)
    expect(breakerPauseMs(4)).toBe(ERROR_BUDGET_MAX_PAUSE_MS)
    expect(breakerPauseMs(9)).toBe(ERROR_BUDGET_MAX_PAUSE_MS)
    expect(breakerPauseMs(-3)).toBe(ERROR_BUDGET_BASE_PAUSE_MS)
  })
})

describe('breaker state helpers', () => {
  const ws = 'ws1'
  const paused = {
    dispatch_paused_ws1: '1',
    dispatch_pause_until_ws1: '2000',
    dispatch_pause_stage_ws1: '2',
  }

  test('cooling down while the flag is set and the deadline is ahead', () => {
    const settings = makeSettings(paused)
    expect(isBreakerCoolingDown(settings, ws, 1500)).toBe(true)
    expect(isBreakerCoolingDown(settings, ws, 2000)).toBe(false)
    expect(isBreakerCooldownElapsed(settings, ws, 2500)).toBe(true)
    expect(readBreakerUntilMs(settings, ws)).toBe(2000)
    expect(readBreakerStage(settings, ws)).toBe(2)
  })

  test('a legacy pause without a deadline counts as elapsed', () => {
    const settings = makeSettings({ dispatch_paused_ws1: '1' })
    expect(isBreakerCoolingDown(settings, ws, 1000)).toBe(false)
    expect(isBreakerCooldownElapsed(settings, ws, 1000)).toBe(true)
  })

  test('no flag means neither cooling nor elapsed', () => {
    const settings = makeSettings({})
    expect(isBreakerCoolingDown(settings, ws, 1000)).toBe(false)
    expect(isBreakerCooldownElapsed(settings, ws, 1000)).toBe(false)
  })
})
