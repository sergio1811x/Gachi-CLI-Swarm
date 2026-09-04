import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildProtocolDoc } from '../../src/server/gachi-team-guidance.js'
import {
  ensureProtocolFile,
  getProtocolFilePath,
  PROTOCOL_RELATIVE_PATH,
} from '../../src/server/tasks-file.js'

const tempDirs: string[] = []
const newWorkspace = () => {
  const path = mkdtempSync(join(tmpdir(), 'gachi-protocol-test-'))
  tempDirs.push(path)
  return path
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true })
})

describe('ensureProtocolFile', () => {
  test('creates .gachi/PROTOCOL.md with the current protocol doc when missing', () => {
    const workspace = newWorkspace()
    expect(existsSync(getProtocolFilePath(workspace))).toBe(false)

    ensureProtocolFile(workspace)

    const written = readFileSync(getProtocolFilePath(workspace), 'utf8')
    expect(written).toEqual(buildProtocolDoc())
  })

  test('overwrites a stale PROTOCOL.md so a version bump propagates without manual edits', () => {
    const workspace = newWorkspace()
    ensureProtocolFile(workspace)
    const path = getProtocolFilePath(workspace)
    writeFileSync(path, '# OUTDATED CONTENT FROM AN OLD VERSION', 'utf8')

    ensureProtocolFile(workspace)

    expect(readFileSync(path, 'utf8')).toEqual(buildProtocolDoc())
  })

  test('is a no-op when current content already matches (idempotent — no spurious mtime churn)', async () => {
    const workspace = newWorkspace()
    ensureProtocolFile(workspace)
    const path = getProtocolFilePath(workspace)
    const mtimeBefore = statSync(path).mtimeMs
    // Sleep ≥10ms so a stray writeFileSync would shift mtimeMs on every
    // platform (macOS HFS+ has a 1s mtime resolution on some volumes, but
    // APFS / ext4 / NTFS resolve milliseconds; 10ms is enough to detect
    // the rewrite if the idempotency short-circuit is removed).
    await new Promise((resolve) => setTimeout(resolve, 10))

    ensureProtocolFile(workspace)

    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  test('PROTOCOL_RELATIVE_PATH stays under the workspace .gachi/ namespace', () => {
    expect(PROTOCOL_RELATIVE_PATH).toBe('.gachi/PROTOCOL.md')
  })
})
