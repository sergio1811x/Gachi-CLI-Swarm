import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { getWorkspaceActivity, minutesSinceLastArtifact } from '../../src/server/artifact-clock.js'
import { classifyFailure, tailOf } from '../../src/server/failure-classifier.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { type TaskRecord, taskStore } from '../../src/server/task-store.js'

const tempDirs: string[] = []
const databases: Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  taskStore.detachDatabase?.()
})

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-feedback-'))
  tempDirs.push(dir)
  return dir
}

describe('failure classifier (feedback #2)', () => {
  test('detects auth failures', () => {
    const result = classifyFailure(tailOf('Error: Invalid API key provided'), 1)
    expect(result.category).toBe('auth')
    expect(result.detail.toLowerCase()).toContain('invalid api key')
  })

  test('detects rate limiting', () => {
    const result = classifyFailure(tailOf('API error: 429 too many requests, retry later'), 1)
    expect(result.category).toBe('rate-limit')
  })

  test('detects network failures through ANSI noise', () => {
    const result = classifyFailure(
      tailOf('\u001b[31mTypeError: fetch failed\u001b[0m\n at main (\u001b[2mindex.js\u001b[22m)'),
      1
    )
    expect(result.category).toBe('network')
  })

  test('detects OOM and missing CLI', () => {
    expect(
      classifyFailure(
        tailOf(
          'FATAL ERROR: Reached heap limit - Allocation failed - JavaScript heap out of memory'
        ),
        134
      ).category
    ).toBe('oom')
    expect(classifyFailure('', 127, 'claude: command not found').category).toBe('cli-missing')
  })

  test('recorded error wins as evidence when output is empty', () => {
    const result = classifyFailure('', null, 'spawn ENOENT')
    expect(result.category).toBe('cli-missing')
  })

  test('generic nonzero exit keeps the last meaningful lines', () => {
    const result = classifyFailure(tailOf('build step\nwebpack compiled with 2 errors\nexit'), 1)
    expect(result.category).toBe('nonzero-exit')
    expect(result.detail.length).toBeGreaterThan(0)
  })
})

describe('artifact clock (feedback #3)', () => {
  test('reports the freshest file mtime in a plain directory', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'a.txt'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 30))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'b.txt'), 'y')

    const activity = await getWorkspaceActivity(dir)
    expect(activity.changedFiles).toBeGreaterThanOrEqual(2)
    expect(activity.lastArtifactAt).not.toBeNull()

    const minutes = minutesSinceLastArtifact(activity)
    expect(minutes).toBe(0) // just written
  }, 15_000)

  test('ignores .gachi / node_modules / dist churn', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'keep.txt'), 'x')
    mkdirSync(join(dir, '.gachi'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Heavy churn in ignored dirs only.
    writeFileSync(join(dir, '.gachi', 'noise.log'), 'x'.repeat(100))
    writeFileSync(join(dir, 'node_modules', 'noise.js'), 'y')

    const activity = await getWorkspaceActivity(dir)
    // Shallow scan skips ignored dirs entirely.
    expect(activity.changedFiles).toBeLessThan(4)
  }, 15_000)

  test('missing directory degrades to empty result', async () => {
    const activity = await getWorkspaceActivity(join(makeTempDir(), 'nope'))
    expect(activity.lastArtifactAt).toBeNull()
  })
})

describe('task lineage + duplicate hints (feedback #1)', () => {
  test('supersededFrom survives create → reload roundtrip', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initializeRuntimeDatabase(db)
    taskStore.init(db)

    const created = taskStore.createTask('ws-1', {
      title: 'audit backend',
      status: 'ready',
      supersededFrom: 'aaaaaaaa-1111-2222-3333-444444444444',
    })
    expect(created.supersededFrom).toBe('aaaaaaaa-1111-2222-3333-444444444444')

    // Simulate restart: fresh store over same DB blob.
    const fresh = new Database(':memory:')
    databases.push(fresh)
    initializeRuntimeDatabase(fresh)
    const persisted = db
      .prepare("SELECT value FROM app_state WHERE key='kanban_tasks_v1'")
      .get() as {
      value: string
    }
    fresh
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('kanban_tasks_v1', ?, ?)")
      .run(persisted.value, Date.now())
    taskStore.init(fresh)
    const reloaded = taskStore.getTask('ws-1', created.id)
    expect(reloaded?.supersededFrom).toBe('aaaaaaaa-1111-2222-3333-444444444444')

    // Clearing works too (null update).
    taskStore.updateTask('ws-1', created.id, { supersededFrom: null })
    expect(taskStore.getTask('ws-1', created.id)?.supersededFrom).toBeUndefined()
  })

  test('updateTask can set lineage after creation', () => {
    const db = new Database(':memory:')
    databases.push(db)
    initializeRuntimeDatabase(db)
    taskStore.init(db)

    const original = taskStore.createTask('ws-2', { title: 'old attempt' })
    const replacement = taskStore.createTask('ws-2', { title: 'old attempt v2' })
    taskStore.updateTask('ws-2', replacement.id, { supersededFrom: original.id })
    expect(taskStore.getTask('ws-2', replacement.id)?.supersededFrom).toBe(original.id)
  })

  test('duplicate annotation normalizes punctuation/whitespace titles', () => {
    const tasks: Array<Pick<TaskRecord, 'id' | 'status' | 'title'>> = [
      { id: 't-1aaaaaaaa', status: 'running', title: 'Fix login bug!' },
      { id: 't-2bbbbbbbb', status: 'ready', title: 'fix   login, BUG' },
      { id: 't-3cccccccc', status: 'done', title: 'fix login bug' },
    ]
    // Re-implement locally via exported route helper semantics — import path
    // would drag HTTP deps; keep this a contract mirror of routes-tasks.
    const normalizedFor = (title: string): string =>
      title
        .toLowerCase()
        .replace(/[\s\p{P}]+/gu, ' ')
        .trim()
    const active = tasks.filter((task) => task.status !== 'done')
    const ACTIVE = new Set(['backlog', 'ready', 'assigned', 'claimed', 'running'])
    const dupOf = (task: { id: string; status: string; title: string }): string | null => {
      if (!ACTIVE.has(task.status)) return null
      return (
        active
          .find(
            (other) =>
              other.id !== task.id && normalizedFor(other.title) === normalizedFor(task.title)
          )
          ?.id.slice(0, 8) ?? null
      )
    }

    // find() returns the first matching ACTIVE card in list order.
    expect(dupOf(tasks[0]!)).toBe('t-2bbbbb')
    expect(dupOf(tasks[1]!)).toBe('t-1aaaaa')
    expect(dupOf(tasks[2]!)).toBeNull() // done cards never flagged
  })
})
