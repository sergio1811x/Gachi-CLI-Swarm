import { describe, expect, test } from 'vitest'

import {
  buildScheduledTaskInput,
  dayKey,
  hasOpenScheduledTask,
  isScheduleDue,
  parseScheduleConfig,
  scheduledMarker,
} from '../../src/server/agent-scheduler.js'

describe('parseScheduleConfig', () => {
  test('accepts interval and dailyAt forms, rejects garbage', () => {
    expect(parseScheduleConfig('{"intervalMinutes":60,"goal":"bump"}')).toEqual({
      goal: 'bump',
      intervalMinutes: 60,
    })
    expect(parseScheduleConfig('{"dailyAt":"09:30","goal":"digest","title":"Morning"}')).toEqual({
      dailyAt: '09:30',
      goal: 'digest',
      title: 'Morning',
    })
    expect(parseScheduleConfig('{"goal":"no rule"}')).toBeNull()
    expect(parseScheduleConfig('not json')).toBeNull()
    expect(parseScheduleConfig(null)).toBeNull()
  })
})

describe('isScheduleDue', () => {
  const MIN = 60_000

  test('interval: fires immediately first time, then only after the window', () => {
    const cfg = { goal: 'g', intervalMinutes: 60 }
    expect(isScheduleDue(cfg, null, 1_000)).toBe(true)
    expect(isScheduleDue(cfg, 1_000, 30 * MIN)).toBe(false)
    expect(isScheduleDue(cfg, 0, 60 * MIN)).toBe(true)
  })

  test('dailyAt: fires once per day at/after the time (catch-up after boot)', () => {
    const cfg = { dailyAt: '09:30', goal: 'g' }
    // 2026-08-27 10:00 local
    const now = new Date(2026, 7, 27, 10, 0).getTime()
    expect(isScheduleDue(cfg, null, now)).toBe(true)

    const firedToday945 = new Date(2026, 7, 27, 9, 45).getTime()
    expect(isScheduleDue(cfg, firedToday945, now)).toBe(false)

    const firedYesterday = new Date(2026, 7, 26, 12, 0).getTime()
    expect(isScheduleDue(cfg, firedYesterday, now)).toBe(true)

    // Before today's time → not due even if last fire was yesterday.
    const nowEarly = new Date(2026, 7, 28, 8, 0).getTime()
    expect(isScheduleDue(cfg, firedYesterday, nowEarly)).toBe(false)
  })

  test('config without a rule never fires', () => {
    expect(isScheduleDue({ goal: 'x' }, null, Date.now())).toBe(false)
  })
})

describe('anti-flood marker + task payload', () => {
  test('hasOpenScheduledTask finds open copies only', () => {
    const marker = scheduledMarker('ws1')
    const open = { description: `${marker}\nwork`, status: 'running' }
    const done = { description: `${marker}\nwork`, status: 'done' }
    const other = { description: 'plain task', status: 'ready' }
    expect(hasOpenScheduledTask([done, other], marker)).toBe(false)
    expect(hasOpenScheduledTask([open], marker)).toBe(true)
  })

  test('buildScheduledTaskInput embeds marker and derives title', () => {
    const input = buildScheduledTaskInput({ goal: 'nightly dependency bump\nextra line' }, 'ws1')
    expect(input.description).toContain(scheduledMarker('ws1'))
    expect(input.description).toContain('nightly dependency bump')
    expect(input.title.startsWith('⟳')).toBe(true)
  })
})

test('dayKey formats local date', () => {
  expect(dayKey(new Date(2026, 7, 27, 5, 3).getTime())).toBe('2026-08-27')
})
