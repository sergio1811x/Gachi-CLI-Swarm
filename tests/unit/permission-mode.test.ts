import { describe, expect, test } from 'vitest'

import {
  isDispatchPausedForWorkspace,
  MEMORY_PAUSE_KEY,
  PERMISSION_MODE_KEY_PREFIX,
  readPermissionMode,
  shouldGrantOpencodePermissions,
  writePermissionMode,
} from '../../src/server/permission-mode.js'

describe('permission mode (R10)', () => {
  test('defaults to allow-all when unset or garbage', () => {
    const settings = { getAppState: () => undefined }
    expect(readPermissionMode(settings, 'ws1')).toBe('allow-all')
    const junk = {
      getAppState: (key: string) =>
        key === `${PERMISSION_MODE_KEY_PREFIX}ws2` ? { value: 'yolo' } : undefined,
    }
    expect(readPermissionMode(junk, 'ws2')).toBe('allow-all')
  })

  test('ask mode round-trips through app-state', () => {
    const store = new Map<string, string>()
    const settings = {
      getAppState: (key: string) =>
        store.has(key) ? { value: store.get(key) ?? null } : undefined,
      setAppState: (key: string, value: string) => void store.set(key, value),
    }
    writePermissionMode(settings, 'ws1', 'ask')
    expect(readPermissionMode(settings, 'ws1')).toBe('ask')
    writePermissionMode(settings, 'ws1', 'allow-all')
    expect(readPermissionMode(settings, 'ws1')).toBe('allow-all')
  })

  test('opencode grants suppressed in ask mode', () => {
    const worker = { commandPresetId: 'opencode', role: 'coder' as const }
    expect(shouldGrantOpencodePermissions(worker, 'allow-all')).toBe(true)
    expect(shouldGrantOpencodePermissions(worker, 'ask')).toBe(false)
  })

  test('orchestrator never receives grants regardless of mode', () => {
    expect(
      shouldGrantOpencodePermissions({ command: 'opencode', role: 'orchestrator' }, 'allow-all')
    ).toBe(false)
  })

  test('non-opencode engines are unaffected', () => {
    expect(shouldGrantOpencodePermissions({ command: 'claude' }, 'allow-all')).toBe(false)
  })
})

describe('isDispatchPausedForWorkspace', () => {
  const makeSettings = (rows: Record<string, string>) => ({
    getAppState: (key: string) => (key in rows ? { value: rows[key] ?? null } : undefined),
  })

  test('not paused when no flags set', () => {
    expect(isDispatchPausedForWorkspace(makeSettings({}), 'ws1')).toBe(false)
  })

  test('per-workspace error-budget flag pauses that workspace only', () => {
    const settings = makeSettings({ dispatch_paused_ws1: '1' })
    expect(isDispatchPausedForWorkspace(settings, 'ws1')).toBe(true)
    expect(isDispatchPausedForWorkspace(settings, 'ws2')).toBe(false)
  })

  test('global memory hold pauses every workspace', () => {
    const settings = makeSettings({ [MEMORY_PAUSE_KEY]: '1' })
    expect(isDispatchPausedForWorkspace(settings, 'ws1')).toBe(true)
    expect(isDispatchPausedForWorkspace(settings, 'ws2')).toBe(true)
  })

  test('memory hold value 0 does not pause', () => {
    expect(isDispatchPausedForWorkspace(makeSettings({ [MEMORY_PAUSE_KEY]: '0' }), 'ws1')).toBe(
      false
    )
  })
})
