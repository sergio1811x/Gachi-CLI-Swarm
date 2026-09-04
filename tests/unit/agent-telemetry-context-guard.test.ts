import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createAgentTelemetry } from '../../src/server/agent-telemetry.js'

/**
 * Этап 4: context-guard policy knobs — app-state threshold override (0 = off),
 * quiet window after a fresh run, and the 30-minute per-agent cooldown.
 */

const CONTEXT_LINE = (percent: number) => `Context left until auto-compact: ${percent}%`

describe('agent telemetry context guard (Этап 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('default threshold stays 85 and cooldown is 30 minutes', () => {
    const fired: number[] = []
    const telemetry = createAgentTelemetry({
      onAutoCompact: (_ws, _agent, info) => {
        if (info.trigger === 'context' && info.contextPercent !== null)
          fired.push(info.contextPercent)
      },
    })

    telemetry.observe('ws', 'a', `${CONTEXT_LINE(84)}\n`)
    expect(fired).toEqual([])

    telemetry.observe('ws', 'a', `${CONTEXT_LINE(86)}\n`)
    expect(fired).toEqual([86])

    // 20 minutes later: still inside the cooldown.
    vi.advanceTimersByTime(20 * 60_000)
    telemetry.observe('ws', 'a', `${CONTEXT_LINE(95)}\n`)
    expect(fired).toEqual([86])

    // Past 30 minutes: fires again.
    vi.advanceTimersByTime(11 * 60_000)
    telemetry.observe('ws', 'a', `${CONTEXT_LINE(96)}\n`)
    expect(fired).toEqual([86, 96])
  })

  test('threshold provider raises the bar and 0 turns the percent trigger off', () => {
    let threshold: number | null = 90
    const fired: number[] = []
    const telemetry = createAgentTelemetry({
      getThresholdPercent: () => threshold,
      onAutoCompact: (_ws, _agent, info) => {
        if (info.trigger === 'context' && info.contextPercent !== null)
          fired.push(info.contextPercent)
      },
    })

    telemetry.observe('ws', 'a', `${CONTEXT_LINE(88)}\n`)
    expect(fired).toEqual([])

    telemetry.observe('ws', 'a', `${CONTEXT_LINE(91)}\n`)
    expect(fired).toEqual([91])

    // Switching the guard off applies without a restart; the scrape keeps
    // updating the snapshot but never fires again.
    threshold = 0
    telemetry.observe('ws', 'a', `${CONTEXT_LINE(99)}\n`)
    expect(fired).toEqual([91])
    expect(telemetry.snapshot('ws', 'a')?.contextPercent).toBe(99)
  })

  test('quiet window skips the trigger without arming the cooldown', () => {
    let quiet = true
    const fired: number[] = []
    const telemetry = createAgentTelemetry({
      isInQuietWindow: () => quiet,
      onAutoCompact: (_ws, _agent, info) => {
        if (info.trigger === 'context' && info.contextPercent !== null)
          fired.push(info.contextPercent)
      },
    })

    // Fresh run: crossing during the quiet window is ignored…
    telemetry.observe('ws', 'a', `${CONTEXT_LINE(95)}\n`)
    expect(fired).toEqual([])

    // …and once the window ends, the very next crossing fires — the skipped
    // scrape must NOT have armed the 30-minute cooldown.
    quiet = false
    telemetry.observe('ws', 'a', `${CONTEXT_LINE(96)}\n`)
    expect(fired).toEqual([96])
  })
})
