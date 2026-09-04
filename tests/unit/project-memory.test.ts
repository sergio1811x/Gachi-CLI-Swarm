import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { ensureProjectMemory, readProjectMemory } from '../../src/server/project-memory.js'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true })
  })
)

describe('project memory', () => {
  test('creates and reads the shared memory files for all agents', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'gachi-memory-'))
    directories.push(workspace)
    expect(ensureProjectMemory(workspace)).toContain('.gachi')
    expect(readProjectMemory(workspace)).toContain('architecture.md')
    expect(readProjectMemory(workspace)).toContain('rules.md')
  })
})
