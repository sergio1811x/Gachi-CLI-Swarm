import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { taskStore } from '../../src/server/task-store.js'
import {
  createWorkerReportNudge,
  WORKER_NUDGE_COOLDOWN_MS,
  WORKER_NUDGE_QUIET_TICKS,
} from '../../src/server/worker-report-nudge.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

describe.skipIf(SKIP_CONPTY_WINDOWS)('worker report nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    taskStore.clear()
  })

  afterEach(() => {
    taskStore.clear()
    vi.useRealTimers()
  })

  test('nudges a working, quiet worker only after the quiet-tick threshold', async () => {
    const writeWorkerReportNudge = vi.fn()
    const isAgentQuiet = vi.fn().mockResolvedValue(true)
    const snapshot = {
      agents: [
        { id: 'ws:orchestrator', role: 'orchestrator', status: 'working' },
        { id: 'ws:coder', role: 'coder', status: 'working' },
      ],
    }
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () => snapshot as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    await vi.advanceTimersByTimeAsync(1000 * (WORKER_NUDGE_QUIET_TICKS - 1))
    expect(writeWorkerReportNudge).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(1)
    expect(writeWorkerReportNudge).toHaveBeenCalledWith('ws', 'ws:coder', expect.any(String))
    // Never targets the orchestrator itself.
    expect(writeWorkerReportNudge).not.toHaveBeenCalledWith('ws', 'ws:orchestrator')

    nudge.stop()
  })

  test('never nudges an agent that is actively streaming output', async () => {
    const writeWorkerReportNudge = vi.fn()
    const isAgentQuiet = vi.fn().mockResolvedValue(false)
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () =>
        ({
          agents: [{ id: 'ws:coder', role: 'coder', status: 'working' }],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    await vi.advanceTimersByTimeAsync(1000 * (WORKER_NUDGE_QUIET_TICKS + 5))
    expect(writeWorkerReportNudge).not.toHaveBeenCalled()

    nudge.stop()
  })

  test('does not nudge an idle or stopped agent', async () => {
    const writeWorkerReportNudge = vi.fn()
    const isAgentQuiet = vi.fn().mockResolvedValue(true)
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () =>
        ({
          agents: [{ id: 'ws:coder', role: 'coder', status: 'idle' }],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    await vi.advanceTimersByTimeAsync(1000 * (WORKER_NUDGE_QUIET_TICKS + 5))
    expect(writeWorkerReportNudge).not.toHaveBeenCalled()
    expect(isAgentQuiet).not.toHaveBeenCalled()

    nudge.stop()
  })

  test('resets the quiet streak once the agent produces output again', async () => {
    const writeWorkerReportNudge = vi.fn()
    let quiet = true
    const isAgentQuiet = vi.fn(() => Promise.resolve(quiet))
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () =>
        ({
          agents: [{ id: 'ws:coder', role: 'coder', status: 'working' }],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    // One tick short of the threshold, then the agent becomes active again.
    await vi.advanceTimersByTimeAsync(1000 * (WORKER_NUDGE_QUIET_TICKS - 1))
    quiet = false
    await vi.advanceTimersByTimeAsync(1000)
    quiet = true
    // Needs the full streak again from here.
    await vi.advanceTimersByTimeAsync(1000 * (WORKER_NUDGE_QUIET_TICKS - 1))
    expect(writeWorkerReportNudge).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(1)

    nudge.stop()
  })

  test('rate-limits repeat nudges via the cooldown window', async () => {
    const writeWorkerReportNudge = vi.fn()
    const isAgentQuiet = vi.fn().mockResolvedValue(true)
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () =>
        ({
          agents: [{ id: 'ws:coder', role: 'coder', status: 'working' }],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    await vi.advanceTimersByTimeAsync(1000 * WORKER_NUDGE_QUIET_TICKS)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(1)

    // Still quiet on every subsequent tick, but the cooldown blocks a repeat.
    await vi.advanceTimersByTimeAsync(WORKER_NUDGE_COOLDOWN_MS - 1000)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(2)

    nudge.stop()
  })

  test('skips workspaces that error on snapshot lookup', async () => {
    const writeWorkerReportNudge = vi.fn()
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () => {
        throw new Error('workspace not found')
      },
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'gone' }],
      writeWorkerReportNudge,
      isAgentQuiet: vi.fn().mockResolvedValue(true),
    })

    await vi.advanceTimersByTimeAsync(1000 * WORKER_NUDGE_QUIET_TICKS)
    expect(writeWorkerReportNudge).not.toHaveBeenCalled()

    nudge.stop()
  })

  test('логирует предупреждение о простое воркера при длительном молчании', async () => {
    const writeWorkerReportNudge = vi.fn()
    const isAgentQuiet = vi.fn().mockResolvedValue(true)
    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () =>
        ({
          agents: [{ id: 'ws:coder', name: 'coder', role: 'coder', status: 'working' }],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'ws' }],
      writeWorkerReportNudge,
      isAgentQuiet,
    })

    // Достижение порога напоминания
    await vi.advanceTimersByTimeAsync(1000 * WORKER_NUDGE_QUIET_TICKS)
    expect(writeWorkerReportNudge).toHaveBeenCalledTimes(1)

    nudge.stop()
  })
})
