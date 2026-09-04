import { describe, expect, test } from 'vitest'

import {
  createMemoryWatchdog,
  DEFAULT_FREE_PERCENT,
  EMERGENCY_ROTATION_RSS_MB,
  HYSTERESIS_PERCENT_POINTS,
  MEMORY_WATCHDOG_FREE_PERCENT_KEY,
  MIN_WORKER_UPTIME_MS,
  type RotationCandidate,
  readMemoryWatchdogConfig,
  readMemoryWatchdogThresholdPercent,
  readRotationRssThresholdMb,
  sampleKey,
  WORKER_MEM_ROTATION_KEY_PREFIX,
} from '../../src/server/memory-watchdog.js'
import { MEMORY_PAUSE_KEY } from '../../src/server/permission-mode.js'

const makeSettings = (rows: Record<string, string> = {}) => {
  const store = new Map(Object.entries(rows))
  return {
    rows: store,
    getAppState: (key: string) => (store.has(key) ? { value: store.get(key) ?? null } : undefined),
    setAppState: (key: string, value: string) => void store.set(key, value),
  }
}

const candidate = (overrides: Partial<RotationCandidate> = {}): RotationCandidate => ({
  workspaceId: 'ws-1',
  agentId: 'worker-1',
  name: 'alice',
  pid: 1001,
  startedAt: 0,
  ...overrides,
})

interface HarnessOptions {
  freePercent?: number
  threshold?: string
  rotation?: string
  rss?: Map<number, number>
  candidates?: RotationCandidate[]
  workspaceIds?: string[]
}

/** Drives the watchdog by hand (intervalMs huge) with deterministic clock + memory level. */
const makeHarness = ({
  freePercent = 50,
  threshold,
  rotation,
  rss = new Map(),
  candidates = [],
  workspaceIds = ['ws-1', 'ws-2'],
}: HarnessOptions = {}) => {
  const settings = makeSettings()
  if (threshold !== undefined) settings.setAppState(MEMORY_WATCHDOG_FREE_PERCENT_KEY, threshold)
  if (rotation !== undefined)
    settings.setAppState(`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`, rotation)
  const state = {
    notifications: [] as string[],
    queueEmits: [] as string[],
    restarts: [] as string[],
    currentFreePercent: freePercent,
    clock: 1_000_000,
  }
  const watchdog = createMemoryWatchdog({
    settings,
    listWorkspaceIds: () => workspaceIds,
    emitQueueUpdated: (workspaceId) => state.queueEmits.push(workspaceId),
    notify: (text) => state.notifications.push(text),
    listRotationCandidates: () => candidates,
    restartWorker: async (workspaceId, agentId) => {
      state.restarts.push(`${workspaceId}:${agentId}`)
    },
    getFreeMemoryPercent: () => state.currentFreePercent,
    sampleRss: async () => rss,
    intervalMs: 3_600_000,
    now: () => state.clock,
  })
  return {
    state,
    settings,
    watchdog,
    setFreePercent: (v: number) => {
      state.currentFreePercent = v
    },
    advanceClock: (ms: number) => {
      state.clock += ms
    },
  }
}

describe('memory watchdog — dispatch pause', () => {
  test('default threshold is 8% and app-state overrides clamp to 0..90', () => {
    expect(readMemoryWatchdogThresholdPercent(makeSettings())).toBe(DEFAULT_FREE_PERCENT)
    expect(
      readMemoryWatchdogThresholdPercent(makeSettings({ [MEMORY_WATCHDOG_FREE_PERCENT_KEY]: '12' }))
    ).toBe(12)
    expect(
      readMemoryWatchdogThresholdPercent(
        makeSettings({ [MEMORY_WATCHDOG_FREE_PERCENT_KEY]: '500' })
      )
    ).toBe(90)
    expect(
      readMemoryWatchdogThresholdPercent(
        makeSettings({ [MEMORY_WATCHDOG_FREE_PERCENT_KEY]: 'junk' })
      )
    ).toBe(DEFAULT_FREE_PERCENT)
  })

  test('pauses dispatch once when free memory drops below the threshold', async () => {
    const h = makeHarness({ freePercent: 5 })
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('1')
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0]).toContain('5.0')
    // Every workspace gets a QUEUE_UPDATED so the UI refreshes its pause state.
    expect(h.state.queueEmits).toEqual(['ws-1', 'ws-2'])

    await h.watchdog.tick()
    // Still starving, but the edge already fired — no duplicate notifications.
    expect(h.state.notifications).toHaveLength(1)
  })

  test('does not pause while memory stays at or above the threshold', async () => {
    const h = makeHarness({ freePercent: DEFAULT_FREE_PERCENT })
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBeUndefined()
    expect(h.state.notifications).toHaveLength(0)
  })

  test('holds the pause inside the hysteresis band and resumes above it', async () => {
    const h = makeHarness({ freePercent: 5 })
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('1')
    expect(h.state.notifications).toHaveLength(1)

    // Recover past the threshold but below threshold + hysteresis: hold.
    h.setFreePercent(DEFAULT_FREE_PERCENT + HYSTERESIS_PERCENT_POINTS - 0.5)
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('1')
    expect(h.state.notifications).toHaveLength(1)

    // Above threshold + hysteresis: the hold releases and the user is told once.
    h.setFreePercent(DEFAULT_FREE_PERCENT + HYSTERESIS_PERCENT_POINTS + 2)
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('0')
    expect(h.state.notifications).toHaveLength(2)
    expect(h.state.notifications[1]).toContain('восстанов')
    expect(h.state.queueEmits).toEqual(['ws-1', 'ws-2', 'ws-1', 'ws-2'])
  })

  test('threshold 0 disables the trigger and releases an active hold', async () => {
    const h = makeHarness({ freePercent: 5, threshold: '0' })
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBeUndefined()
    expect(h.state.notifications).toHaveLength(0)

    const paused = makeHarness({ freePercent: 5 })
    await paused.watchdog.tick()
    expect(paused.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('1')
    // User disables while paused → the next tick must release, not wedge.
    paused.settings.setAppState(MEMORY_WATCHDOG_FREE_PERCENT_KEY, '0')
    await paused.watchdog.tick()
    expect(paused.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('0')
    expect(paused.state.notifications).toHaveLength(2)
  })
})

describe('memory watchdog — rotation', () => {
  test('rotates an idle ballooned worker past the configured RSS threshold', async () => {
    const h = makeHarness({
      rotation: '2500',
      rss: new Map([[1001, 3000]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual(['ws-1:worker-1'])
    expect(h.watchdog.getWorkerRssMb('ws-1', 'worker-1')).toBe(3000)

    // Cooldown: a second tick inside the window must not restart again.
    h.advanceClock(60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual(['ws-1:worker-1'])
  })

  test('skips young workers even with huge RSS', async () => {
    // Engine started 2 minutes before "now" (base clock 1_000_000).
    const h = makeHarness({
      rotation: '2500',
      rss: new Map([[1001, 6000]]),
      candidates: [candidate({ startedAt: 1_000_000 - 120_000 })],
    })
    h.advanceClock(60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual([])
    // Telemetry still recorded for the chip.
    expect(h.watchdog.getWorkerRssMb('ws-1', 'worker-1')).toBe(6000)
  })

  test('skips rotation when RSS is below the configured threshold', async () => {
    const h = makeHarness({
      rotation: '2500',
      rss: new Map([[1001, 1000]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual([])
  })

  test('skips rotation entirely when the per-workspace config is off', async () => {
    const h = makeHarness({
      rss: new Map([[1001, 6000]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual([])
    expect(h.watchdog.getWorkerRssMb('ws-1', 'worker-1')).toBe(6000)
  })

  test('rotation restart failure does not break the tick or clear the cooldown', async () => {
    const settings = makeSettings()
    settings.setAppState(`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`, '2500')
    const restarts: string[] = []
    let clock = 1_000_000
    const watchdog = createMemoryWatchdog({
      settings,
      listRotationCandidates: () => [candidate({ startedAt: 0 })],
      restartWorker: async (workspaceId, agentId) => {
        restarts.push(`${workspaceId}:${agentId}`)
        throw new Error('pty driver missing')
      },
      getFreeMemoryPercent: () => 50,
      sampleRss: async () => new Map([[1001, 5000]]),
      intervalMs: 3_600_000,
      now: () => clock,
    })
    clock += MIN_WORKER_UPTIME_MS + 60_000
    await watchdog.tick()
    expect(restarts).toEqual(['ws-1:worker-1'])
    // The cooldown was recorded before the failed restart, so no tight loop.
    clock += 60_000
    await watchdog.tick()
    expect(restarts).toEqual(['ws-1:worker-1'])
  })
})

describe('memory watchdog — telemetry without rotation', () => {
  test('samples RSS even when no rotation is configured', async () => {
    const h = makeHarness({
      rss: new Map([[1001, 512]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.watchdog.getWorkerRssMb('ws-1', 'worker-1')).toBe(512)
    expect(h.watchdog.getWorkerRssMb('ws-9', 'worker-1')).toBeNull()
  })
})

describe('memory watchdog — config reader', () => {
  test('rotation threshold defaults to off and clamps into 256..65536', () => {
    expect(readRotationRssThresholdMb(makeSettings(), 'ws-1')).toBe(0)
    expect(
      readRotationRssThresholdMb(
        makeSettings({ [`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`]: '0' }),
        'ws-1'
      )
    ).toBe(0)
    expect(
      readRotationRssThresholdMb(
        makeSettings({ [`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`]: '4000' }),
        'ws-1'
      )
    ).toBe(4000)
    expect(
      readRotationRssThresholdMb(
        makeSettings({ [`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`]: '5' }),
        'ws-1'
      )
    ).toBe(256)
  })

  test('readMemoryWatchdogConfig reports both knobs', () => {
    expect(readMemoryWatchdogConfig(makeSettings(), 'ws-1')).toEqual({
      free_percent: DEFAULT_FREE_PERCENT,
      rotation_rss_mb: null,
    })
    expect(
      readMemoryWatchdogConfig(
        makeSettings({
          [MEMORY_WATCHDOG_FREE_PERCENT_KEY]: '10',
          [`${WORKER_MEM_ROTATION_KEY_PREFIX}ws-1`]: '2048',
        }),
        'ws-1'
      )
    ).toEqual({ free_percent: 10, rotation_rss_mb: 2048 })
  })

  test('sampleKey is workspace-scoped', () => {
    expect(sampleKey('ws-1', 'worker-1')).toBe('ws-1:worker-1')
  })

  test('emergency hold rotates an idle ballooned worker even without opt-in', async () => {
    // No per-workspace rotation configured; the worker holds 2.5 GB while the
    // machine is starving — pausing dispatch alone frees nothing.
    const h = makeHarness({
      freePercent: 3,
      rss: new Map([[1001, 2500]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    await h.watchdog.tick()
    expect(h.settings.getAppState(MEMORY_PAUSE_KEY)?.value).toBe('1')
    expect(h.state.restarts).toEqual([])

    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual(['ws-1:worker-1'])
  })

  test('emergency hold ignores workers below the emergency RSS floor', async () => {
    const h = makeHarness({
      freePercent: 3,
      rss: new Map([[1001, EMERGENCY_ROTATION_RSS_MB - 1]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual([])
  })

  test('no emergency rotation when memory is healthy and rotation is off', async () => {
    const h = makeHarness({
      freePercent: 50,
      rss: new Map([[1001, 6000]]),
      candidates: [candidate({ startedAt: 0 })],
    })
    h.advanceClock(MIN_WORKER_UPTIME_MS + 60_000)
    await h.watchdog.tick()
    expect(h.state.restarts).toEqual([])
  })
})
