import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import {
  createAgentRunRecordStore,
  type PersistedAgentRunRecord,
} from '../../src/server/agent-run-record-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []
const openDbs: Database.Database[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createDb = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-run-records-'))
  tempDirs.push(dataDir)
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  openDbs.push(db)
  initializeRuntimeDatabase(db)
  return db
}

const activeRecord = (id: string): PersistedAgentRunRecord => ({
  id,
  agentId: 'agent-1',
  createdAt: 1000,
  endedAt: null,
  error: null,
  exitCode: null,
  lastHeartbeat: null,
  lastOutput: '',
  lifecycleState: 'starting',
  pid: 42,
  runtimeState: 'starting',
  startedAt: 1000,
  taskId: 'task-1',
  updatedAt: 1000,
  workspaceId: 'ws-1',
})

describe('agent run record store', () => {
  test('upserts a record, lists it as active and exposes it by run id', () => {
    const store = createAgentRunRecordStore(createDb())
    store.upsertRun(activeRecord('run-1'))

    expect(store.getRun('run-1')).toMatchObject({ id: 'run-1', runtimeState: 'starting' })
    expect(store.listActive().map((record) => record.id)).toEqual(['run-1'])
    expect(store.getActiveForAgent('ws-1', 'agent-1')?.id).toBe('run-1')
  })

  test('partial updates persist and remove a run from the active set once finished', () => {
    const store = createAgentRunRecordStore(createDb())
    store.upsertRun(activeRecord('run-1'))

    store.updateRun('run-1', { runtimeState: 'running', lastHeartbeat: 2000, lastOutput: 'x' })
    expect(store.getRun('run-1')).toMatchObject({
      lastHeartbeat: 2000,
      lastOutput: 'x',
      runtimeState: 'running',
    })

    store.updateRun('run-1', { runtimeState: 'exited', exitCode: 0, endedAt: 3000 })
    expect(store.getRun('run-1')).toMatchObject({
      endedAt: 3000,
      exitCode: 0,
      runtimeState: 'exited',
    })
    expect(store.listActive()).toEqual([])
  })

  test('hydration reads the same records from a second store instance', () => {
    const db = createDb()
    const first = createAgentRunRecordStore(db)
    first.upsertRun(activeRecord('run-1'))

    const second = createAgentRunRecordStore(db)
    expect(second.getRun('run-1')).toMatchObject({ id: 'run-1', workspaceId: 'ws-1' })
    expect(second.listActive().map((record) => record.id)).toEqual(['run-1'])
  })

  test('deleteRun removes the record', () => {
    const store = createAgentRunRecordStore(createDb())
    store.upsertRun(activeRecord('run-1'))

    store.deleteRun('run-1')

    expect(store.getRun('run-1')).toBeUndefined()
    expect(store.listActive()).toEqual([])
    expect(store.listAll()).toEqual([])
  })

  test('upsertRun overwrites an existing row instead of duplicating it', () => {
    const store = createAgentRunRecordStore(createDb())
    store.upsertRun(activeRecord('run-1'))
    store.upsertRun({ ...activeRecord('run-1'), runtimeState: 'running', pid: 99 })

    expect(store.listAll()).toHaveLength(1)
    expect(store.getRun('run-1')).toMatchObject({ pid: 99, runtimeState: 'running' })
  })
})
