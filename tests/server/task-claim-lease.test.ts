import { afterEach, describe, expect, test } from 'vitest'

import { DEFAULT_CLAIM_TIMEOUT_MS, taskStore } from '../../src/server/task-store.js'

afterEach(() => {
  taskStore.clear()
})

describe('task claim lease', () => {
  test('claimTask stamps claimExpiresAt from a configurable timeout', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    const now = Date.now()

    const claimed = taskStore.claimTask('ws-1', task.id, 'agent-1', 30_000)

    expect(claimed?.claimExpiresAt).toBe((claimed?.claimedAt ?? 0) + 30_000)
    expect(claimed?.claimExpiresAt).toBeGreaterThan(now)
  })

  test('claimTask uses the default lease when no timeout is given', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    const claimed = taskStore.claimTask('ws-1', task.id, 'agent-1')

    expect(claimed?.claimExpiresAt).toBe((claimed?.claimedAt ?? 0) + DEFAULT_CLAIM_TIMEOUT_MS)
  })

  test('releaseExpiredClaims prefers the explicit lease over the age heuristic', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    taskStore.claimTask('ws-1', task.id, 'agent-1', 60_000)
    const now = Date.now()

    // Age heuristic (120s) has not passed, but the explicit 60s lease has.
    const released = taskStore.releaseExpiredClaims(120_000, now + 61_000)

    expect(released.map((entry) => entry.taskId)).toContain(task.id)
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('ready')
  })

  test('a fresh claim lease is not released', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    taskStore.claimTask('ws-1', task.id, 'agent-1', 60_000)

    const released = taskStore.releaseExpiredClaims(120_000, Date.now())

    expect(released).toEqual([])
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('claimed')
  })

  test('releaseTask clears the claim lease', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    const claimed = taskStore.claimTask('ws-1', task.id, 'agent-1', 60_000)!
    expect(claimed.claimExpiresAt).toBeDefined()

    taskStore.releaseTask('ws-1', task.id, 'released')

    expect(taskStore.getTask('ws-1', task.id)?.claimExpiresAt).toBeUndefined()
  })

  test('markTaskAssigned clears the claim window so slow deliveries stay assigned', () => {
    const task = taskStore.createTask('ws-1', { status: 'ready', title: 'T' })
    taskStore.claimTask('ws-1', task.id, 'agent-1', 30_000)
    taskStore.markTaskAssigned('ws-1', task.id)
    const now = Date.now()

    // Delivery is pending: neither the explicit lease nor the age heuristic
    // may requeue an assigned card — the watchdog owns stalled assignments.
    const released = taskStore.releaseExpiredClaims(120_000, now + 10 * 60_000)

    expect(released).toEqual([])
    const stored = taskStore.getTask('ws-1', task.id)
    expect(stored?.status).toBe('assigned')
    expect(stored?.claimExpiresAt).toBeUndefined()
    expect(stored?.claimedAt).toBeUndefined()
  })

  test('assigned cards without claim fields (team send) are not evicted by the heuristic', () => {
    const task = taskStore.createTask('ws-1', {
      status: 'assigned',
      title: 'T',
      assignedAgentId: 'agent-1',
    })
    const now = Date.now()

    const released = taskStore.releaseExpiredClaims(120_000, now + 10 * 60_000)

    expect(released).toEqual([])
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('assigned')
  })
})
