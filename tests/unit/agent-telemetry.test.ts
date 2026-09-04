import { describe, expect, test } from 'vitest'

import { createAgentTelemetry } from '../../src/server/agent-telemetry.js'

describe('agent telemetry parsing', () => {
  test('parses the Claude Code context-left line', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', 'Context left until auto-compact: 34%\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.contextPercent).toBe(34)
  })

  test('parses the codex percent-before-context line', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', '[79%] context left\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.contextPercent).toBe(79)
  })

  test('holds incomplete lines across chunk boundaries', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', 'Context left until auto-compact: 4')
    expect(telemetry.snapshot('ws', 'agent1')?.contextPercent).toBeNull()
    telemetry.observe('ws', 'agent1', '5%\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.contextPercent).toBe(45)
  })

  test('ignores out-of-range percentages', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', 'Context left until auto-compact: 340%\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.contextPercent).toBeNull()
  })

  test('tracks the latest token total with comma separators', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', 'Total tokens used: 1,234\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.tokensUsed).toBe(1234)
    telemetry.observe('ws', 'agent1', 'Total tokens used: 2,000\r\n')
    expect(telemetry.snapshot('ws', 'agent1')?.tokensUsed).toBe(2000)
  })

  test('unrelated output leaves the snapshot untouched', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'agent1', 'some regular worker output\r\n')
    const snapshot = telemetry.snapshot('ws', 'agent1')
    expect(snapshot?.contextPercent).toBeNull()
    expect(snapshot?.tokensUsed).toBeNull()
  })

  test('snapshots are per agent and removable', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 10%\r\n')
    telemetry.observe('ws', 'a2', 'Context left until auto-compact: 20%\r\n')

    expect(telemetry.snapshot('ws', 'a1')?.contextPercent).toBe(10)
    expect(telemetry.snapshotsForWorkspace('ws').map((s) => s.contextPercent)).toEqual([10, 20])

    telemetry.removeAgent('ws', 'a1')
    expect(telemetry.snapshot('ws', 'a1')).toBeUndefined()
  })

  test('removeWorkspace drops every agent of that workspace only (audit M-1)', () => {
    const telemetry = createAgentTelemetry()
    telemetry.observe('ws-1', 'a1', 'Context left until auto-compact: 10%\r\n')
    telemetry.observe('ws-1', 'a2', 'Total tokens used: 500\r\n')
    telemetry.observe('ws-2', 'b1', 'Context left until auto-compact: 30%\r\n')

    telemetry.removeWorkspace('ws-1')

    expect(telemetry.snapshot('ws-1', 'a1')).toBeUndefined()
    expect(telemetry.snapshot('ws-1', 'a2')).toBeUndefined()
    // Another workspace's state survives the deletion.
    expect(telemetry.snapshot('ws-2', 'b1')?.contextPercent).toBe(30)
    expect(telemetry.snapshotsForWorkspace('ws-1')).toEqual([])
  })
})

describe('auto-compact policy', () => {
  test('fires once at or above the threshold and again after the cooldown', () => {
    const triggers: string[] = []
    const telemetry = createAgentTelemetry({
      autoCompactCooldownMs: 100,
      onAutoCompact: (workspaceId, agentId, info) =>
        triggers.push(`${workspaceId}:${agentId}:${info.trigger}:${info.contextPercent}`),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 90%\r\n')
    expect(triggers).toEqual(['ws:a1:context:90'])

    // Repaint of a high value inside the cooldown must not retrigger.
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 91%\r\n')
    expect(triggers).toEqual(['ws:a1:context:90'])
  })

  test('does not fire below the threshold', () => {
    const triggers: Array<[string, string, number]> = []
    const telemetry = createAgentTelemetry({
      onAutoCompact: (_workspaceId, _agentId, info) =>
        triggers.push(['ws', 'a1', info.contextPercent ?? -1]),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 84%\r\n')
    expect(triggers).toEqual([])
  })
})

describe('token-budget compaction policy (auto_compact_tokens)', () => {
  test('fires when scraped tokens reach the absolute budget — even without context lines', () => {
    const triggers: Array<{ agentId: string; tokensUsed: number | null; trigger: string }> = []
    const telemetry = createAgentTelemetry({
      autoCompactTokens: 100_000,
      onAutoCompact: (_workspaceId, agentId, info) => triggers.push({ agentId, ...info }),
    })
    telemetry.observe('ws', 'a1', 'Total tokens used: 99,999\r\n')
    expect(triggers).toEqual([])

    telemetry.observe('ws', 'a1', 'Total tokens used: 100,500\r\n')
    expect(triggers).toEqual([
      { agentId: 'a1', tokensUsed: 100_500, trigger: 'tokens', contextPercent: null },
    ])
  })

  test('respects the shared compaction cooldown after firing', () => {
    const triggers: unknown[] = []
    const telemetry = createAgentTelemetry({
      autoCompactCooldownMs: 60_000,
      autoCompactTokens: 100_000,
      onAutoCompact: (_workspaceId, _agentId, info) => triggers.push(info),
    })
    telemetry.observe('ws', 'a1', 'Total tokens used: 150,000\r\n')
    expect(triggers).toHaveLength(1)
    // Repaint above budget inside the cooldown → no second write.
    telemetry.observe('ws', 'a1', 'Total tokens used: 180,000\r\n')
    expect(triggers).toHaveLength(1)
  })

  test('disabled by default (no option → no token trigger)', () => {
    const triggers: unknown[] = []
    const telemetry = createAgentTelemetry({
      onAutoCompact: (_workspaceId, _agentId, info) => triggers.push(info),
    })
    telemetry.observe('ws', 'a1', 'Total tokens used: 900,000\r\n')
    expect(triggers).toEqual([])
  })

  test('percent trigger still works alongside an enabled token budget', () => {
    const triggers: Array<{ trigger: string; contextPercent: number | null }> = []
    const telemetry = createAgentTelemetry({
      autoCompactTokens: 1_000_000,
      onAutoCompact: (_workspaceId, _agentId, info) =>
        triggers.push({ trigger: info.trigger, contextPercent: info.contextPercent }),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 88%\r\n')
    expect(triggers).toEqual([{ trigger: 'context', contextPercent: 88 }])
  })

  test('token and percent crossings in one tick compact exactly once', () => {
    const triggers: unknown[] = []
    const telemetry = createAgentTelemetry({
      autoCompactTokens: 1000,
      autoCompactCooldownMs: 60_000,
      onAutoCompact: (_w, _a, info) => triggers.push(info),
    })
    // Line carries both signals past their thresholds.
    telemetry.observe('ws', 'a1', 'Total tokens used: 5,000 · context left: 10%\r\n')
    expect(triggers).toHaveLength(1)
    expect((triggers[0] as { trigger: string }).trigger).toBe('tokens')
  })
})

describe('usage warning policy', () => {
  test('fires on the crossing edge, not on every scrape above the threshold', () => {
    const warnings: Array<[string, number]> = []
    const telemetry = createAgentTelemetry({
      onUsageWarning: (_workspaceId, _agentId, percent) => warnings.push(['a1', percent]),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 86%\r\n')
    expect(warnings).toEqual([['a1', 86]])

    // Still above the threshold — no repeat (cooldown + edge detection).
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 92%\r\n')
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 95%\r\n')
    expect(warnings).toEqual([['a1', 86]])
  })

  test('re-arms after usage drops well below the threshold (hysteresis)', () => {
    const warnings: Array<[string, number]> = []
    const telemetry = createAgentTelemetry({
      onUsageWarning: (_workspaceId, _agentId, percent) => warnings.push(['a1', percent]),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 90%\r\n')
    expect(warnings).toEqual([['a1', 90]])

    // Drop to 40% (< 80% of the 85 threshold) re-arms the warning.
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 40%\r\n')
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 88%\r\n')
    expect(warnings).toEqual([
      ['a1', 90],
      ['a1', 88],
    ])
  })

  test('does not flap around the threshold boundary', () => {
    const warnings: Array<[string, number]> = []
    const telemetry = createAgentTelemetry({
      onUsageWarning: (_workspaceId, _agentId, percent) => warnings.push(['a1', percent]),
    })
    // Crossings between ~80 and 90 never dip below hysteresis floor.
    for (const pct of [86, 81, 87, 82, 88]) {
      telemetry.observe('ws', 'a1', `Context left until auto-compact: ${pct}%\r\n`)
    }
    expect(warnings).toEqual([['a1', 86]])
  })

  test('warnings are per agent', () => {
    const warnings: string[] = []
    const telemetry = createAgentTelemetry({
      onUsageWarning: (_workspaceId, agentId) => warnings.push(agentId),
    })
    telemetry.observe('ws', 'a1', 'Context left until auto-compact: 90%\r\n')
    telemetry.observe('ws', 'a2', 'Context left until auto-compact: 20%\r\n')
    expect(warnings).toEqual(['a1'])
  })
})
