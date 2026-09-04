import { describe, expect, test } from 'vitest'

import { describeBackoff, retryBackoffMs } from '../../src/server/failure-policy.js'

describe('failure retry policies (ROADMAP R3)', () => {
  test('known categories map to their documented backoffs', () => {
    expect(retryBackoffMs('rate-limit')).toBe(5 * 60_000)
    expect(retryBackoffMs('quota')).toBe(30 * 60_000)
    expect(retryBackoffMs('auth')).toBe(15 * 60_000)
    expect(retryBackoffMs('network')).toBe(60_000)
    expect(retryBackoffMs('oom')).toBe(10 * 60_000)
    expect(retryBackoffMs('disk')).toBe(10 * 60_000)
    expect(retryBackoffMs('cli-missing')).toBe(30 * 60_000)
  })

  test('plain crashes keep the immediate-retry behavior', () => {
    // Crash/timeout/unknown have no entry → immediate redispatch as before.
    expect(retryBackoffMs('crash')).toBeNull()
    expect(retryBackoffMs('timeout')).toBeNull()
    expect(retryBackoffMs(null)).toBeNull()
    expect(retryBackoffMs(undefined)).toBeNull()
    expect(retryBackoffMs('something-new')).toBeNull()
  })

  test('describeBackoff renders human units', () => {
    expect(describeBackoff(60_000)).toBe('1m')
    expect(describeBackoff(90_000)).toBe('2m')
    expect(describeBackoff(45_000)).toBe('45s')
  })
})
