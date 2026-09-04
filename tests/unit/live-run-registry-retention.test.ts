import { describe, expect, test, vi } from 'vitest'

import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'

const makeRun = (
  runId: string,
  status: LiveAgentRun['status'],
  startedAt: number
): LiveAgentRun => ({
  runId,
  agentId: 'agent-1',
  pid: 1,
  status,
  output: '',
  exitCode: status === 'exited' ? 0 : status === 'error' ? 1 : null,
  startedAt,
})

describe('live run registry retention', () => {
  test('keeps finished runs up to the configured cap, evicting oldest first', () => {
    const registry = createLiveRunRegistry({ maxFinishedRuns: 3, finishedRunTtlMs: 60_000 })
    const now = Date.now()

    for (let index = 0; index < 5; index += 1) {
      registry.add(makeRun(`run-${index}`, 'exited', now - index))
      registry.resolveExit(`run-${index}`)
    }

    const ids = registry
      .list()
      .map((run) => run.runId)
      .sort()
    expect(ids).toEqual(['run-2', 'run-3', 'run-4'])
  })

  test('evicts finished runs after the TTL elapses', () => {
    vi.useFakeTimers()
    try {
      const registry = createLiveRunRegistry({ maxFinishedRuns: 20, finishedRunTtlMs: 10_000 })
      const run = makeRun('old-run', 'exited', Date.now())
      registry.add(run)
      registry.resolveExit('old-run')

      expect(registry.get('old-run')).toBeDefined()

      vi.advanceTimersByTime(10_001)
      registry.add(makeRun('new-run', 'starting', Date.now()))
      registry.resolveExit('new-run')

      expect(registry.get('old-run')).toBeUndefined()
      expect(registry.get('new-run')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not evict active runs even beyond the cap', () => {
    const registry = createLiveRunRegistry({ maxFinishedRuns: 2, finishedRunTtlMs: 60_000 })
    const active = makeRun('active', 'running', Date.now())
    registry.add(active)
    for (let index = 0; index < 5; index += 1) {
      const finished = makeRun(`finished-${index}`, 'exited', Date.now() - index)
      registry.add(finished)
      registry.resolveExit(`finished-${index}`)
    }

    expect(registry.get('active')).toBeDefined()
  })

  test('remove cleans up finish timestamps so the run can be re-added fresh', () => {
    vi.useFakeTimers()
    try {
      const registry = createLiveRunRegistry({ maxFinishedRuns: 1, finishedRunTtlMs: 5_000 })
      const run = makeRun('same', 'exited', Date.now())
      registry.add(run)
      registry.resolveExit('same')
      registry.remove('same')

      expect(registry.get('same')).toBeUndefined()

      registry.add(makeRun('same', 'exited', Date.now()))
      registry.resolveExit('same')
      expect(registry.get('same')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
