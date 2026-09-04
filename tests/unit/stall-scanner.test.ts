import { describe, expect, test, vi } from 'vitest'
import {
  createAgentStallScanner,
  type StallEvent,
  type StallTarget,
} from '../../src/server/agent-stall-scanner.js'
import { detectLiveDistress } from '../../src/server/failure-classifier.js'

describe('detectLiveDistress (live workers)', () => {
  test('flags rate-limit / quota / auth in live output', () => {
    expect(detectLiveDistress('retrying… rate limit exceeded, waiting')?.category).toBe(
      'rate-limit'
    )
    expect(detectLiveDistress('Error: quota exceeded for this project')?.category).toBe('quota')
    expect(detectLiveDistress('invalid api key — please log in')?.category).toBe('auth')
  })

  test('healthy spinner output never false-positives', () => {
    expect(detectLiveDistress('⠋ thinking… (esc to interrupt · 42% context left)')).toBeNull()
    expect(detectLiveDistress('')).toBeNull()
    expect(detectLiveDistress('Reading src/server/tasks-file.ts…')).toBeNull()
  })

  // B4 regressions: numeric status codes inside ordinary working output used
  // to read as auth/rate-limit/quota distress.
  test('bare numbers in source paths, URLs and versions are not status codes', () => {
    expect(
      detectLiveDistress('webpack building…\n  error at src/app.ts:429:5\n  at 401:12')
    ).toBeNull()
    expect(detectLiveDistress('fetching https://api.example.com/v2/402/items done')).toBeNull()
    expect(detectLiveDistress('upgraded engine v1.429.0 → v1.430.0, restarting hooks')).toBeNull()
    expect(detectLiveDistress('node_modules/.pnpm/core@401.2.1/index.js loaded')).toBeNull()
  })

  test('real status codes in an error context still classify', () => {
    expect(detectLiveDistress('API error 429: too many requests')?.category).toBe('rate-limit')
    expect(detectLiveDistress('HTTP 401 Unauthorized from provider')?.category).toBe('auth')
    expect(detectLiveDistress('request failed: 402 payment required')?.category).toBe('quota')
  })

  test('oom needs a word boundary — "Bloom filter" is not OOM', () => {
    expect(detectLiveDistress('Building Bloom filter for dedupe… 12 MB used')).toBeNull()
    expect(detectLiveDistress('FATAL: heap out of memory')?.category).toBe('oom')
  })

  test('distress that scrolled out of the recent screen does not re-alert', () => {
    // A worker that hit a 429 hours ago and recovered keeps the old line in
    // its transcript tail; only the current screen state should escalate.
    const history = [
      'API error 429: too many requests',
      'retrying after backoff…',
      ...Array.from({ length: 20 }, (_, i) => 'compiling module ' + i + ' ok'),
    ].join('\n')
    expect(detectLiveDistress(history)).toBeNull()
    // The same distress as the LATEST output still escalates.
    const fresh = [
      ...Array.from({ length: 20 }, (_, i) => 'compiling module ' + i + ' ok'),
      'API error 429: too many requests',
    ].join('\n')
    expect(detectLiveDistress(fresh)?.category).toBe('rate-limit')
  })
})

const target = (overrides: Partial<StallTarget> = {}): StallTarget => ({
  agentId: 'ws:montage',
  runId: 'run-1',
  tail: '',
  workspaceId: 'ws',
  ...overrides,
})

describe('agent stall scanner', () => {
  test('escalates a fresh stall exactly once per cooldown window', () => {
    const onStall = vi.fn()
    let targets: StallTarget[] = [target({ tail: '429 too many requests — backing off' })]
    const scanner = createAgentStallScanner({
      getTargets: () => targets,
      onStall,
      cooldownMs: 10 * 60_000,
    })

    scanner.tick(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0]?.[0]).toMatchObject({
      category: 'rate-limit',
      runId: 'run-1',
      workspaceId: 'ws',
    })

    // Same signal again inside the cooldown → silence.
    scanner.tick(2_000)
    scanner.tick(60_000)
    expect(onStall).toHaveBeenCalledTimes(1)

    // After the cooldown the persistent stall re-escalates.
    scanner.tick(11 * 60_000)
    expect(onStall).toHaveBeenCalledTimes(2)

    // Recovery: clean tail clears nothing by design, but a different
    // category still escalates independently.
    targets = [target({ tail: 'invalid api key' })]
    scanner.tick(11 * 60_000 + 1_000)
    expect(onStall).toHaveBeenCalledTimes(3)
    expect((onStall.mock.calls[2]?.[0] as StallEvent).category).toBe('auth')
    scanner.stop()
  })

  test('unanswered permission dialog escalates as permission-dialog', () => {
    const onStall = vi.fn()
    const scanner = createAgentStallScanner({
      getTargets: () => [target({ tail: 'Do you allow access to this folder? (y/n)' })],
      onStall,
    })
    scanner.tick(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect((onStall.mock.calls[0]?.[0] as StallEvent).category).toBe('permission-dialog')
    scanner.stop()
  })

  test('a dialog answered moments ago does not escalate once work resumed', () => {
    const onStall = vi.fn()
    // B4: the dialog line is still in the tail, but the CLI has since redrawn
    // a full screen of progress — the dialog is not the worker's current
    // state anymore, so escalating would be a false alarm.
    const tail = [
      'Do you allow access to this folder? (y/n)',
      ...Array.from({ length: 15 }, (_, i) => 'edit src/module' + i + '.ts applied'),
    ].join('\n')
    const scanner = createAgentStallScanner({
      getTargets: () => [target({ tail })],
      onStall,
    })
    scanner.tick(1_000)
    expect(onStall).not.toHaveBeenCalled()
    scanner.stop()
  })

  test('distinct runs escalate independently', () => {
    const onStall = vi.fn()
    const scanner = createAgentStallScanner({
      getTargets: () => [
        target({ runId: 'a', tail: 'rate limit' }),
        target({ runId: 'b', tail: 'rate limit' }),
      ],
      onStall,
    })
    scanner.tick(1_000)
    expect(onStall).toHaveBeenCalledTimes(2)
    scanner.stop()
  })

  test('recentlyNotified reflects dedupe state without firing', () => {
    const scanner = createAgentStallScanner({
      getTargets: () => [target({ tail: 'quota exceeded' })],
      onStall: vi.fn(),
      cooldownMs: 5_000,
    })
    expect(scanner.recentlyNotified('run-1', 'quota', 1_000)).toBe(false)
    scanner.tick(1_000)
    expect(scanner.recentlyNotified('run-1', 'quota', 2_000)).toBe(true)
    expect(scanner.recentlyNotified('run-1', 'quota', 9_000)).toBe(false)
    scanner.stop()
  })
})
