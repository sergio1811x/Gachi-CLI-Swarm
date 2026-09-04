import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe.skipIf(SKIP_CONPTY_WINDOWS)('workspace persistence', () => {
  test('reloads workspaces from sqlite-backed storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gachi-store-'))
    tempDirs.push(tempDir)

    const firstStore = createRuntimeStore({ dataDir: tempDir })
    firstStore.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    firstStore.createWorkspace('/tmp/gachi-beta', 'Beta')

    const secondStore = createRuntimeStore({ dataDir: tempDir })

    expect(secondStore.listWorkspaces()).toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/gachi-alpha',
      },
      {
        id: expect.any(String),
        name: 'Beta',
        path: '/tmp/gachi-beta',
      },
    ])
  })

  test('renameWorkspace updates the name and persists across reloads', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gachi-store-'))
    tempDirs.push(tempDir)

    const firstStore = createRuntimeStore({ dataDir: tempDir })
    const workspace = firstStore.createWorkspace('/tmp/gachi-alpha', 'Alpha')

    const renamed = firstStore.renameWorkspace(workspace.id, 'Renamed Alpha')
    expect(renamed).toEqual({ id: workspace.id, name: 'Renamed Alpha', path: '/tmp/gachi-alpha' })

    const secondStore = createRuntimeStore({ dataDir: tempDir })
    expect(secondStore.listWorkspaces()).toEqual([
      { id: workspace.id, name: 'Renamed Alpha', path: '/tmp/gachi-alpha' },
    ])
  })
})
