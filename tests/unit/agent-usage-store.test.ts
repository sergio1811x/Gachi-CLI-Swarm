import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentUsageStore } from '../../src/server/agent-usage-store.js'
import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

const dirs: string[] = []
const dbs: import('better-sqlite3').Database[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeDb = (): import('better-sqlite3').Database => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-usage-'))
  dirs.push(dir)
  const db = new Database(':memory:')
  dbs.push(db)
  initializeRuntimeDatabase(db)
  return db
}

describe('schema v25 — agent_usage_samples', () => {
  test('CURRENT_SCHEMA_VERSION is 25 and the table exists after init', () => {
    const db = makeDb()
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number
    }
    expect(version.v).toBe(CURRENT_SCHEMA_VERSION)
    expect(version.v).toBeGreaterThanOrEqual(25)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_usage_samples'")
      .get()
    expect(table).toBeDefined()
  })
})

describe('agent usage store', () => {
  test('records samples and throttles faster-than-1min writes per agent', () => {
    const store = createAgentUsageStore(makeDb())
    const t0 = Date.now()

    expect(
      store.recordSample({
        workspaceId: 'ws',
        agentId: 'a1',
        contextPercent: 10,
        tokensUsed: 1000,
        at: t0,
      })
    ).toBe(true)
    // Same agent within a minute → throttled.
    expect(
      store.recordSample({
        workspaceId: 'ws',
        agentId: 'a1',
        contextPercent: 20,
        tokensUsed: 1500,
        at: t0 + 30_000,
      })
    ).toBe(false)
    // Another agent is independent.
    expect(
      store.recordSample({
        workspaceId: 'ws',
        agentId: 'a2',
        contextPercent: 5,
        tokensUsed: 100,
        at: t0 + 30_000,
      })
    ).toBe(true)
    // After the throttle window the write goes through.
    expect(
      store.recordSample({
        workspaceId: 'ws',
        agentId: 'a1',
        contextPercent: 40,
        tokensUsed: 3000,
        at: t0 + 61_000,
      })
    ).toBe(true)

    const metrics = store.workspaceMetrics('ws', 60 * 60_000)
    // a1@t0 + a2@+30s + a1@+61s — the throttled duplicate never lands.
    expect(metrics.samples).toHaveLength(3)
    expect(metrics.agents.find((a) => a.agentId === 'a1')?.lastTokensUsed).toBe(3000)
    expect(metrics.agents.find((a) => a.agentId === 'a1')?.peakContextPercent).toBe(40)
  })

  test('token deltas approximate in-window consumption; prune drops old rows', () => {
    const store = createAgentUsageStore(makeDb())
    const t0 = Date.now()
    store.recordSample({
      workspaceId: 'ws',
      agentId: 'a1',
      tokensUsed: 1000,
      contextPercent: 10,
      at: t0,
    })
    store.recordSample({
      workspaceId: 'ws',
      agentId: 'a1',
      tokensUsed: 2500,
      contextPercent: 50,
      at: t0 + 61_000,
    })

    const metrics = store.workspaceMetrics('ws', 60 * 60_000)
    const second = metrics.samples.at(-1)!
    expect(second.tokensDelta).toBe(1500)

    store.pruneOlderThan(t0 + 120_000)
    expect(store.workspaceMetrics('ws', 60 * 60_000).samples).toHaveLength(0)
  })

  test('workspace isolation', () => {
    const store = createAgentUsageStore(makeDb())
    store.recordSample({
      workspaceId: 'ws1',
      agentId: 'a1',
      tokensUsed: 10,
      contextPercent: null,
      at: 1,
    })
    store.recordSample({
      workspaceId: 'ws2',
      agentId: 'a1',
      tokensUsed: 20,
      contextPercent: null,
      at: 1,
    })
    expect(store.listSamples('ws1', 0)).toHaveLength(1)
    expect(store.listSamples('ws2', 0)).toHaveLength(1)
  })
})
