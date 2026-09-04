import { beforeEach, describe, expect, test, vi } from 'vitest'

import { dispatchReadyKanbanTasks } from '../../src/server/kanban-dispatcher.js'
import { taskStore } from '../../src/server/task-store.js'

describe('kanban dispatcher', () => {
  beforeEach(() => taskStore.clear())

  test('assigns and dispatches only ready unblocked cards', async () => {
    const task = taskStore.createTask('ws-1', { title: 'API' })
    taskStore.updateTask('ws-1', task.id, { status: 'ready' })
    const dispatch = vi.fn(async () => undefined)

    await expect(
      dispatchReadyKanbanTasks('ws-1', {
        canStartWorker: () => true,
        dispatch,
        getAgents: () => [
          {
            description: 'typescript',
            id: 'worker-1',
            name: 'Worker',
            pendingTaskCount: 0,
            role: 'coder',
            status: 'idle',
            workspaceId: 'ws-1',
          },
        ],
      })
    ).resolves.toEqual([task.id])
    expect(dispatch).toHaveBeenCalledWith('ws-1', 'worker-1', 'API')
    expect(taskStore.getTask('ws-1', task.id)).toMatchObject({
      assignedAgentId: 'worker-1',
      status: 'assigned',
    })
  })

  test('paused workspace dispatches nothing and claims nothing (R10)', async () => {
    const task = taskStore.createTask('ws-paused', { title: 'Blocked by budget' })
    taskStore.updateTask('ws-paused', task.id, { status: 'ready' })
    const dispatch = vi.fn(async () => undefined)

    await expect(
      dispatchReadyKanbanTasks('ws-paused', {
        canStartWorker: () => true,
        dispatch,
        getAgents: () => [],
        isDispatchPaused: () => true,
      })
    ).resolves.toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    // The card stays untouched in `ready` for when the human resumes.
    expect(taskStore.getTask('ws-paused', task.id)).toMatchObject({ status: 'ready' })
  })
})
