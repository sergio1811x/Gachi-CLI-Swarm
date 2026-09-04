import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * Regression coverage for dispatch-ledger resurrection bugs:
 *
 * 1. Deleting a card whose last dispatch was already `reported` used to leave
 *    that row open in the ledger, so reconcile rebuilt the card as a zombie
 *    review entry on the next board read.
 * 2. Re-poking a busy worker used to re-stamp the card's dispatchId while
 *    leaving the previous open row in the ledger — every poke leaked one
 *    phantom card waiting to be resurrected.
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
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-card-lifecycle-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)
  const store = createRuntimeStore({ dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Lifecycle')
  const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  return { dataDir, store, worker, workspaceId: workspace.id }
}

/** Rewrites a ledger row's addressee, simulating a row that outlived its worker. */
const reassignDispatchTo = (dataDir: string, dispatchId: string, toAgentId: string): void => {
  const db = new BetterSqlite3(join(dataDir, 'runtime.sqlite'))
  try {
    db.prepare('UPDATE dispatches SET to_agent_id = ? WHERE id = ?').run(toAgentId, dispatchId)
  } finally {
    db.close()
  }
}

describe('task card deletion vs ledger reconciliation', () => {
  test('deleting a review card with a reported dispatch does not resurrect it', async () => {
    const ctx = setup()
    const orchestratorId = `${ctx.workspaceId}:orchestrator`

    // Dispatch → report: the ledger row becomes `reported`, the card sits in review.
    const dispatch = await ctx.store.dispatchTask(
      ctx.workspaceId,
      ctx.worker.id,
      'Fix the flaky dispatcher test'
    )
    ctx.store.reportTask(ctx.workspaceId, ctx.worker.id, {
      dispatchId: dispatch.id,
      text: 'done, all green',
    })

    const before = taskStore.listTasks(ctx.workspaceId)
    const card = before.find((task) => task.dispatchId === dispatch.id)
    expect(card).toBeDefined()
    expect(card?.status).toBe('review')

    // Delete through the same team-ops path the UI uses.
    expect(
      ctx.store.deleteTaskCard(ctx.workspaceId, card?.id ?? '', {
        fromAgentId: orchestratorId,
        reason: 'deleted from Kanban board',
      })
    ).toBe(true)

    // Reconcile runs on every board fetch — it must NOT rebuild the card.
    const restored = ctx.store.reconcileTasksFromDispatches(ctx.workspaceId)
    expect(restored).toBe(0)
    expect(taskStore.getTask(ctx.workspaceId, card?.id ?? '')).toBeUndefined()
  })

  test('re-poking a worker closes the superseded dispatch instead of leaking it', async () => {
    const ctx = setup()

    const first = await ctx.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'first instruction')
    const second = await ctx.store.dispatchTask(
      ctx.workspaceId,
      ctx.worker.id,
      'follow-up instruction'
    )
    expect(second.id).not.toBe(first.id)

    const cards = taskStore.listTasks(ctx.workspaceId)
    expect(cards.filter((task) => task.description.includes('first instruction'))).toHaveLength(1)

    // The old dispatch must be closed so reconcile cannot resurrect a phantom.
    const restored = ctx.store.reconcileTasksFromDispatches(ctx.workspaceId)
    expect(restored).toBe(0)
  })

  test('re-poking after a report force-closes the reported row, so no review phantom returns', async () => {
    const ctx = setup()

    const first = await ctx.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'first instruction')
    ctx.store.reportTask(ctx.workspaceId, ctx.worker.id, {
      dispatchId: first.id,
      text: 'work done',
    })
    // The poke re-stamps the card onto the second dispatch; the first row is
    // already `reported` — a plain cancel cannot touch it.
    await ctx.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'follow-up instruction')

    const restored = ctx.store.reconcileTasksFromDispatches(ctx.workspaceId)
    expect(restored).toBe(0)
    const cards = taskStore.listTasks(ctx.workspaceId)
    expect(cards.filter((task) => task.description.includes('first instruction'))).toHaveLength(1)
  })

  test('reconcile skips ledger rows whose worker no longer exists', async () => {
    const ctx = setup()
    const secondWorker = ctx.store.addWorker(ctx.workspaceId, { name: 'Bob', role: 'coder' })

    const ghostRow = await ctx.store.dispatchTask(ctx.workspaceId, secondWorker.id, 'ghost work')
    const liveRow = await ctx.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'live work')

    // Rewrite the row onto a worker id that does not exist — simulating
    // legacy data where a dispatch row outlived its worker (deleteWorker
    // purges its dispatches, so this state only arises from older databases).
    const ghostAgentId = `${ctx.workspaceId}:ghost`
    reassignDispatchTo(ctx.dataDir, ghostRow.id, ghostAgentId)

    // Drop BOTH cards WITHOUT ledger cleanup so their rows are genuinely
    // orphaned: reconcile must skip the ghost row and restore the live one.
    for (const row of [ghostRow, liveRow]) {
      const card = taskStore.getTaskByDispatchId(ctx.workspaceId, row.id)
      if (!card) throw new Error(`expected a card for dispatch ${row.id}`)
      expect(taskStore.deleteTask(ctx.workspaceId, card.id)).toBe(true)
    }

    const restored = ctx.store.reconcileTasksFromDispatches(ctx.workspaceId)
    expect(restored).toBe(1)
    expect(taskStore.getTaskByDispatchId(ctx.workspaceId, ghostRow.id)).toBeUndefined()
    expect(taskStore.getTaskByDispatchId(ctx.workspaceId, liveRow.id)).toBeDefined()
  })
})
