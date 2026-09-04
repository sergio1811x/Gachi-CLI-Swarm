import { describe, expect, test } from 'vitest'

import {
  buildOpenAttempts,
  getEffectiveOpenTargetId,
  isOpenTargetId,
  isOpenWorkspacePathSafe,
  type OpenAttempt,
  openWorkspace,
  type RunOpenCommand,
  resolveOpenTargetPlatform,
} from '../../src/server/open-target-commands.js'

const fakeSpawnOk = {
  spawnError: null,
  signal: null,
  status: 0,
  stderr: '',
  stdout: '',
}

describe('isOpenTargetId', () => {
  test('accepts every supported id and rejects unknowns', () => {
    expect(isOpenTargetId('vscode')).toBe(true)
    expect(isOpenTargetId('vscode-insiders')).toBe(true)
    expect(isOpenTargetId('cursor')).toBe(true)
    expect(isOpenTargetId('finder')).toBe(true)
    expect(isOpenTargetId('terminal')).toBe(true)
    expect(isOpenTargetId('ghostty')).toBe(true)
    expect(isOpenTargetId('zed')).toBe(true)

    // Removed after 1.3.0 — IntelliJ users typically launch from JetBrains
    // Toolbox, Windsurf overlaps with Cursor, iTerm2 overlaps with Terminal.
    expect(isOpenTargetId('intellijidea')).toBe(false)
    expect(isOpenTargetId('windsurf')).toBe(false)
    expect(isOpenTargetId('iterm2')).toBe(false)

    // cursor-insiders was removed before shipping 1.2.0: the underlying
    // `Cursor Nightly` bundle / `cursor-nightly` binary were discontinued
    // in March 2024, so the option would have always returned app-not-installed.
    expect(isOpenTargetId('cursor-insiders')).toBe(false)
    expect(isOpenTargetId('warp')).toBe(false)
    expect(isOpenTargetId('xcode')).toBe(false)
    expect(isOpenTargetId('sublime')).toBe(false)
    expect(isOpenTargetId('')).toBe(false)
    expect(isOpenTargetId(123)).toBe(false)
    expect(isOpenTargetId(undefined)).toBe(false)
  })
})

describe('resolveOpenTargetPlatform', () => {
  test('maps node platforms to OpenTargetPlatform buckets', () => {
    expect(resolveOpenTargetPlatform('darwin')).toBe('mac')
    expect(resolveOpenTargetPlatform('win32')).toBe('windows')
    expect(resolveOpenTargetPlatform('linux')).toBe('linux')
    expect(resolveOpenTargetPlatform('freebsd')).toBe('other')
    expect(resolveOpenTargetPlatform('aix')).toBe('other')
  })
})

describe('getEffectiveOpenTargetId', () => {
  test('platform-supported target passes through unchanged', () => {
    expect(getEffectiveOpenTargetId('cursor', 'mac')).toBe('cursor')
    expect(getEffectiveOpenTargetId('zed', 'windows')).toBe('zed')
  })

  test('platform-unsupported target falls back to finder, not vscode', () => {
    // ghostty / terminal are mac-only — Windows/Linux should fall back to
    // finder rather than vscode.
    expect(getEffectiveOpenTargetId('ghostty', 'linux')).toBe('finder')
    expect(getEffectiveOpenTargetId('ghostty', 'windows')).toBe('finder')
    expect(getEffectiveOpenTargetId('terminal', 'linux')).toBe('finder')
  })

  test('unsupported on "other" platform also falls back', () => {
    // 'other' platforms only get vscode / vscode-insiders / finder; anything
    // else routes to vscode (the default for non-mac/win/linux).
    expect(getEffectiveOpenTargetId('ghostty', 'other')).toBe('vscode')
    expect(getEffectiveOpenTargetId('cursor', 'other')).toBe('vscode')
  })
})

describe('isOpenWorkspacePathSafe', () => {
  test('accepts normal absolute paths including unicode and spaces', () => {
    expect(isOpenWorkspacePathSafe('/Users/admin/code/gachi')).toBe(true)
    expect(isOpenWorkspacePathSafe('/Users/admin/Projects/With Spaces/foo')).toBe(true)
    expect(isOpenWorkspacePathSafe('/Users/admin/中文目录/项目')).toBe(true)
    expect(isOpenWorkspacePathSafe('C:\\Users\\admin\\Code')).toBe(true)
    expect(isOpenWorkspacePathSafe("/path/with/apostrophe's")).toBe(true)
    expect(isOpenWorkspacePathSafe('/path/with/$dollar')).toBe(true)
    expect(isOpenWorkspacePathSafe('/path/with/`backtick`')).toBe(true)
  })

  test('rejects empty paths', () => {
    expect(isOpenWorkspacePathSafe('')).toBe(false)
  })

  test('rejects paths containing CR / LF / NUL', () => {
    const cr = String.fromCharCode(13)
    const lf = String.fromCharCode(10)
    const nul = String.fromCharCode(0)
    expect(isOpenWorkspacePathSafe(`/path${cr}/foo`)).toBe(false)
    expect(isOpenWorkspacePathSafe(`/path${lf}/foo`)).toBe(false)
    expect(isOpenWorkspacePathSafe(`/path${nul}/foo`)).toBe(false)
    expect(isOpenWorkspacePathSafe(`/path/foo${lf}`)).toBe(false)
  })
})

describe('buildOpenAttempts — mac', () => {
  const path = '/Users/admin/code/gachi with spaces'

  test('vscode uses Visual Studio Code bundle name', () => {
    const [first, ...rest] = buildOpenAttempts('vscode', path, 'mac')
    expect(first).toEqual({ command: 'open', args: ['-a', 'Visual Studio Code', path] })
    expect(rest).toEqual([])
  })

  test('vscode-insiders uses Insiders bundle suffix', () => {
    const [first] = buildOpenAttempts('vscode-insiders', path, 'mac')
    expect(first).toEqual({
      command: 'open',
      args: ['-a', 'Visual Studio Code - Insiders', path],
    })
  })

  test('cursor uses the Cursor bundle name', () => {
    const cursor = buildOpenAttempts('cursor', path, 'mac')[0]
    expect(cursor?.args[1]).toBe('Cursor')
  })

  test('finder uses bare `open` with no -a flag', () => {
    const [first] = buildOpenAttempts('finder', path, 'mac')
    expect(first).toEqual({ command: 'open', args: [path] })
  })

  test('ghostty uses bundle name `Ghostty` with no `Ghostie` legacy fallback', () => {
    const attempts = buildOpenAttempts('ghostty', path, 'mac')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.args).toEqual(['-a', 'Ghostty', path])
  })

  test('every supported mac target produces at least one attempt', () => {
    const mac = [
      'vscode',
      'vscode-insiders',
      'cursor',
      'finder',
      'terminal',
      'ghostty',
      'zed',
    ] as const
    for (const id of mac) {
      const attempts = buildOpenAttempts(id, path, 'mac')
      expect(attempts.length).toBeGreaterThan(0)
      expect(attempts[0]?.command).toBe('open')
      // path must be the final argv element so spaces / quotes flow through
      // without quoting (execFile bypasses the shell).
      expect(attempts[0]?.args[attempts[0]?.args.length - 1]).toBe(path)
    }
  })
})

describe('buildOpenAttempts — linux', () => {
  const path = '/home/admin/code/gachi'

  test('vscode/cursor/zed use the matching CLI binary, not xdg-open', () => {
    expect(buildOpenAttempts('vscode', path, 'linux')[0]).toEqual({ command: 'code', args: [path] })
    expect(buildOpenAttempts('vscode-insiders', path, 'linux')[0]).toEqual({
      command: 'code-insiders',
      args: [path],
    })
    expect(buildOpenAttempts('cursor', path, 'linux')[0]).toEqual({
      command: 'cursor',
      args: [path],
    })
    expect(buildOpenAttempts('zed', path, 'linux')[0]).toEqual({ command: 'zed', args: [path] })
  })

  test('finder maps to xdg-open on linux', () => {
    expect(buildOpenAttempts('finder', path, 'linux')[0]).toEqual({
      command: 'xdg-open',
      args: [path],
    })
  })

  test('mac-only targets fall back to xdg-open via effective-target resolution', () => {
    // ghostty -> finder (linux fallback) -> xdg-open
    expect(buildOpenAttempts('ghostty', path, 'linux')[0]?.command).toBe('xdg-open')
    // terminal -> finder -> xdg-open
    expect(buildOpenAttempts('terminal', path, 'linux')[0]?.command).toBe('xdg-open')
  })
})

describe('buildOpenAttempts — windows', () => {
  const path = 'C:\\Users\\admin\\Code\\gachi'

  test('vscode/cursor/zed use their PATH-installed CLI binary', () => {
    expect(buildOpenAttempts('vscode', path, 'windows')[0]).toEqual({
      command: 'code',
      args: [path],
    })
    expect(buildOpenAttempts('cursor', path, 'windows')[0]).toEqual({
      command: 'cursor',
      args: [path],
    })
    expect(buildOpenAttempts('zed', path, 'windows')[0]).toEqual({ command: 'zed', args: [path] })
  })

  test('finder maps to explorer on windows', () => {
    expect(buildOpenAttempts('finder', path, 'windows')[0]).toEqual({
      command: 'explorer',
      args: [path],
    })
  })
})

describe('openWorkspace — happy path', () => {
  test('returns ok with effective target for the first successful attempt', async () => {
    const calls: OpenAttempt[] = []
    const runCommand: RunOpenCommand = async (command, args) => {
      calls.push({ command, args })
      return { ...fakeSpawnOk }
    }
    const result = await openWorkspace(
      { path: '/Users/admin/code/gachi', targetId: 'vscode' },
      { platform: 'darwin', runCommand }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.effectiveTargetId).toBe('vscode')
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: 'open',
      args: ['-a', 'Visual Studio Code', '/Users/admin/code/gachi'],
    })
  })
})

describe('openWorkspace — explorer exit-code-1 quirk', () => {
  test('windows explorer returning exit 1 is treated as success', async () => {
    // Microsoft/WSL#6565: explorer.exe always returns 1, even on success.
    // We must NOT surface this to the user as an error.
    const runCommand: RunOpenCommand = async () => ({
      ...fakeSpawnOk,
      status: 1,
      stderr: '',
    })
    const result = await openWorkspace(
      { path: 'C:\\code', targetId: 'finder' },
      { platform: 'win32', runCommand }
    )
    expect(result.ok).toBe(true)
  })

  test('explorer ENOENT (truly missing) is still surfaced as a failure', async () => {
    const runCommand: RunOpenCommand = async () => ({
      ...fakeSpawnOk,
      status: 127,
      spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    })
    const result = await openWorkspace(
      { path: 'C:\\code', targetId: 'finder' },
      { platform: 'win32', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('command-not-in-path')
    }
  })
})

describe('openWorkspace — error classification', () => {
  test('ENOENT on the underlying binary surfaces as command-not-in-path', async () => {
    const runCommand: RunOpenCommand = async () => ({
      ...fakeSpawnOk,
      status: 127,
      spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    })
    const result = await openWorkspace(
      { path: '/home/admin/code', targetId: 'cursor' },
      { platform: 'linux', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('command-not-in-path')
    }
  })

  test('macOS "Unable to find application" stderr surfaces as app-not-installed', async () => {
    const runCommand: RunOpenCommand = async () => ({
      ...fakeSpawnOk,
      status: 1,
      stderr: 'Unable to find application named "Cursor"',
    })
    const result = await openWorkspace(
      { path: '/x', targetId: 'cursor' },
      { platform: 'darwin', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('app-not-installed')
      expect(result.stderr).toContain('Unable to find application')
    }
  })

  test('other non-zero failure falls through to unknown error', async () => {
    const runCommand: RunOpenCommand = async () => ({
      ...fakeSpawnOk,
      status: 2,
      stderr: 'something else broke',
    })
    const result = await openWorkspace(
      { path: '/x', targetId: 'vscode' },
      { platform: 'darwin', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('unknown')
    }
  })
})

describe('openWorkspace — input validation', () => {
  test('unknown target id is rejected without calling runCommand', async () => {
    let called = false
    const runCommand: RunOpenCommand = async () => {
      called = true
      return { ...fakeSpawnOk }
    }
    const result = await openWorkspace(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input shape
      { path: '/x', targetId: 'sublime' as any },
      { platform: 'darwin', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid-target')
    }
    expect(called).toBe(false)
  })

  test('path with newline is rejected without calling runCommand', async () => {
    let called = false
    const runCommand: RunOpenCommand = async () => {
      called = true
      return { ...fakeSpawnOk }
    }
    const lf = String.fromCharCode(10)
    const result = await openWorkspace(
      { path: `/Users/admin/code${lf}/etc/passwd`, targetId: 'finder' },
      { platform: 'darwin', runCommand }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid-path')
    }
    expect(called).toBe(false)
  })

  test('cross-platform drift falls back to platform default instead of failing', async () => {
    // User saved preference `ghostty` on a Mac, then ran gachi on Windows.
    // Should resolve to finder + explorer.exe instead of returning 4xx.
    const calls: OpenAttempt[] = []
    const runCommand: RunOpenCommand = async (command, args) => {
      calls.push({ command, args })
      return { ...fakeSpawnOk, status: 1 } // explorer always returns 1
    }
    const result = await openWorkspace(
      { path: 'C:\\code', targetId: 'ghostty' },
      { platform: 'win32', runCommand }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.effectiveTargetId).toBe('finder')
    }
    expect(calls[0]?.command).toBe('explorer')
  })
})

describe('openWorkspace — argv safety', () => {
  test('paths with unicode/spaces/quotes pass through verbatim (no shell quoting)', async () => {
    let captured: OpenAttempt | undefined
    const runCommand: RunOpenCommand = async (command, args) => {
      captured = { command, args }
      return { ...fakeSpawnOk }
    }
    const tricky = '/Users/admin/中文 项目/它的\'引号"和$符号'
    await openWorkspace({ path: tricky, targetId: 'finder' }, { platform: 'darwin', runCommand })
    // The path must be argv-passed unchanged — no quoting, no escaping.
    expect(captured?.args[captured?.args.length - 1]).toBe(tricky)
  })
})
