import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { ensureOpencodePermissions } from '../../src/server/opencode-permissions.js'
import { createPromptAutoResponder } from '../../src/server/prompt-autoresponder.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('prompt auto-responder', () => {
  const makeDeps = (
    targets: Array<{ runId: string; tail: string }>,
    sendEnter: ReturnType<typeof vi.fn>
  ) => ({
    getTargets: () => targets,
    sendEnter,
    intervalMs: 10,
  })

  test('sends Enter when dialog pattern matches', () => {
    const sendEnter = vi.fn()
    const responder = createPromptAutoResponder(
      makeDeps([{ runId: 'run-1', tail: 'Allow access to this folder? [Y/n]' }], sendEnter)
    )
    responder.tick()
    expect(sendEnter).toHaveBeenCalledWith('run-1')
    responder.stop()
  })

  test('does NOT send Enter for normal output', () => {
    const sendEnter = vi.fn()
    const responder = createPromptAutoResponder(
      makeDeps([{ runId: 'run-1', tail: 'Compiling TypeScript...\nDone in 3.2s' }], sendEnter)
    )
    responder.tick()
    expect(sendEnter).not.toHaveBeenCalled()
    responder.stop()
  })

  test('budget limits Enter sends per runId', () => {
    const sendEnter = vi.fn()
    const target = { runId: 'run-budget', tail: 'press enter to continue' }
    const responder = createPromptAutoResponder({
      getTargets: () => [target],
      sendEnter,
      intervalMs: 10,
    })
    for (let i = 0; i < 20; i += 1) responder.tick()
    expect(sendEnter.mock.calls.length).toBeLessThanOrEqual(5)
    responder.stop()
  })
})

describe('opencode permissions file', () => {
  test('creates opencode.json in a fresh workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gachi-oc-perm-'))
    tempDirs.push(dir)
    expect(ensureOpencodePermissions(dir)).toBe(true)
    const content = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))
    expect(content.permission.edit).toBe('allow')
    expect(content.permission.bash['*']).toBe('allow')
  })

  test('does NOT overwrite an existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gachi-oc-existing-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'opencode.json'), '{"custom":true}')
    expect(ensureOpencodePermissions(dir)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8')).custom).toBe(true)
  })
})
