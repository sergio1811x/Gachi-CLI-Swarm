import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { dispatchReadyKanbanTasks } from '../../src/server/kanban-dispatcher.js'
import { planNextDispatch } from '../../src/server/queue-engine.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import type { AgentSummary } from '../../src/shared/types.js'

/**
 * Sticky task affinity: when a worker's run exits (crash, manual stop, engine
 * switch), the released card must stay bound to ITS worker — the dispatcher
 * hands a pre-bound ready card only to that worker, never to a random free one.
 */

const tempDirs: string[] = []
const stores: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const setup = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-task-affinity-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const store = createRuntimeStore({ dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Affinity')
  return { store, workspaceId: workspace.id }
}

const agent = (id: string, overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  description: 'coder typescript',
  id,
  name: id.split(':').pop() ?? id,
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

describe('sticky task affinity', () => {
  test('releaseTask keeps the assigned worker instead of unbinding', () => {
    const ctx = setup()
    const worker = ctx.store.addWorker(ctx.workspaceId, { name: 'Alice', role: 'coder' })

    let dispatch: { id: string } | undefined
    void ctx.store.dispatchTask(ctx.workspaceId, worker.id, 'do the thing').then((result) => {
      dispatch = result
    })
    // dispatchTask is async; run synchronously via taskStore assertions after.
    const card = taskStore.listTasks(ctx.workspaceId).at(-1)
    if (!card) throw new Error('expected a dispatched card')
    void dispatch

    taskStore.releaseTask(ctx.workspaceId, card.id, 'worker exited (crash)')

    const released = taskStore.getTask(ctx.workspaceId, card.id)
    expect(released?.status).toBe('ready')
    // THE contract: the binding survives the release.
    expect(released?.assignedAgentId).toBe(worker.id)
  })

  test('the released card goes only to its bound worker — even if stopped', () => {
    const tasks = [
      {
        assignedAgentId: 'ws-1:alice',
        description: 'x',
        id: 't1',
        priority: 'normal',
        requiredSkills: [] as string[],
        status: 'ready',
        title: 'bound card',
      },
    ]
    const agents = [agent('ws-1:alice', { status: 'stopped' }), agent('ws-1:bob')]

    const candidates = planNextDispatch('ws-1', tasks as never, {
      canStartWorker: () => true,
      getAgents: () => agents,
    })

    // Alice is stoppable-but-startable: she gets HER card back (ensureWorkerRun
    // revives her); Bob must never receive it.
    expect(candidates).toEqual([{ taskId: 't1', workerId: 'ws-1:alice' }])
  })

  test('if the bound worker cannot start, the card waits instead of jumping', () => {
    const tasks = [
      {
        assignedAgentId: 'ws-1:alice',
        description: 'x',
        id: 't1',
        priority: 'critical',
        requiredSkills: [] as string[],
        status: 'ready',
        title: 'bound card',
      },
    ]
    const agents = [agent('ws-1:bob'), agent('ws-1:carol')]

    const candidates = planNextDispatch('ws-1', tasks as never, {
      // Alice has no launch config anymore — nobody else may take her card.
      canStartWorker: () => false,
      getAgents: () => agents,
    })

    expect(candidates).toEqual([])
  })

  test('deleting a worker clears the affinity of its non-terminal cards', async () => {
    const ctx = setup()
    const worker = ctx.store.addWorker(ctx.workspaceId, { name: 'Bob', role: 'coder' })
    await ctx.store.dispatchTask(ctx.workspaceId, worker.id, 'orphan me')
    const card = taskStore.listTasks(ctx.workspaceId).find((t) => t.assignedAgentId === worker.id)
    if (!card) throw new Error('expected a bound card')

    taskStore.releaseTask(ctx.workspaceId, card.id, 'run exited')
    ctx.store.deleteWorker(ctx.workspaceId, worker.id)

    const after = taskStore.getTask(ctx.workspaceId, card.id)
    expect(after?.assignedAgentId).toBeUndefined()
    expect(after?.status).toBe('ready')
  })

  test('the dispatcher heals a ready card still bound to a deleted worker', async () => {
    const ctx = setup()
    const alice = ctx.store.addWorker(ctx.workspaceId, { name: 'Alice', role: 'coder' })
    // Legacy orphan: released AFTER its worker was deleted (pre-fix data), so
    // it sits in `ready` bound to a worker id that no longer exists.
    const orphan = taskStore.createTask(ctx.workspaceId, {
      assignedAgentId: `${ctx.workspaceId}:ghost`,
      description: 'stuck since the worker was deleted',
      status: 'ready',
      title: 'orphaned card',
    })

    const sentTo: string[] = []
    await dispatchReadyKanbanTasks(ctx.workspaceId, {
      canStartWorker: (_workspaceId, workerId) => workerId === alice.id,
      dispatch: async (_workspaceId, workerId) => {
        sentTo.push(workerId)
      },
      getAgents: () => [agent(alice.id)],
    })

    // The stale binding is dropped and the card finally dispatches again —
    // claimed by the live worker, never by the ghost.
    const healed = taskStore.getTask(ctx.workspaceId, orphan.id)
    expect(healed?.assignedAgentId).toBe(alice.id)
    expect(sentTo).toEqual([alice.id])
  })
})
