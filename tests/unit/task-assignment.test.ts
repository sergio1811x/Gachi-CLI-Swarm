import { describe, expect, test } from 'vitest'

import { selectWorkerForTask } from '../../src/server/task-assignment.js'
import type { TaskRecord } from '../../src/server/task-store.js'

const task: TaskRecord = {
  artifacts: [],
  comments: [],
  createdAt: 1,
  dependencies: [],
  description: '',
  id: 'task-1',
  logs: [],
  priority: 'normal',
  requiredSkills: ['react'],
  reviewRequired: true,
  role: 'coder',
  status: 'ready',
  title: 'Frontend',
  updatedAt: 1,
  workspaceId: 'ws-1',
}

describe('task assignment', () => {
  test('prefers an available role and skill match over a busy generic worker', () => {
    const selected = selectWorkerForTask(task, [
      {
        description: 'React TypeScript specialist',
        id: 'frontend',
        name: 'Frontend',
        pendingTaskCount: 0,
        role: 'coder',
        status: 'idle',
        workspaceId: 'ws-1',
      },
      {
        description: 'General developer',
        id: 'busy',
        name: 'Busy',
        pendingTaskCount: 3,
        role: 'coder',
        status: 'working',
        workspaceId: 'ws-1',
      },
    ])

    expect(selected?.id).toBe('frontend')
  })

  test('never selects a stopped worker without a launch config, or an orchestrator', () => {
    expect(
      selectWorkerForTask(task, [
        {
          description: 'React',
          id: 'stopped',
          name: 'Stopped',
          pendingTaskCount: 0,
          role: 'coder',
          status: 'stopped',
          workspaceId: 'ws-1',
        },
        {
          description: 'React',
          id: 'orchestrator',
          name: 'Queen',
          pendingTaskCount: 0,
          role: 'orchestrator',
          status: 'idle',
          workspaceId: 'ws-1',
        },
      ])
    ).toBeUndefined()
  })

  test('selects a freed stopped worker when it can be started again', () => {
    const selected = selectWorkerForTask(
      task,
      [
        {
          description: 'React',
          id: 'stopped',
          name: 'Stopped',
          pendingTaskCount: 0,
          role: 'coder',
          status: 'stopped',
          workspaceId: 'ws-1',
        },
      ],
      (agentId) => agentId === 'stopped'
    )

    expect(selected?.id).toBe('stopped')
  })

  test('never selects an orchestrator even when it is startable', () => {
    expect(
      selectWorkerForTask(
        task,
        [
          {
            description: 'React',
            id: 'orchestrator',
            name: 'Queen',
            pendingTaskCount: 0,
            role: 'orchestrator',
            status: 'stopped',
            workspaceId: 'ws-1',
          },
        ],
        () => true
      )
    ).toBeUndefined()
  })

  test('does not assign a task to a worker missing any required skill', () => {
    expect(
      selectWorkerForTask(task, [
        {
          description: 'Python specialist',
          id: 'python-worker',
          name: 'Python',
          pendingTaskCount: 0,
          role: 'coder',
          status: 'idle',
          workspaceId: 'ws-1',
        },
      ])
    ).toBeUndefined()
  })
})
