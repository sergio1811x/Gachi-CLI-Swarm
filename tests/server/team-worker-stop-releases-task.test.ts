import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * B1 regression: `team worker stop` used to only kill the PTY run and leave the
 * bound task hanging in running/ready forever (the "ghost" bug). It must release
 * the in-flight dispatch so the card returns to READY and can be re-dispatched.
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

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-stop-'))
  tempDirs.push(dataDir)
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  // Passive script so the orchestrator PTY stays alive (a live run mints the
  // CLI token the routes authenticate against).
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
  // `team send` spawns a stopped worker on dispatch (ensureWorkerRun), which
  // needs the launch config the real flow always has.
  store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [workerScript],
  })
  return { store, workspace, orchestrator, worker }
}

const startServer = async (store: ReturnType<typeof createRuntimeStore>) => {
  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const postStop = async (baseUrl: string, body: Record<string, unknown>) => {
  return fetch(`${baseUrl}/api/team/worker/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('team worker stop releases the bound task (B1)', () => {
  test('stopping a busy worker returns its in-flight task to READY instead of ghosting it', async () => {
    const { store, workspace, orchestrator, worker } = await setup()

    // The exact state that used to hang: a card claimed by the worker PTY.
    const card = taskStore.createTask(workspace.id, {
      title: 'Ship the login flow',
      description: 'in-flight when the worker was stopped',
      status: 'running',
      assignedAgentId: worker.id,
    })

    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const response = await postStop(baseUrl, {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      name: worker.name,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; releasedTask: string | null }
    expect(body.ok).toBe(true)
    expect(body.releasedTask).toBe(card.id)

    const after = taskStore.getTask(workspace.id, card.id)
    expect(after?.status).toBe('ready')
    // Sticky binding is kept so the recovery watchdog can re-dispatch on restart.
    expect(after?.assignedAgentId).toBe(worker.id)
  })

  test('stopping a worker with no in-flight task reports no released task', async () => {
    const { store, workspace, orchestrator, worker } = await setup()
    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const response = await postStop(baseUrl, {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      name: worker.name,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; releasedTask: string | null }
    expect(body.ok).toBe(true)
    expect(body.releasedTask).toBeNull()
    expect(taskStore.listTasks(workspace.id)).toHaveLength(0)
  })

  test('cancel_task cancels the stuck card and unblocks a follow-up team send', async () => {
    const { store, workspace, orchestrator, worker } = await setup()
    const card = taskStore.createTask(workspace.id, {
      title: 'Generate episode images',
      description: 'worker silently hung on this for hours',
      status: 'running',
      assignedAgentId: worker.id,
    })

    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const stopResponse = await postStop(baseUrl, {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      name: worker.name,
      cancel_task: true,
    })
    expect(stopResponse.status).toBe(200)
    const stopBody = (await stopResponse.json()) as {
      canceledTask: string | null
      releasedTask: string | null
    }
    expect(stopBody.canceledTask).toBe(card.id)
    expect(stopBody.releasedTask).toBeNull()
    expect(taskStore.getTask(workspace.id, card.id)?.status).toBe('canceled')

    // The regression this covers: after a plain stop the dispatcher resurrects
    // the released card before the send lands, and the send 409s. With the
    // card canceled there is nothing to resurrect.
    const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token,
        to: worker.name,
        text: 'fresh delta work after the unblock',
      }),
    })
    expect(sendResponse.status).toBe(202)
    const sendBody = (await sendResponse.json()) as { dispatch_id: string; ok: boolean }
    expect(sendBody.ok).toBe(true)
    expect(sendBody.dispatch_id).toBeTruthy()
  })
})
