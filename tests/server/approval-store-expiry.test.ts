import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { APPROVAL_TTL_MS, createApprovalStore } from '../../src/server/approval-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const createStore = (
  hooks: Parameters<typeof createApprovalStore>[1] = {},
  getTtlMs?: () => number
) => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  return { db, store: createApprovalStore(db, hooks, getTtlMs) }
}

/** Backdates every pending request so expiry is deterministic (no ms races). */
const backdateAll = (db: Database, ms: number) => {
  db.prepare('UPDATE approval_requests SET created_at = created_at - ?').run(ms)
}

describe('approval store expiry (audit M-4)', () => {
  test('pending requests older than the TTL flip to expired and notify the hook', () => {
    const expired: string[] = []
    const { db, store } = createStore({
      onExpired: (requests) => {
        for (const request of requests) expired.push(request.id)
      },
    })

    const request = store.create({
      agentId: 'ws-1:worker',
      command: 'npm install left-pad',
      workspaceId: 'ws-1',
    })
    expect(request.status).toBe('pending')
    backdateAll(db, 2 * 60 * 60_000)

    // Any read runs expireStale; the hook must fire exactly once.
    const pendingAfterExpiry = store.listPending('ws-1')
    expect(pendingAfterExpiry).toEqual([])
    expect(expired).toEqual([request.id])

    const decided = store.get(request.id)
    expect(decided?.status).toBe('expired')
    expect(decided?.decidedAt).not.toBeNull()

    // A second read must not re-report the same expiry.
    store.listPending('ws-1')
    expect(expired).toEqual([request.id])
  })

  test('default TTL is used when no override is provided', () => {
    let observedTtl: number | null = null
    const db = new Database(':memory:')
    databases.push(db)
    initializeRuntimeDatabase(db)
    const store = createApprovalStore(db, {}, () => {
      observedTtl = APPROVAL_TTL_MS
      return APPROVAL_TTL_MS
    })
    store.create({ agentId: 'a', command: 'x', workspaceId: 'ws' })
    store.listPending('ws')
    expect(observedTtl).toBe(APPROVAL_TTL_MS)
  })

  test('decide still wins over expiry for requests inside the TTL window', () => {
    // Generous TTL: nothing is stale yet.
    const { store } = createStore({}, () => APPROVAL_TTL_MS)
    const request = store.create({
      agentId: 'ws-1:worker',
      command: 'rm -rf build',
      workspaceId: 'ws-1',
    })
    const decided = store.decide(request.id, 'denied', '@owner')
    expect(decided?.status).toBe('denied')
    expect(store.listPending('ws-1')).toEqual([])
  })

  test('expired requests cannot be decided anymore', () => {
    const { db, store } = createStore()
    const request = store.create({ agentId: 'a', command: 'c', workspaceId: 'ws' })
    backdateAll(db, 2 * 60 * 60_000)
    store.listPending('ws') // trigger expiry
    expect(store.decide(request.id, 'approved', '@owner')).toBeUndefined()
  })
})
