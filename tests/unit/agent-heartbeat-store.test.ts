import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createAgentHeartbeatStore } from '../../src/server/agent-heartbeat-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

let db: BetterSqlite3.Database
let tempDirs: string[]

beforeEach(() => {
  tempDirs = []
  const dir = mkdtempSync(join(tmpdir(), 'gachi-heartbeat-'))
  tempDirs.push(dir)
  db = new BetterSqlite3(join(dir, 'runtime.sqlite'))
  initializeRuntimeDatabase(db)
})

afterEach(() => {
  db.close()
})

describe('agent heartbeat store', () => {
  test('records a heartbeat with status, phase, currentAction and lastSeen', () => {
    const store = createAgentHeartbeatStore(db)
    store.record('ws-1', 'ws-1:coder', {
      currentAction: 'Running tests',
      phase: 'Running tests',
      status: 'working',
    })

    const heartbeat = store.get('ws-1', 'ws-1:coder')
    expect(heartbeat).toBeDefined()
    expect(heartbeat?.agentId).toBe('ws-1:coder')
    expect(heartbeat?.status).toBe('working')
    expect(heartbeat?.phase).toBe('Running tests')
    expect(heartbeat?.currentAction).toBe('Running tests')
    expect(heartbeat?.lastSeen).toBeGreaterThan(0)
  })

  test('preserves omitted fields across refreshes', () => {
    const store = createAgentHeartbeatStore(db)
    store.record('ws-1', 'ws-1:coder', {
      phase: 'Running tests',
      status: 'working',
    })
    store.record('ws-1', 'ws-1:coder', {
      currentAction: 'Fixing lint errors',
    })

    const heartbeat = store.get('ws-1', 'ws-1:coder')
    expect(heartbeat?.phase).toBe('Running tests')
    expect(heartbeat?.status).toBe('working')
    expect(heartbeat?.currentAction).toBe('Fixing lint errors')
  })

  test('isStale is true for an agent with no heartbeat at all', () => {
    const store = createAgentHeartbeatStore(db)
    expect(store.isStale('ws-1', 'ws-1:ghost', 5000)).toBe(true)
  })

  test('isStale flips based on the lastSeen age', () => {
    const store = createAgentHeartbeatStore(db)
    store.record('ws-1', 'ws-1:coder', {
      lastSeen: 1_000,
      status: 'working',
    })
    // Fresh at t=1000 within a 5s window.
    expect(store.isStale('ws-1', 'ws-1:coder', 5000, 5_000)).toBe(false)
    // Stale once more than 5s have elapsed.
    expect(store.isStale('ws-1', 'ws-1:coder', 5000, 6_001)).toBe(true)
  })

  test('delete removes the heartbeat record', () => {
    const store = createAgentHeartbeatStore(db)
    store.record('ws-1', 'ws-1:coder', { status: 'working' })
    store.delete('ws-1', 'ws-1:coder')
    expect(store.get('ws-1', 'ws-1:coder')).toBeUndefined()
    expect(store.isStale('ws-1', 'ws-1:coder', 5000)).toBe(true)
  })

  test('heartbeats are scoped per workspace', () => {
    const store = createAgentHeartbeatStore(db)
    store.record('ws-1', 'ws-1:coder', { status: 'working' })
    expect(store.get('ws-2', 'ws-1:coder')).toBeUndefined()
    expect(store.isStale('ws-2', 'ws-1:coder', 5000)).toBe(true)
  })
})
