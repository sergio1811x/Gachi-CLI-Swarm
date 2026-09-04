import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * B7 regression: `team send Theme Scout A "fix it"` is split by the shell into
 * `to: 'Theme'` + text `Scout A fix it`. The exact-name lookup failed and the
 * dispatch was silently mis-addressed. The server must re-join the split name.
 * `team worker add` without a preset must also fail autostart with an
 * actionable hint instead of "Agent launch config not found: <id>".
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
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-multiname-'))
  tempDirs.push(dataDir)
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
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
  return { store, workspace, orchestrator, workerScript }
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

const post = async (baseUrl: string, path: string, body: Record<string, unknown>) => {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('team send split worker-name healing (B7)', () => {
  test('send addressed to the first word of a multi-word name dispatches the remaining text', async () => {
    const { store, workspace, orchestrator, workerScript } = await setup()
    const worker = store.addWorker(workspace.id, { name: 'Theme Scout A', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    // Exactly what the shell produces for an unquoted multi-word name.
    const response = await post(baseUrl, '/api/team/send', {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      to: 'Theme',
      text: 'Scout A fix the login flow',
    })
    expect(response.status).toBe(202)

    const cards = taskStore.listTasks(workspace.id)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.assignedAgentId).toBe(worker.id)
    expect(cards[0]?.description).toContain('fix the login flow')
    expect(cards[0]?.description).not.toContain('Scout A fix')
  })

  test('worker add without a preset reports an actionable autostart failure', async () => {
    const { store, workspace, orchestrator } = await setup()
    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const response = await post(baseUrl, '/api/team/worker/add', {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      name: 'Boshy',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      ok: boolean
      started: { ok: boolean; error: string | null }
    }
    expect(body.ok).toBe(true)
    expect(body.started.ok).toBe(false)
    expect(body.started.error).toContain('--preset')
  })
})
