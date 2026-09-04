import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createOrchestratorHeartbeat,
  DEFAULT_INTERVAL_MS,
  readHeartbeatIntervalMs,
} from '../../src/server/orchestrator-heartbeat.js'

describe('orchestrator heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('nudges the orchestrator only for workspaces with a working member', () => {
    const writeHeartbeatPrompt = vi.fn()
    const snapshots: Record<string, { agents: Array<{ role: string; status: string }> }> = {
      idle: {
        agents: [
          { role: 'orchestrator', status: 'idle' },
          { role: 'coder', status: 'idle' },
        ],
      },
      busy: {
        agents: [
          { role: 'orchestrator', status: 'idle' },
          { role: 'coder', status: 'working' },
        ],
      },
    }
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: (workspaceId) => snapshots[workspaceId] as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'idle' }, { id: 'busy' }],
      writeHeartbeatPrompt,
    })

    vi.advanceTimersByTime(1000)

    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)
    expect(writeHeartbeatPrompt).toHaveBeenCalledWith('busy')

    heartbeat.stop()
    vi.advanceTimersByTime(5000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)
  })

  test('does not nudge when nothing is working, and skips workspaces that error', () => {
    const writeHeartbeatPrompt = vi.fn()
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () => {
        throw new Error('workspace not found')
      },
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'gone' }],
      writeHeartbeatPrompt,
    })

    vi.advanceTimersByTime(1000)

    expect(writeHeartbeatPrompt).not.toHaveBeenCalled()
    heartbeat.stop()
  })

  test('re-reads the interval on every cycle so a change speeds up (or slows down) the next schedule', async () => {
    const writeHeartbeatPrompt = vi.fn()
    let intervalMs = 5000
    // Счётчик тиков используется чтобы snapshot менялся — fingerprint разный на каждом тике
    let tickCount = 0
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working', id: `coder-${tickCount++}` },
          ],
        }) as never,
      getIntervalMs: () => intervalMs,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
    })

    // First tick fires at the original 5s cadence; the reschedule that follows
    // it still captures 5s (the change below happens after control returns).
    await vi.advanceTimersByTimeAsync(5000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)
    intervalMs = 1000

    // Second tick was already scheduled for +5s under the old value.
    await vi.advanceTimersByTimeAsync(4000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(2)

    // From here on the loop reschedules itself using the new 1s value.
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(3)

    heartbeat.stop()
  })

  test('skips the nudge when isOrchestratorFree reports the orchestrator is busy', async () => {
    const writeHeartbeatPrompt = vi.fn()
    const isOrchestratorFree = vi.fn().mockResolvedValue(false)
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working' },
          ],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
      isOrchestratorFree,
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(isOrchestratorFree).toHaveBeenCalledWith('busy')
    expect(writeHeartbeatPrompt).not.toHaveBeenCalled()

    heartbeat.stop()
  })

  test('never nudges while the interval is set to the disabled (0) value', async () => {
    const writeHeartbeatPrompt = vi.fn()
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working' },
          ],
        }) as never,
      intervalMs: 0,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
    })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(writeHeartbeatPrompt).not.toHaveBeenCalled()

    heartbeat.stop()
  })

  test('retries the heartbeat on the next tick when the PTY write fails (fingerprint not consumed)', async () => {
    const writeHeartbeatPrompt = vi.fn(() => {
      throw new Error('EPIPE')
    })
    let tickCount = 0
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working', id: `coder-${tickCount++}` },
          ],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)

    // The failed write must NOT consume the fingerprint: the next tick tries
    // again instead of silently dropping the state change forever.
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(2)

    heartbeat.stop()
  })

  test('retries the heartbeat on the next tick when the write reports not-delivered', async () => {
    const writeHeartbeatPrompt = vi.fn(() => false)
    let tickCount = 0
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working', id: `coder-${tickCount++}` },
          ],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(1)
    // A silent no-run write must NOT consume the fingerprint.
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeHeartbeatPrompt).toHaveBeenCalledTimes(2)

    heartbeat.stop()
  })

  test('flushes queued notifications every tick, even when the fingerprint is unchanged', async () => {
    const writeHeartbeatPrompt = vi.fn()
    const flushPendingNotifications = vi.fn(() => 1)
    const heartbeat = createOrchestratorHeartbeat({
      getWorkspaceSnapshot: () =>
        ({
          agents: [
            { role: 'orchestrator', status: 'idle' },
            { role: 'coder', status: 'working' },
          ],
        }) as never,
      intervalMs: 1000,
      listWorkspaces: () => [{ id: 'busy' }],
      writeHeartbeatPrompt,
      flushPendingNotifications,
    })

    await vi.advanceTimersByTimeAsync(3000)

    expect(flushPendingNotifications).toHaveBeenCalledTimes(3)
    expect(flushPendingNotifications).toHaveBeenCalledWith('busy')
    // Delivered pushes replace the heartbeat for that tick.
    expect(writeHeartbeatPrompt).not.toHaveBeenCalled()

    heartbeat.stop()
  })
})

describe('readHeartbeatIntervalMs', () => {
  test('falls back to the default when app state is missing or invalid', () => {
    expect(readHeartbeatIntervalMs({ getAppState: () => undefined })).toBe(DEFAULT_INTERVAL_MS)
    expect(readHeartbeatIntervalMs({ getAppState: () => ({ value: null }) })).toBe(
      DEFAULT_INTERVAL_MS
    )
    expect(readHeartbeatIntervalMs({ getAppState: () => ({ value: 'not-a-number' }) })).toBe(
      DEFAULT_INTERVAL_MS
    )
  })

  test('returns the stored value when valid', () => {
    expect(readHeartbeatIntervalMs({ getAppState: () => ({ value: '180000' }) })).toBe(180_000)
  })
})
