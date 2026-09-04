import { describe, expect, test } from 'vitest'

import { ENGINE_ADAPTERS, findEngineAdapter } from '../../src/server/engine-adapters.js'

describe('engine adapter registry (R11)', () => {
  test('official support surface is the four main engines', () => {
    expect(ENGINE_ADAPTERS.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'gemini'])
  })

  test('every adapter carries actionable metadata', () => {
    for (const adapter of ENGINE_ADAPTERS) {
      expect(adapter.displayName.length).toBeGreaterThan(0)
      expect(adapter.loginHint).toContain('`')
      expect(adapter.limitations.length).toBeGreaterThan(0)
    }
  })

  test('ids are unique', () => {
    expect(new Set(ENGINE_ADAPTERS.map((a) => a.id)).size).toBe(ENGINE_ADAPTERS.length)
  })

  test('lookup is case-insensitive and null-safe', () => {
    expect(findEngineAdapter('Claude')?.displayName).toBe('Claude Code')
    expect(findEngineAdapter('OPENCODE')?.id).toBe('opencode')
    expect(findEngineAdapter(null)).toBeUndefined()
    expect(findEngineAdapter('unknown-cli')).toBeUndefined()
  })
})
