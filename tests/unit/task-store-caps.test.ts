import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  MAX_DESCRIPTION_LEN,
  MAX_LOG_LEN,
  MAX_TASK_LOGS,
  taskStore,
} from '../../src/server/task-store.js'

const databases: Database[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  taskStore.detachDatabase()
})

const makeDb = () => {
  const db = new Database(':memory:')
  databases.push(db)
  initializeRuntimeDatabase(db)
  return db
}

describe('task store size caps (S-2 eternal-loader incident)', () => {
  test('addLog truncates single entries and rolls the buffer', () => {
    const db = makeDb()
    taskStore.init(db)
    const task = taskStore.createTask('ws-1', { title: 't' })

    const huge = 'x'.repeat(MAX_LOG_LEN * 3)
    for (let i = 0; i < MAX_TASK_LOGS + 50; i += 1) {
      taskStore.addLog('ws-1', task.id, `${i}:${huge}`)
    }
    const stored = taskStore.getTask('ws-1', task.id)!
    expect(stored.logs.length).toBeLessThanOrEqual(MAX_TASK_LOGS)
    for (const line of stored.logs) {
      // ISO prefix (~25) + truncation marker may pad the clamped body a bit.
      expect(line.length).toBeLessThanOrEqual(MAX_LOG_LEN + 96)
    }
  })

  test('description and result clamps hold through create/update/poke-style merge', () => {
    const db = makeDb()
    taskStore.init(db)
    const hugeOld = 'a'.repeat(MAX_DESCRIPTION_LEN * 2)
    const created = taskStore.createTask('ws-1', { title: 't', description: hugeOld })
    expect(created.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN + 64)

    // Poke-style bounded merge keeps the TAIL (recent instructions).
    const mergedTail = `${created.description}\n\n---\n${'b'.repeat(100)}`
    const tailKept = mergedTail.slice(-16_000)
    const updated = taskStore.updateTask('ws-1', created.id, {
      description: tailKept,
      result: 'r'.repeat(MAX_DESCRIPTION_LEN * 4),
    })
    expect(updated!.result!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN * 4 + 64)
    expect(updated!.description).toContain('bbb')
  })

  test('self-heals a legacy oversized blob: writes succeed again after compaction', () => {
    const db = makeDb()

    // Plant an oversized blob the way the incident left it.
    const giantLogs: string[] = []
    for (let i = 0; i < MAX_TASK_LOGS; i += 1)
      giantLogs.push(`[${new Date().toISOString()}] ${'z'.repeat(400_000)}`)
    const legacyTasks = [
      {
        id: 'legacy-1',
        workspaceId: 'ws-big',
        title: 'legacy',
        description: 'd'.repeat(2_000_000),
        status: 'running',
        logs: giantLogs,
        dependencies: [],
        priority: 'normal',
        requiredSkills: [],
        reviewRequired: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]
    db.prepare(
      "INSERT INTO app_state (key, value, updated_at) VALUES ('kanban_tasks_v1', ?, ?)"
    ).run(JSON.stringify(legacyTasks), Date.now())

    taskStore.init(db)

    // Any mutation must now persist successfully (no RangeError escape).
    const anyTask = taskStore.getTask('ws-big', 'legacy-1')!
    expect(anyTask.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN + 64)
    taskStore.addLog('ws-big', 'legacy-1', 'post-heal write')

    const raw = (
      db.prepare("SELECT value FROM app_state WHERE key='kanban_tasks_v1'").get() as {
        value: string
      }
    ).value
    // The healed blob must be far below SQLite's bind limit (~1GB) — sanity:
    expect(raw.length).toBeLessThan(8_000_000)
    expect(raw).toContain('post-heal write')
  })
})

describe('legacy fallback resume (S-1 bridge)', () => {
  test('newestClaudeSessionId picks the freshest file within the age window', async () => {
    const { newestClaudeSessionId } = await import('../../src/server/session-capture-claude.js')
    const { utimesSync } = await import('node:fs')
    const cwd = mkdtempSync(join(tmpdir(), 'gachi-fb-cwd-'))
    tempDirs.push(cwd)
    const home = mkdtempSync(join(tmpdir(), 'gachi-fb-home-'))
    tempDirs.push(home)
    const dir = join(home, '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'))
    mkdirSync(dir, { recursive: true })

    const oldId = '11111111-1111-4111-8111-111111111111'
    const newId = '22222222-2222-4222-8222-222222222222'
    writeFileSync(join(dir, `${oldId}.jsonl`), '{}\n')
    await new Promise((resolve) => setTimeout(resolve, 40))
    writeFileSync(join(dir, `${newId}.jsonl`), '{}\n')
    const past = new Date(Date.now() - 30 * 24 * 3600_000)
    utimesSync(join(dir, `${oldId}.jsonl`), past, past)

    process.env.GACH_CLAUDE_PROJECTS_DIR = join(home, '.claude', 'projects')
    try {
      expect(newestClaudeSessionId(cwd)).toBe(newId)
      // Age everything past a tiny window → nothing qualifies.
      const stale = new Date(Date.now() - 5_000)
      utimesSync(join(dir, `${newId}.jsonl`), stale, stale)
      expect(newestClaudeSessionId(cwd, undefined, 1_000)).toBeNull()
    } finally {
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
    }
  })
})
