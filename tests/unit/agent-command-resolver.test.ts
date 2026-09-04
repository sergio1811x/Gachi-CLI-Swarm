import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertCommandIsExecutable,
  resolveCommandPath,
  resolveSpawnCommand,
} from '../../src/server/agent-command-resolver.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('agent command resolver', () => {
  test('accepts executable commands already present on PATH', () => {
    expect(() =>
      assertCommandIsExecutable(process.execPath, process.cwd(), process.env)
    ).not.toThrow()
  })

  test('uses PATHEXT candidates before extensionless scripts on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'gachi-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'extensionless placeholder')
    writeFileSync(join(binDir, 'agent.cmd'), '@echo off\r\n')

    const resolved = resolveCommandPath(
      'agent',
      root,
      {
        Path: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        PathExt: '.cmd;.EXE',
      },
      'win32'
    )
    expect(resolved.toLowerCase()).toBe(join(binDir, 'agent.cmd').toLowerCase())
  })

  test('wraps Windows command shims with cmd.exe for PTY spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'gachi-command-spawn-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    const commandPath = join(binDir, 'agent.cmd')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(commandPath, '@echo off\r\n')

    const resolved = resolveSpawnCommand(
      'agent',
      root,
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: binDir,
        PathExt: '.cmd;.EXE',
      },
      ['--flag', 'value with spaces'],
      'win32'
    )

    expect(resolved).toEqual({
      args: ['/d', '/c', 'chcp', '65001>nul', '&', commandPath, '--flag', 'value with spaces'],
      command: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  test('wraps native .exe agent binaries with cmd.exe too, so their console codepage is UTF-8', () => {
    const root = mkdtempSync(join(tmpdir(), 'gachi-command-spawn-exe-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    const commandPath = join(binDir, 'agent.exe')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(commandPath, 'placeholder binary')

    const resolved = resolveSpawnCommand(
      'agent',
      root,
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: binDir,
        PathExt: '.cmd;.exe',
      },
      ['--flag'],
      'win32'
    )

    expect(resolved).toEqual({
      args: ['/d', '/c', 'chcp', '65001>nul', '&', commandPath, '--flag'],
      command: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  // Regression test: node-pty's own Windows arg-to-command-line converter
  // (argsToCommandLine) re-quotes/escapes array elements in ways that can
  // silently mangle a hand-built, pre-quoted command-line string (see the
  // comment on resolveSpawnCommand). This feeds our real args array through
  // node-pty's actual converter and asserts the executable path survives
  // intact and unescaped — catching that class of bug even though the tuple
  // equality tests above cannot.
  test('the emitted args survive node-pty Windows command-line construction unmangled', async () => {
    // @ts-expect-error node-pty does not ship types for this internal subpath
    const { argsToCommandLine } = await import('node-pty/lib/windowsPtyAgent.js')
    const root = mkdtempSync(join(tmpdir(), 'gachi-command-spawn-ptycheck-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    const commandPath = join(binDir, 'agent with spaces.exe')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(commandPath, 'placeholder binary')

    const resolved = resolveSpawnCommand(
      'agent with spaces',
      root,
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: binDir, PathExt: '.exe' },
      ['--flag', 'value with spaces'],
      'win32'
    )

    const commandLine = argsToCommandLine(resolved.command, resolved.args)
    expect(commandLine).not.toContain('\\"')
    expect(commandLine).toContain(`"${commandPath}"`)
    expect(commandLine).toContain('"value with spaces"')
  })
})
