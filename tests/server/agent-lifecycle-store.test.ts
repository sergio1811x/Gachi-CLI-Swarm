import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentLifecycleStore } from '../../src/server/agent-lifecycle-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const databases: Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const createStore = () => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  return { db, store: createAgentLifecycleStore(db) }
}

describe('agent lifecycle store', () => {
  test('persists every valid transition and its event history', () => {
    const { db, store } = createStore()

    store.transition('ws-1', 'worker-1', 'starting', {
      reason: 'start_requested',
      runId: 'run-1',
    })
    store.transition('ws-1', 'worker-1', 'ready', { reason: 'process_started' })
    store.transition('ws-1', 'worker-1', 'stopping', { reason: 'stop_requested' })
    store.transition('ws-1', 'worker-1', 'stopped', { reason: 'process_exited', runId: null })

    expect(store.get('ws-1', 'worker-1')).toMatchObject({
      state: 'stopped',
      runId: null,
      lastError: null,
    })
    expect(
      db
        .prepare(
          'SELECT from_state, to_state, reason FROM agent_lifecycle_events WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at ASC, rowid ASC'
        )
        .all('ws-1', 'worker-1')
    ).toEqual([
      { from_state: null, to_state: 'starting', reason: 'start_requested' },
      { from_state: 'starting', to_state: 'ready', reason: 'process_started' },
      { from_state: 'ready', to_state: 'stopping', reason: 'stop_requested' },
      { from_state: 'stopping', to_state: 'stopped', reason: 'process_exited' },
    ])
  })

  test('does not write an event for an invalid transition', () => {
    const { db, store } = createStore()

    expect(() => store.transition('ws-1', 'worker-1', 'working')).toThrow(
      'Invalid agent lifecycle transition: created -> working'
    )
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_lifecycle_events').get()).toEqual({
      count: 0,
    })
  })

  test('marks lifecycle state left active by a restart as stopped (the runtime died, not the worker)', () => {
    const { store } = createStore()
    store.transition('ws-1', 'worker-1', 'starting')
    store.transition('ws-1', 'worker-1', 'ready')

    store.markUnfinishedAsStopped()

    expect(store.get('ws-1', 'worker-1')).toMatchObject({
      state: 'stopped',
      runId: null,
      lastError: 'Daemon restarted while the worker was up — process ended with the runtime',
    })
  })
})
