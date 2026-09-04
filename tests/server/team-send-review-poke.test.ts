import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * Regression (owner report, 2026-08-26): `team send` 500ed with
 * "Invalid task transition: review -> assigned" for any worker whose previous
 * run settled its bound card into `review` (e.g. the worker exits cleanly
 * after a failing auto-report). The poke path in `dispatchTask` reopens
 * `review` → `assigned`; the state machine must allow exactly that edge.
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
  // Windows: sqlite handle release can lag one tick behind close().
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

describe('team send pokes a review-bound card back to assigned', () => {
  test('second send to a review-stuck worker succeeds instead of 500', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-send-review-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    // Passive script so the worker PTY stays alive and accepts delivery.
    const workerScript = join(workspacePath, 'passive-worker.cjs')
    writeFileSync(workerScript, 'process.stdin.resume();\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, orchestrator.id, { gachiPort: '4010' })

    const worker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    // Simulate the poisoned state: a bound card left in `review` by a clean
    // exit (failing auto-report), still assigned to this very worker.
    taskStore.createTask(workspace.id, {
      title: 'Stuck in review',
      description: 'earlier attempt',
      status: 'review',
      assignedAgentId: worker.id,
    })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const token = store.peekAgentToken(orchestrator.id)

    const response = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token,
        to: 'Montage',
        text: 'follow-up work after review',
      }),
    })
    // 202 Accepted: the send is queued for PTY delivery.
    expect(response.status).toBe(202)

    // The SAME card was poked (reopened review→assigned), not duplicated,
    // and the delivered prompt advanced it to running.
    const cards = taskStore
      .listTasks(workspace.id)
      .filter((task) => task.title === 'Stuck in review')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.status).toBe('running')
    expect(cards[0]?.description).toContain('follow-up work after review')
  })

  test('reports dispatch_paused and a warning while the error budget holds the workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-send-paused-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    // The worker must survive deliveries here: an exiting worker would trip
    // the error budget and pause the workspace on its own, poisoning the flag
    // this test is trying to control.
    const workerScript = join(workspacePath, 'immortal-worker.cjs')
    writeFileSync(workerScript, 'process.stdin.resume(); setInterval(() => {}, 2147483647);\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, orchestrator.id, { gachiPort: '4010' })

    const worker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const token = store.peekAgentToken(orchestrator.id)
    const send = () =>
      fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestrator.id,
          token,
          to: 'Montage',
          text: 'work while paused',
        }),
      })

    const clear = await send()
    expect(clear.status, await clear.text()).toBe(202)

    // Free the worker: a second send while the first card is still `running`
    // would hit the snowball guard (409) instead of the pause logic.
    for (const task of taskStore.listTasks(workspace.id)) {
      taskStore.deleteTask(workspace.id, task.id)
    }

    store.settings.setAppState(`dispatch_paused_${workspace.id}`, '1')
    const paused = await send()
    const pausedBody = (await paused.json()) as { dispatch_paused?: boolean; warning?: string }
    expect(paused.status).toBe(202)
    expect(pausedBody).toMatchObject({
      dispatch_paused: true,
      warning: expect.stringContaining('dispatch is paused'),
    })
  })
})
