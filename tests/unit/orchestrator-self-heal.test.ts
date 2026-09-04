import { afterEach, describe, expect, test, vi } from 'vitest'

import { createOrchestratorSelfHeal } from '../../src/server/orchestrator-self-heal.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const OK = { ok: true, error: null, run_id: 'run-1' }

describe('orchestrator self-heal', () => {
  test('restarts immediately while the orchestrator is down and start succeeds', async () => {
    const autostart = vi.fn().mockResolvedValue(OK)
    const selfHeal = createOrchestratorSelfHeal({
      hasActiveRun: () => false,
      autostart,
    })

    expect(await selfHeal('ws-1')).toBe(true)
    expect(autostart).toHaveBeenCalledWith('ws-1')
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(0)
  })

  test('short-circuits without autostart while a run is active', async () => {
    const autostart = vi.fn().mockResolvedValue(OK)
    const selfHeal = createOrchestratorSelfHeal({
      hasActiveRun: () => true,
      autostart,
    })

    expect(await selfHeal('ws-1')).toBe(true)
    expect(autostart).not.toHaveBeenCalled()
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(0)
  })

  test('logs the real failure reason instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const autostart = vi.fn().mockResolvedValue({
      ok: false,
      error: 'codex CLI not found in PATH',
      run_id: null,
    })
    const selfHeal = createOrchestratorSelfHeal({
      hasActiveRun: () => false,
      autostart,
    })

    expect(await selfHeal('deadbeef-ws')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.join(' ')).toContain('codex CLI not found in PATH')
    expect(warn.mock.calls[0]?.join(' ')).toContain('deadbeef')
    expect(selfHeal.consecutiveFailures('deadbeef-ws')).toBe(1)
  })

  test('backs off on a 1m/5m/15m ladder after consecutive failures', async () => {
    let clock = 1_000_000
    const autostart = vi.fn().mockResolvedValue({ ok: false, error: 'exit 1', run_id: null })
    const selfHeal = createOrchestratorSelfHeal({
      hasActiveRun: () => false,
      autostart,
      now: () => clock,
    })

    // First attempt fires immediately, then the ladder gates the retries.
    expect(await selfHeal('ws-1')).toBe(false)
    expect(autostart).toHaveBeenCalledTimes(1)

    clock += 60_000
    expect(await selfHeal('ws-1')).toBe(false)
    expect(autostart).toHaveBeenCalledTimes(1)

    clock += 240_000 // 5m after the first failure
    expect(await selfHeal('ws-1')).toBe(false)
    expect(autostart).toHaveBeenCalledTimes(2)

    clock += 300_000 // 5m later — still inside the 15m window for failure #2
    expect(await selfHeal('ws-1')).toBe(false)
    expect(autostart).toHaveBeenCalledTimes(2)

    clock += 600_000 // 15m after the second failure
    expect(await selfHeal('ws-1')).toBe(false)
    expect(autostart).toHaveBeenCalledTimes(3)
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(3)
  })

  test('resets the ladder once the orchestrator is back', async () => {
    const clock = 1_000_000
    let activeRun = false
    const autostart = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'exit 1', run_id: null })
      .mockResolvedValue(OK)
    const selfHeal = createOrchestratorSelfHeal({
      hasActiveRun: () => activeRun,
      autostart,
      now: () => clock,
    })

    expect(await selfHeal('ws-1')).toBe(false)
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(1)

    // A live run (e.g. a later attempt won) clears the failure streak.
    activeRun = true
    expect(await selfHeal('ws-1')).toBe(true)
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(0)

    // The next crash restarts from the fast end of the ladder.
    activeRun = false
    expect(await selfHeal('ws-1')).toBe(true)
    expect(autostart).toHaveBeenCalledTimes(2)
    expect(selfHeal.consecutiveFailures('ws-1')).toBe(0)
  })
})
