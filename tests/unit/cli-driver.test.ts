import { describe, expect, test } from 'vitest'

import {
  AGENT_DRIVERS,
  getAgentDriver,
  getAgentDriverById,
  getCliDriver,
  getCliDriverById,
  isInteractiveAgentCommand,
} from '../../src/server/cli-driver.js'

describe('AgentDriver registry', () => {
  test('exposes the engine-neutral registry without breaking CLI compatibility aliases', () => {
    expect(AGENT_DRIVERS).toHaveLength(5)
    expect(getAgentDriver('codex')).toBe(getCliDriver('codex'))
    expect(getAgentDriverById('opencode')).toBe(getCliDriverById('opencode'))
  })
  test('resolves known drivers by executable name', () => {
    expect(getCliDriver('claude').id).toBe('claude')
    expect(getCliDriver('codex').id).toBe('codex')
    expect(getCliDriver('agy').id).toBe('agy')
    expect(getCliDriver('opencode').id).toBe('opencode')
    expect(getCliDriver('agy').id).toBe('agy')
    expect(getCliDriver('C:\\tools\\claude.exe').id).toBe('claude')
    expect(getCliDriver('claude.cmd').id).toBe('claude')
  })

  test('falls back to a non-interactive generic driver for unknown CLIs', () => {
    const driver = getCliDriver('some-custom-binary')
    expect(driver.id).toBe('generic')
    expect(driver.interactive).toBe(false)
  })

  test('known generic agent CLIs get explicit interactive drivers', () => {
    expect(getCliDriver('qwen').id).toBe('qwen')
    expect(getCliDriver('qwen').interactive).toBe(true)
  })

  test('drivers describe their own prompt/ready strategy instead of shared UI-text regexes', () => {
    const claude = getCliDriver('claude')
    expect(claude.hasPromptReady('booting\n❯ ')).toBe(true)
    expect(claude.hasPromptReady('booting')).toBe(false)

    const agy = getCliDriver('agy')
    expect(agy.hasPromptReady('* Type your message or @path/to/file')).toBe(true)
    // A brand/version splash is NOT an input-ready signal: the write must wait
    // until the CLI actually shows its prompt, otherwise the task text is
    // dropped as render input while the CLI is still booting.
    expect(agy.hasPromptReady('Antigravity CLI v0.1 · Gemini 3.7 Flash · medium')).toBe(false)
  })

  test('bracketed-paste and slow-render capabilities differ per driver', () => {
    expect(getCliDriver('claude').usesBracketedPaste).toBe(true)
    expect(getCliDriver('agy').usesBracketedPaste).toBe(true)
    expect(getCliDriver('agy').slowRender).toBe(true)
    expect(getCliDriver('claude').slowRender).toBe(false)
  })

  test('terminal input profile comes from the driver', () => {
    expect(getCliDriver('opencode').terminalInputProfile).toBe('opencode')
    expect(getCliDriver('claude').terminalInputProfile).toBe('default')
  })

  test('resolves drivers by builtin preset id', () => {
    expect(getCliDriverById('opencode')?.terminalInputProfile).toBe('opencode')
    expect(getCliDriverById('unknown')).toBeUndefined()
  })

  test('treats known interactive commands consistently', () => {
    expect(isInteractiveAgentCommand('claude')).toBe(true)
    expect(isInteractiveAgentCommand('qwen')).toBe(true)
    expect(isInteractiveAgentCommand('node')).toBe(false)
  })
})
