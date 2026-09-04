import { describe, expect, test } from 'vitest'

import { planNextDispatch } from '../../src/server/queue-engine.js'

const agents = [
  {
    description: 'typescript, react',
    id: 'ws-1:worker-1',
    name: 'Alice',
    pendingTaskCount: 0,
    role: 'coder',
    status: 'idle',
    workspaceId: 'ws-1',
  },
  {
    description: 'rust, api',
    id: 'ws-1:worker-2',
    name: 'Bob',
    pendingTaskCount: 0,
    role: 'backend',
    status: 'idle',
    workspaceId: 'ws-1',
  },
]

const task = (overrides: Partial<Parameters<typeof planNextDispatch>[1][number]> = {}) => ({
  id: 't1',
  status: 'ready',
  priority: 'normal',
  description: 'do the thing',
  title: 'Task',
  requiredSkills: [],
  ...overrides,
})

const deps = {
  canStartWorker: () => true,
  getAgents: () => agents,
}

describe('queue engine', () => {
  test('returns candidates for ready tasks ordered by priority', () => {
    const result = planNextDispatch(
      'ws-1',
      [
        task({ id: 'low', priority: 'low', assignedAgentId: 'ws-1:worker-2' }),
        task({ id: 'crit', priority: 'critical', assignedAgentId: 'ws-1:worker-1' }),
      ],
      deps
    )
    expect(result.map((c) => c.taskId)).toEqual(['crit', 'low'])
  })

  test('ignores non-ready tasks', () => {
    const result = planNextDispatch('ws-1', [task({ status: 'assigned' })], deps)
    expect(result).toEqual([])
  })

  test('routes a pre-assigned task to its worker without re-selecting', () => {
    const result = planNextDispatch(
      'ws-1',
      [task({ id: 'pre', assignedAgentId: 'ws-1:worker-2' })],
      deps
    )
    expect(result).toEqual([{ taskId: 'pre', workerId: 'ws-1:worker-2' }])
  })

  test('leaves a task ready when its selected worker is busy', () => {
    const result = planNextDispatch('ws-1', [task({ id: 'a', assignedAgentId: 'ws-1:worker-1' })], {
      ...deps,
      isWorkerActive: (_ws, workerId) => workerId === 'ws-1:worker-1',
    })
    // The preferred worker owns a live process, so the task stays for a later tick.
    expect(result).toEqual([])
  })

  test('never claims the same worker twice in one tick', () => {
    const result = planNextDispatch(
      'ws-1',
      [
        task({ id: 'a', assignedAgentId: 'ws-1:worker-1' }),
        task({ id: 'b', assignedAgentId: 'ws-1:worker-1' }),
      ],
      deps
    )
    expect(result).toEqual([{ taskId: 'a', workerId: 'ws-1:worker-1' }])
  })

  test('stops auto-selection when the pool has no capacity', () => {
    const result = planNextDispatch('ws-1', [task({ id: 'a' })], {
      ...deps,
      maxConcurrentWorkers: 0,
    })
    expect(result).toEqual([])
  })

  test('does not hand a new task to a worker holding an in-flight running task', () => {
    // Worker-1 already owns a `running` task whose process may be gone, but the
    // task is not settled yet. It must not receive the new `ready` task.
    const result = planNextDispatch(
      'ws-1',
      [
        { ...task({ id: 'new' }), assignedAgentId: 'ws-1:worker-1' },
        { ...task({ id: 'inflight' }), status: 'running', assignedAgentId: 'ws-1:worker-1' },
      ],
      deps
    )
    expect(result).toEqual([])
  })

  test('a worker is free again once its task moved to review', () => {
    const result = planNextDispatch(
      'ws-1',
      [
        { ...task({ id: 'new' }), assignedAgentId: 'ws-1:worker-1' },
        { ...task({ id: 'reviewed' }), status: 'review', assignedAgentId: 'ws-1:worker-1' },
      ],
      deps
    )
    expect(result).toEqual([{ taskId: 'new', workerId: 'ws-1:worker-1' }])
  })

  test('skips a worker with an in-flight task during auto-selection', () => {
    const result = planNextDispatch(
      'ws-1',
      [
        task({ id: 'a' }),
        { ...task({ id: 'running' }), status: 'running', assignedAgentId: 'ws-1:worker-1' },
      ],
      deps
    )
    expect(result).toEqual([{ taskId: 'a', workerId: 'ws-1:worker-2' }])
  })
})
