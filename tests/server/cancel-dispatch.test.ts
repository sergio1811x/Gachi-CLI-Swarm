import { describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

describe('cancel dispatch', () => {
  test('cancelTask closes an open dispatch and returns the worker to idle', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Front-end scan')

    const result = store.cancelTask(workspace.id, dispatch.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Direction changed',
    })

    expect(result.dispatch).toMatchObject({
      id: dispatch.id,
      reportText: 'Direction changed',
      status: 'cancelled',
    })
    expect(store.getWorker(workspace.id, worker.id)).toMatchObject({
      pendingTaskCount: 0,
      status: 'idle',
    })
  })

  test('re-poking a worker auto-closes the superseded dispatch; only one stays open', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const first = await store.dispatchTask(workspace.id, worker.id, 'Old task')
    const second = await store.dispatchTask(workspace.id, worker.id, 'New task')

    // The re-poke itself closes the superseded row (otherwise reconcile would
    // resurrect a phantom card from it), so there is exactly one open dispatch.
    expect(store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({
        id: first.id,
        reportText: expect.stringContaining(`superseded by dispatch ${second.id}`),
        status: 'cancelled',
      }),
      expect.objectContaining({ id: second.id, status: 'queued' }),
    ])

    // Cancelling an already-closed dispatch is an honest conflict...
    expect(() =>
      store.cancelTask(workspace.id, first.id, {
        fromAgentId: `${workspace.id}:orchestrator`,
        reason: 'Superseded',
      })
    ).toThrow(/No open dispatch/)

    // ...and cancelling the live one settles the worker cleanly.
    store.cancelTask(workspace.id, second.id, {
      fromAgentId: `${workspace.id}:orchestrator`,
      reason: 'Direction changed',
    })
    expect(store.getWorker(workspace.id, worker.id)).toMatchObject({
      pendingTaskCount: 0,
      status: 'idle',
    })
  })
})
