import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { ConflictError } from '../../src/server/http-errors.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const createStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createWorkspaceStore(db, []) }
}

describe('workspace store', () => {
  test('rejects a workspace with the same canonical path twice', () => {
    const { db, store } = createStore()
    store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    expect(() => store.createWorkspace('/tmp/gachi-alpha', 'Alpha 2')).toThrow(ConflictError)
    expect(store.listWorkspaces()).toHaveLength(1)
    db.close()
  })

  test('rejects an empty workspace name', () => {
    const { db, store } = createStore()
    expect(() => store.createWorkspace('/tmp/gachi-alpha', '   ')).toThrow(
      'Workspace name must not be empty'
    )
    db.close()
  })

  test('trims workspace names', () => {
    const { db, store } = createStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', '  Alpha  ')
    expect(workspace.name).toBe('Alpha')
    db.close()
  })

  test('validates worker description on create like PATCH does', () => {
    const { db, store } = createStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'coder',
        description: 'x'.repeat(2001),
      })
    ).toThrow('Worker description must be 2000 characters or fewer')
    db.close()
  })

  test('falls back to the default role description when none is provided', () => {
    const { db, store } = createStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    expect(worker.description.length).toBeGreaterThan(0)
    db.close()
  })
})
