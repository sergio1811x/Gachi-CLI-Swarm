import { beforeEach, describe, expect, test } from 'vitest'
import {
  REAP_DEAD_RUNNING_TASK_AFTER_MS,
  reapDeadRunningTasks,
  type TaskReaperPort,
} from '../../src/server/task-reaper.js'
import { TaskStore } from '../../src/server/task-store.js'

describe('reapDeadRunningTasks', () => {
  let store: TaskStore
  let activeRunIds: string[]
  let heartbeatLastSeen: number | null

  beforeEach(() => {
    store = new TaskStore()
    activeRunIds = []
    heartbeatLastSeen = null
  })

  const createPort = (now = 1_000_000): TaskReaperPort => ({
    getActiveRunByAgentId: (_ws, agentId) =>
      activeRunIds.includes(agentId) ? { runId: `run-${agentId}` } : undefined,
    getHeartbeat: () => (heartbeatLastSeen === null ? undefined : { lastSeen: heartbeatLastSeen }),
    isHeartbeatStale: (_ws, _agentId, maxAgeMs, at) =>
      heartbeatLastSeen !== null && at - heartbeatLastSeen > maxAgeMs,
    listTasks: (wsId) => store.listTasks(wsId),
    now: () => now,
    releaseTask: (wsId, taskId, reason) => {
      store.releaseTask(wsId, taskId, reason)
    },
  })

  const makeRunningTask = (agentId: string) => {
    const task = store.createTask('ws-1', {
      assignedAgentId: agentId,
      status: 'running',
      title: `Task for ${agentId}`,
    })
    return task
  }

  test('reaps a running task whose owner has no live process and a stale heartbeat', () => {
    const task = makeRunningTask('ws-1:worker-1')
    // Owner has no live process; heartbeat is stale (last seen 5 minutes ago).
    heartbeatLastSeen = 1_000_000 - REAP_DEAD_RUNNING_TASK_AFTER_MS - 60_000

    const reaped = reapDeadRunningTasks('ws-1', createPort())

    expect(reaped).toBe(1)
    expect(store.getTask('ws-1', task.id)?.status).toBe('ready')
  })

  test('does not reap a running task whose owner still has a live process', () => {
    const task = makeRunningTask('ws-1:worker-1')
    activeRunIds = ['ws-1:worker-1']

    const reaped = reapDeadRunningTasks('ws-1', createPort())

    expect(reaped).toBe(0)
    expect(store.getTask('ws-1', task.id)?.status).toBe('running')
  })

  test('does not reap a running task with a fresh heartbeat (process just exited)', () => {
    const task = makeRunningTask('ws-1:worker-1')
    heartbeatLastSeen = 1_000_000 // fresh

    const reaped = reapDeadRunningTasks('ws-1', createPort())

    expect(reaped).toBe(0)
    expect(store.getTask('ws-1', task.id)?.status).toBe('running')
  })

  test('leaves non-running and claimed tasks alone', () => {
    const ready = store.createTask('ws-1', { status: 'ready', title: 'ready task' })
    const assigned = store.createTask('ws-1', {
      assignedAgentId: 'ws-1:worker-2',
      status: 'assigned',
      title: 'assigned task',
    })
    store.claimTask('ws-1', ready.id, 'ws-1:worker-3')

    const reaped = reapDeadRunningTasks('ws-1', createPort())

    expect(reaped).toBe(0)
    expect(store.getTask('ws-1', assigned.id)?.status).toBe('assigned')
    expect(store.getTask('ws-1', ready.id)?.status).toBe('claimed')
  })
})
