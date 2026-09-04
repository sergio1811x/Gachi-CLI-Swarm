import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  findAvailableReviewer,
  getOpenReviewTaskForWorker,
  getReviewTask,
  parseReviewVerdict,
  routeReadyReviewTasks,
  routeReviewTaskToReviewer,
} from '../../src/server/reviewer-pipeline.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { taskStore } from '../../src/server/task-store.js'
import type { AgentSummary } from '../../src/shared/types.js'

let db: BetterSqlite3.Database

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-reviewer-'))
  db = new BetterSqlite3(join(dir, 'runtime.sqlite'))
  initializeRuntimeDatabase(db)
  taskStore.init(db)
})

afterEach(() => {
  taskStore.clear()
  db.close()
})

const reviewerAgent = (id: string, overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  workspaceId: 'ws-1',
  name: id.split(':').pop() ?? id,
  description: 'quality-focused reviewer',
  role: 'reviewer',
  status: 'idle',
  pendingTaskCount: 0,
  ...overrides,
})

describe('reviewer pipeline', () => {
  test('parseReviewVerdict recognizes approve and rework markers', () => {
    expect(parseReviewVerdict('APPROVE\nLooks good')).toBe('approve')
    expect(parseReviewVerdict('REQUEST_CHANGES\nFix the tests')).toBe('rework')
    expect(parseReviewVerdict('no marker here')).toBeNull()
  })

  test('findAvailableReviewer skips stopped/working agents and the reporter', () => {
    const agents = [
      reviewerAgent('ws-1:r1', { status: 'working' }),
      reviewerAgent('ws-1:r2', { status: 'idle' }),
      reviewerAgent('ws-1:r3', { status: 'stopped' }),
    ]
    expect(findAvailableReviewer(agents, 'ws-1:r2')?.id).toBeUndefined()
    expect(findAvailableReviewer(agents, 'ws-1:coder')?.id).toBe('ws-1:r2')
  })

  test('routes a review task to a free reviewer and marks it', () => {
    taskStore.createTask('ws-1', {
      status: 'review',
      title: 'Fix login bug',
      reviewRequired: true,
    })

    const dispatched: Array<{ reviewerId: string; text: string }> = []
    let routed = 0
    const ok = routeReviewTaskToReviewer({
      dispatch: async (_ws, reviewerId, text) => {
        dispatched.push({ reviewerId, text })
      },
      getAgents: () => [reviewerAgent('ws-1:r1')],
      onRouted: () => {
        routed++
      },
      taskId: taskStore.listTasks('ws-1')[0]?.id,
      workspaceId: 'ws-1',
    })

    expect(ok).toBe(true)
    expect(routed).toBe(1)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.reviewerId).toBe('ws-1:r1')
    expect(dispatched[0]?.text).toContain('APPROVE')

    const reviewTask = taskStore.listTasks('ws-1').find((t) => t.title === 'Review: Fix login bug')
    expect(reviewTask).toBeDefined()
    expect(reviewTask?.assignedAgentId).toBe('ws-1:r1')
    expect(reviewTask?.reviewRequired).toBe(false)
    expect(reviewTask?.parentTaskId).toBe(taskStore.listTasks('ws-1')[0]?.id)
    expect(reviewTask?.reviewerAgentId).toBe('ws-1:r1')
  })

  test('links a review task to its original task by ID, not by title', () => {
    const original = taskStore.createTask('ws-1', {
      status: 'review',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.createTask('ws-1', {
      assignedAgentId: 'ws-1:r1',
      parentTaskId: original.id,
      reviewerAgentId: 'ws-1:r1',
      reviewRequired: false,
      role: 'reviewer',
      status: 'assigned',
      title: 'Review: Fix login bug',
    })

    const reviewTask = getOpenReviewTaskForWorker('ws-1', 'ws-1:r1')
    expect(reviewTask).toBeDefined()
    expect(reviewTask?.id).not.toBe(original.id)
    expect(reviewTask?.parentTaskId).toBe(original.id)
    expect(reviewTask?.reviewerAgentId).toBe('ws-1:r1')
    expect(reviewTask?.status).toBe('assigned')

    const byId = getReviewTask('ws-1', reviewTask?.id ?? '')
    expect(byId?.parentTaskId).toBe(original.id)
  })

  test('does not double-route a review task that already has an open review child', () => {
    const task = taskStore.createTask('ws-1', {
      status: 'review',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    // An open child card is the dedupe marker — journal lines are capped and
    // must not be load-bearing.
    taskStore.createTask('ws-1', {
      assignedAgentId: 'ws-1:r1',
      parentTaskId: task.id,
      reviewerAgentId: 'ws-1:r1',
      reviewRequired: false,
      role: 'reviewer',
      status: 'assigned',
      title: 'Review: Fix login bug',
    })

    let dispatched = 0
    const ok = routeReviewTaskToReviewer({
      dispatch: async () => {
        dispatched++
      },
      getAgents: () => [reviewerAgent('ws-1:r1')],
      taskId: task.id,
      workspaceId: 'ws-1',
    })

    expect(ok).toBe(false)
    expect(dispatched).toBe(0)
    expect(taskStore.listTasks('ws-1').filter((t) => t.parentTaskId === task.id)).toHaveLength(1)
  })

  test('stamps no duplicate review card after the journal marker scrolls out', () => {
    const task = taskStore.createTask('ws-1', {
      status: 'review',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.createTask('ws-1', {
      assignedAgentId: 'ws-1:r1',
      parentTaskId: task.id,
      reviewerAgentId: 'ws-1:r1',
      reviewRequired: false,
      role: 'reviewer',
      status: 'assigned',
      title: 'Review: Fix login bug',
    })
    // Push the old `[REVIEWER] sent to` marker out of the capped journal.
    for (let i = 0; i < 250; i++) {
      taskStore.addLog('ws-1', task.id, `noise line ${i}`)
    }

    let dispatched = 0
    routeReviewTaskToReviewer({
      dispatch: async () => {
        dispatched++
      },
      getAgents: () => [reviewerAgent('ws-1:r1')],
      taskId: task.id,
      workspaceId: 'ws-1',
    })

    expect(dispatched).toBe(0)
    expect(taskStore.listTasks('ws-1').filter((t) => t.parentTaskId === task.id)).toHaveLength(1)
  })

  test('routes a second review round after the previous child was settled', () => {
    const task = taskStore.createTask('ws-1', {
      status: 'review',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    const firstChild = taskStore.createTask('ws-1', {
      assignedAgentId: 'ws-1:r1',
      parentTaskId: task.id,
      reviewerAgentId: 'ws-1:r1',
      reviewRequired: false,
      role: 'reviewer',
      status: 'assigned',
      title: 'Review: Fix login bug',
    })
    // The rework verdict settles the child; the parent is back in review.
    taskStore.updateTask('ws-1', firstChild.id, { status: 'done' })

    let dispatched = 0
    const ok = routeReviewTaskToReviewer({
      dispatch: async () => {
        dispatched++
      },
      getAgents: () => [reviewerAgent('ws-1:r2')],
      taskId: task.id,
      workspaceId: 'ws-1',
    })

    expect(ok).toBe(true)
    expect(dispatched).toBe(1)
    const children = taskStore.listTasks('ws-1').filter((t) => t.parentTaskId === task.id)
    expect(children).toHaveLength(2)
    expect(children.find((t) => t.id !== firstChild.id)?.assignedAgentId).toBe('ws-1:r2')
  })

  test('routeReadyReviewTasks routes every unassigned review task', () => {
    taskStore.createTask('ws-1', { status: 'review', title: 'A', reviewRequired: true })
    taskStore.createTask('ws-1', { status: 'review', title: 'B', reviewRequired: true })
    taskStore.createTask('ws-1', { status: 'running', title: 'C', reviewRequired: true })

    let dispatched = 0
    const count = routeReadyReviewTasks({
      dispatch: async () => {
        dispatched++
      },
      getAgents: () => [reviewerAgent('ws-1:r1')],
      workspaceId: 'ws-1',
    })

    expect(count).toBe(2)
    expect(dispatched).toBe(2)
  })
})
