import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * Этап 3.2: `team tasks-cleanup --stale-hours` reports bound ready/assigned
 * cards whose assignee has no live run and whose updatedAt is older than the
 * cutoff. Dry-run (default) changes nothing; apply unbinds the card (sticky
 * affinity released) and journals [CLEANUP]; --delete removes the card.
 */

const tempDirs: string[] = []
const stores: Array<{ close: () => Promise<void> | void }> = []
const servers: Array<{ close: (cb?: () => void) => void }> = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((resolve) => {
      server?.close(() => resolve())
      setTimeout(resolve, 500).unref?.()
    })
  }
  for (const store of stores.splice(0)) {
    await store.close()
  }
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { force: true, recursive: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

interface Harness {
  store: ReturnType<typeof createRuntimeStore>
  workspaceId: string
  orchestratorId: string
  workerAId: string
  workerBId: string
  baseUrl: string
  auth: { project_id: string; from_agent_id: string; token: string }
}

const setup = async (dataDir: string): Promise<Harness> => {
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  const keepAlive = join(workspacePath, 'keep-alive.cjs')
  writeFileSync(keepAlive, 'setInterval(() => {}, 1 << 30)\n')
  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) throw new Error('Expected default orchestrator')

  // A child that never reads stdin survives headless consoles, so the auth
  // token minted at run start stays valid for the whole test.
  store.configureAgentLaunch(workspace.id, orchestrator.id, {
    command: process.execPath,
    args: [keepAlive],
  })
  await store.startAgent(workspace.id, orchestrator.id, { gachiPort: '4010' })

  const workerA = store.addWorker(workspace.id, { name: 'Sleepy', role: 'coder' })
  const workerB = store.addWorker(workspace.id, { name: 'Busy', role: 'coder' })

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  return {
    store,
    workspaceId: workspace.id,
    orchestratorId: orchestrator.id,
    workerAId: workerA.id,
    workerBId: workerB.id,
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token: store.peekAgentToken(orchestrator.id) ?? '',
    },
  }
}

const ageCard = (taskId: string, hoursAgo: number) => {
  const task = taskStore.getTaskById(taskId)
  if (!task) throw new Error(`missing card ${taskId}`)
  task.updatedAt = Date.now() - hoursAgo * 3_600_000
}

const cleanup = async (
  baseUrl: string,
  auth: Record<string, unknown>
): Promise<{
  status: number
  json: {
    ok?: boolean
    matched?: number
    dry_run?: boolean
    delete?: boolean
    error?: string
    tasks?: Array<{
      id: string
      status: string
      assigned_agent_id: string | null
    }>
  }
}> => {
  const response = await fetch(`${baseUrl}/api/team/tasks/cleanup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(auth),
  })
  return { status: response.status, json: await response.json() }
}

describe('team tasks-cleanup (Этап 3.2)', () => {
  test('dry-run only reports; apply unbinds and journals; delete removes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-tasks-cleanup-'))
    tempDirs.push(dataDir)
    const harness = await setup(dataDir)
    const { workspaceId, workerAId, workerBId } = harness

    const staleReadyBound = taskStore.createTask(workspaceId, {
      title: 'Stale ready bound',
      description: 'stuck with a dead assignee',
      status: 'ready',
      assignedAgentId: workerAId,
    })
    const staleAssigned = taskStore.createTask(workspaceId, {
      title: 'Stale assigned',
      description: 'never dispatched',
      status: 'assigned',
      assignedAgentId: workerAId,
    })
    const freshReadyBound = taskStore.createTask(workspaceId, {
      title: 'Fresh ready bound',
      description: 'still young',
      status: 'ready',
      assignedAgentId: workerBId,
    })
    const staleUnbound = taskStore.createTask(workspaceId, {
      title: 'Stale unbound',
      description: 'no assignee — dispatchable',
      status: 'ready',
    })
    const staleReview = taskStore.createTask(workspaceId, {
      title: 'Stale review',
      description: 'not a cleanup target',
      status: 'review',
      assignedAgentId: workerAId,
    })
    for (const taskId of [staleReadyBound.id, staleAssigned.id, staleUnbound.id, staleReview.id]) {
      ageCard(taskId, 5)
    }

    // Dry-run: reports both stale bound cards, changes nothing.
    const dry = await cleanup(harness.baseUrl, {
      ...harness.auth,
      stale_hours: 2,
      dry_run: true,
    })
    expect(dry.status).toBe(200)
    expect(dry.json.ok).toBe(true)
    expect(dry.json.dry_run).toBe(true)
    expect(dry.json.matched).toBe(2)
    expect((dry.json.tasks ?? []).map((task) => task.id).sort()).toEqual(
      [staleReadyBound.id, staleAssigned.id].sort()
    )
    expect(taskStore.getTask(workspaceId, staleReadyBound.id)?.assignedAgentId).toBe(workerAId)
    expect(taskStore.getTask(workspaceId, staleAssigned.id)?.assignedAgentId).toBe(workerAId)

    // Apply: unbinds the stale pair, keeps statuses, journals the action.
    const apply = await cleanup(harness.baseUrl, {
      ...harness.auth,
      stale_hours: 2,
      dry_run: false,
    })
    expect(apply.status).toBe(200)
    expect(apply.json.dry_run).toBe(false)
    expect(apply.json.delete).toBe(false)
    expect(apply.json.matched).toBe(2)

    const unboundReady = taskStore.getTask(workspaceId, staleReadyBound.id)
    expect(unboundReady?.assignedAgentId).toBeUndefined()
    expect(unboundReady?.status).toBe('ready')
    expect((unboundReady?.logs ?? []).some((line) => line.includes('[CLEANUP]'))).toBe(true)

    const unboundAssigned = taskStore.getTask(workspaceId, staleAssigned.id)
    expect(unboundAssigned?.assignedAgentId).toBeUndefined()
    expect(unboundAssigned?.status).toBe('assigned')

    // Untouched: fresh bound card, unbound card, review card.
    expect(taskStore.getTask(workspaceId, freshReadyBound.id)?.assignedAgentId).toBe(workerBId)
    expect(taskStore.getTask(workspaceId, staleUnbound.id)?.assignedAgentId).toBeUndefined()
    expect(taskStore.getTask(workspaceId, staleReview.id)?.assignedAgentId).toBe(workerAId)

    // Delete mode: re-seed a stale bound card (the pair above is unbound now,
    // and unbound cards are not cleanup targets) and wipe it.
    const deletable = taskStore.createTask(workspaceId, {
      title: 'Deletable stale',
      description: 'bound and old',
      status: 'ready',
      assignedAgentId: workerBId,
    })
    ageCard(deletable.id, 10)
    const wipe = await cleanup(harness.baseUrl, {
      ...harness.auth,
      stale_hours: 2,
      dry_run: false,
      delete: true,
    })
    expect(wipe.status).toBe(200)
    expect(wipe.json.delete).toBe(true)
    expect(wipe.json.matched).toBe(1)
    expect(taskStore.getTask(workspaceId, deletable.id)).toBeUndefined()
  })

  test('rejects missing/invalid stale_hours; auth still enforced', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-tasks-cleanup-neg-'))
    tempDirs.push(dataDir)
    const harness = await setup(dataDir)

    const missing = await cleanup(harness.baseUrl, { ...harness.auth })
    expect(missing.status).toBe(400)

    const negative = await cleanup(harness.baseUrl, { ...harness.auth, stale_hours: -3 })
    expect(negative.status).toBe(400)

    const wrongToken = await cleanup(harness.baseUrl, {
      ...harness.auth,
      token: 'nope',
      stale_hours: 2,
    })
    expect(wrongToken.status).toBe(401)
  })
})
