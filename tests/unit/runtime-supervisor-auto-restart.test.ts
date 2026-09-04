import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createRuntimeSupervisor,
  type RuntimeSupervisorDeps,
  WORKER_RESTART_BACKOFF_MS,
  WORKER_RESTART_MAX_ATTEMPTS,
} from '../../src/server/runtime-supervisor.js'

/**
 * Этап 5: crash auto-restart. A crashed worker is relaunched on a backoff
 * ladder when the workspace opted in — max 3 attempts, the streak resets on
 * a clean exit, and a manual stop cancels a pending restart instead of
 * resurrecting a worker the operator killed.
 */

const NEUTRAL_CRASH_OUTPUT = 'worker exited unexpectedly'

describe('runtime supervisor crash auto-restart (Этап 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const buildFixture = () => {
    const startCalls: Array<{ workspaceId: string; agentId: string }> = []
    let enabled = true
    let lifecycleState: string | undefined

    const deps = {
      agentHeartbeatStore: { get: () => undefined, record: () => {} },
      agentLifecycleStore: {
        get: () => (lifecycleState ? { state: lifecycleState } : undefined),
        transition: () => {},
      },
      agentRuntime: {
        getActiveRunByAgentId: () => undefined,
        getLiveRun: (runId: string) => ({
          id: runId,
          agentId: 'worker-a',
          workspaceId: 'ws1',
          status: 'running',
          runtimeState: 'running',
          exitCode: null,
          output: NEUTRAL_CRASH_OUTPUT,
          startedAt: Date.now(),
          taskId: null,
          pid: null,
        }),
        getPtyOutputBus: () => ({ subscribe: () => () => {} }),
        stopAgentRun: () => {},
        waitForAgentRunExit: async () => {},
      } as never,
      workspaceStorePort: {
        hasAgent: () => true,
        markAgentStopped: () => {},
        getAgent: () => undefined,
      },
      autoRestart: {
        isEnabled: () => enabled,
        start: (workspaceId: string, agentId: string) => {
          startCalls.push({ workspaceId, agentId })
          return Promise.resolve()
        },
      },
      restartBackoffMs: [20, 20, 20],
      dispatchReadyTasks: async () => {},
    } as unknown as RuntimeSupervisorDeps

    const supervisor = createRuntimeSupervisor(deps)
    let runCounter = 0

    const runOnce = (exitCode: number, stopping = false) => {
      runCounter += 1
      const runId = `run-${runCounter}`
      lifecycleState = stopping ? 'stopping' : undefined
      supervisor.handleRunStarted(runId, 'worker-a', 'ws1', Date.now(), null)
      supervisor.handleRunExited(runId, 'worker-a', 'ws1', exitCode, Date.now())
      lifecycleState = undefined
    }

    return {
      startCalls,
      crashOnce: () => runOnce(1),
      succeedOnce: () => runOnce(0),
      manualStopOnce: () => runOnce(143, true),
      setEnabled: (next: boolean) => {
        enabled = next
      },
      settle: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    }
  }

  test('ladder restarts a crashed worker up to three times, then gives up', async () => {
    const fx = buildFixture()

    fx.crashOnce()
    await fx.settle(WORKER_RESTART_BACKOFF_MS[0] + 1_000)
    expect(fx.startCalls).toEqual([{ workspaceId: 'ws1', agentId: 'worker-a' }])

    fx.crashOnce()
    await fx.settle(WORKER_RESTART_BACKOFF_MS[1] + 1_000)
    expect(fx.startCalls).toHaveLength(2)

    fx.crashOnce()
    await fx.settle(WORKER_RESTART_BACKOFF_MS[2] + 1_000)
    expect(fx.startCalls).toHaveLength(3)

    // Fourth crash: the ladder is exhausted — no fourth relaunch, ever.
    fx.crashOnce()
    await fx.settle(30 * 60_000)
    expect(fx.startCalls).toHaveLength(3)
    expect(WORKER_RESTART_MAX_ATTEMPTS).toBe(3)
  })

  test('workspaces without the opt-in are never restarted', async () => {
    const fx = buildFixture()
    fx.setEnabled(false)

    fx.crashOnce()
    await fx.settle(30 * 60_000)
    expect(fx.startCalls).toEqual([])
  })

  test('a clean exit resets the streak so a later crash restarts again', async () => {
    const fx = buildFixture()

    fx.crashOnce()
    await fx.settle(60_000)
    expect(fx.startCalls).toHaveLength(1)

    fx.crashOnce()
    await fx.settle(60_000)
    expect(fx.startCalls).toHaveLength(2)

    // Clean run clears the crash streak…
    fx.succeedOnce()
    await fx.settle(60_000)
    expect(fx.startCalls).toHaveLength(2)

    // …so the next crash restarts from the beginning of the ladder.
    fx.crashOnce()
    await fx.settle(60_000)
    expect(fx.startCalls).toHaveLength(3)
  })

  test('a manual stop cancels a pending restart', async () => {
    const fx = buildFixture()

    // Crash arms the restart timer; the operator starts and stops the worker
    // before the timer fires.
    fx.crashOnce()
    fx.manualStopOnce()
    await fx.settle(30 * 60_000)
    expect(fx.startCalls).toEqual([])
  })
})
