import { describe, expect, test } from 'vitest'
import {
  ENGINE_ADAPTERS,
  engineShouldVerifySessionBeforeResume,
  engineSupportsResume,
  getEngineAdapter,
  getEngineAdapterById,
} from '../../src/server/engine-adapter.js'

describe('engine adapter', () => {
  test('exposes one adapter per interactive engine', () => {
    const ids = ENGINE_ADAPTERS.map((adapter) => adapter.id).sort()
    expect(ids).toEqual(['agy', 'claude', 'codex', 'opencode', 'qwen'].sort())
  })

  test('claude adapter groups driver and launch/resume facts', () => {
    const adapter = getEngineAdapter('claude')
    expect(adapter).toBeDefined()
    expect(adapter).toMatchObject({
      command: 'claude',
      displayName: 'Claude Code (CC)',
      interactive: true,
      usesBracketedPaste: true,
      readyTimeoutMs: 3000,
      terminalInputProfile: 'default',
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: { source: 'claude_project_jsonl_dir' },
    })
    expect(adapter?.yoloArgsTemplate?.length).toBeGreaterThan(0)
    expect(engineSupportsResume(adapter!)).toBe(true)
    expect(engineShouldVerifySessionBeforeResume(adapter!)).toBe(true)
  })

  test('codex resumes via subcommand without pre-verification', () => {
    const adapter = getEngineAdapter('codex')
    expect(adapter).toMatchObject({
      resumeArgsTemplate: 'resume {session_id}',
      sessionIdCapture: { source: 'codex_session_jsonl_dir' },
    })
    expect(engineSupportsResume(adapter!)).toBe(true)
    expect(engineShouldVerifySessionBeforeResume(adapter!)).toBe(false)
  })

  test('opencode exposes its capture source', () => {
    const opencode = getEngineAdapter('opencode')
    expect(opencode?.sessionIdCapture).toMatchObject({ source: 'opencode_session_db' })
    expect(opencode?.terminalInputProfile).toBe('opencode')
    expect(engineShouldVerifySessionBeforeResume(opencode!)).toBe(true)
  })

  test('agy and qwen have drivers but no resume preset (explicit gap)', () => {
    for (const id of ['agy', 'qwen']) {
      const adapter = getEngineAdapter(id)
      expect(adapter).toBeDefined()
      expect(adapter?.interactive).toBe(true)
      expect(adapter?.resumeArgsTemplate).toBeNull()
      expect(adapter?.sessionIdCapture).toBeNull()
      expect(engineSupportsResume(adapter!)).toBe(false)
    }
  })

  test('looks up by normalized command path', () => {
    expect(getEngineAdapter('node_modules/.bin/opencode.cmd')?.id).toBe('opencode')
    expect(getEngineAdapter('CLAUDE.EXE')?.id).toBe('claude')
  })

  test('returns undefined for unknown or non-interactive commands', () => {
    expect(getEngineAdapter('python')).toBeUndefined()
    expect(getEngineAdapter('nonsense-binary')).toBeUndefined()
    expect(getEngineAdapterById('does-not-exist')).toBeUndefined()
  })
})
