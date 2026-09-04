import { describe, expect, test } from 'vitest'

import {
  applyControlOverrides,
  ENGINE_CONTROL_PROFILES,
  getEngineControlProfile,
  parseReasoningLevel,
  readControlOverrides,
} from '../../src/server/engine-control-profiles.js'

describe('reasoning level parsing', () => {
  test('accepts case-insensitive and spaced forms', () => {
    expect(parseReasoningLevel('high')).toBe('HIGH')
    expect(parseReasoningLevel('Very High')).toBe('VERY_HIGH')
    expect(parseReasoningLevel('MAX')).toBe('MAX')
  })

  test('rejects unknown levels', () => {
    expect(parseReasoningLevel('extreme')).toBeUndefined()
    expect(parseReasoningLevel(42)).toBeUndefined()
    expect(parseReasoningLevel(undefined)).toBeUndefined()
  })
})

describe('applyControlOverrides', () => {
  const codex = ENGINE_CONTROL_PROFILES.codex

  test('appends model args to a bare config', () => {
    const args = applyControlOverrides(['--full-auto'], codex, { model: 'gpt-5-codex' })
    expect(args).toEqual(['--full-auto', '-m', 'gpt-5-codex'])
  })

  test('replaces a previously pinned model instead of stacking flags', () => {
    const first = applyControlOverrides([], codex, { model: 'gpt-5' })
    const second = applyControlOverrides(first, codex, { model: 'o3' })
    expect(second).toEqual(['-m', 'o3'])
  })

  test('renders the reasoning effort for supported levels', () => {
    const args = applyControlOverrides([], codex, { reasoning: 'HIGH' })
    expect(args).toEqual(['-c', 'model_reasoning_effort=high'])
  })

  test('replaces an existing reasoning effort', () => {
    const first = applyControlOverrides([], codex, { reasoning: 'LOW' })
    const second = applyControlOverrides(first, codex, { reasoning: 'MEDIUM' })
    expect(second).toEqual(['-c', 'model_reasoning_effort=medium'])
  })

  test('model and reasoning overrides coexist and replace independently', () => {
    const first = applyControlOverrides([], codex, { model: 'gpt-5', reasoning: 'LOW' })
    const second = applyControlOverrides(first, codex, { reasoning: 'HIGH' })
    expect(second).toEqual(['-m', 'gpt-5', '-c', 'model_reasoning_effort=high'])
  })

  test('strips every control-flag pair before appending the new one', () => {
    const args = applyControlOverrides(['-m', '--full-auto', '-m', 'gpt-5'], codex, {
      model: 'o3',
    })
    expect(args).toEqual(['-m', 'o3'])
  })
})

describe('readControlOverrides', () => {
  test('round-trips model and reasoning through apply/read', () => {
    const codex = ENGINE_CONTROL_PROFILES.codex
    const args = applyControlOverrides([], codex, { model: 'gpt-5-codex', reasoning: 'MEDIUM' })
    expect(readControlOverrides({ args }, codex)).toEqual({
      model: 'gpt-5-codex',
      reasoning: 'MEDIUM',
    })
  })

  test('returns nulls when nothing is pinned', () => {
    const claude = ENGINE_CONTROL_PROFILES.claude
    expect(readControlOverrides({ args: ['--dangerously-skip-permissions'] }, claude)).toEqual({
      model: null,
      reasoning: null,
    })
  })
})

describe('profile registry', () => {
  test('known engines resolve, unknown do not', () => {
    expect(getEngineControlProfile('claude')).toBeDefined()
    expect(getEngineControlProfile('CODEX')).toBeDefined()
    expect(getEngineControlProfile('unknown-cli')).toBeUndefined()
    expect(getEngineControlProfile(null)).toBeUndefined()
  })

  test('retired gemini profile is gone; agy carries compress/model args', () => {
    expect(getEngineControlProfile('gemini')).toBeUndefined()
    const agy = getEngineControlProfile('agy')
    expect(agy?.contextCommands.compact).toBe('/compress')
    expect(agy?.modelArg?.flag).toBe('-m')
    const opencode = getEngineControlProfile('opencode')
    expect(opencode?.contextCommands.compact).toBe('/compact')
    expect(opencode?.contextCommands.clear).toBeNull()
    expect(Object.keys(opencode?.reasoningArgsByLevel ?? {})).toHaveLength(0)
  })
})
