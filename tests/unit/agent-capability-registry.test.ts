import { describe, expect, test } from 'vitest'

import {
  getAgentCapability,
  listAgentCapabilities,
} from '../../src/server/agent-capability-registry.js'

describe('agent capability registry', () => {
  test('lists one record per interactive engine adapter', () => {
    const providers = listAgentCapabilities().map((record) => record.provider)
    expect(providers).toEqual(['claude', 'codex', 'agy', 'opencode', 'qwen'])
  })

  test('claude supports model switching and live context commands', () => {
    const claude = getAgentCapability('claude')
    expect(claude?.features.modelSwitch).toBe(true)
    expect(claude?.features.contextControl).toBe(true)
    expect(claude?.contextCommands).toEqual({ clear: '/clear', compact: '/compact' })
    expect(claude?.suggestedModels.length).toBeGreaterThan(0)
  })

  test('codex declares exactly the reasoning levels it can express as args', () => {
    const codex = getAgentCapability('codex')
    expect(codex?.supportedReasoningLevels).toEqual(['LOW', 'MEDIUM', 'HIGH'])
    expect(codex?.features.reasoningControl).toBe(true)
  })

  test('agy declares compress/model-switch via its control profile', () => {
    const agy = getAgentCapability('agy')
    expect(agy).toBeDefined()
    expect(agy?.features).toEqual({
      contextControl: true,
      modelSwitch: true,
      reasoningControl: false,
    })
    expect(agy?.suggestedModels).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
    expect(agy?.contextCommands).toEqual({ clear: null, compact: '/compress' })
  })

  test('unknown provider resolves to undefined', () => {
    expect(getAgentCapability('nope')).toBeUndefined()
    expect(getAgentCapability(null)).toBeUndefined()
  })
})
