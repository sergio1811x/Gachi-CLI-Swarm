import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * `team worker add` must be a one-command path: `--preset <id>` resolves the
 * builtin launch config (command + args) BEFORE the worker is created, so a
 * typo fails with a typed 400 and a known id leaves a startable worker.
 * `team worker start` on a worker without any launch config must answer with
 * the actionable hint (400), not the opaque "Agent launch config not found"
 * 500 the old path produced.
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
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-add-preset-'))
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

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  const token = store.peekAgentToken(orchestrator.id) ?? ''
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token,
        ...body,
      }),
    })
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  }

  return { store, workspace, post, workerScript }
}

describe('team worker add --preset (one-command worker creation)', () => {
  test('unknown preset fails with 400 and known ids, worker is not created', async () => {
    const { store, workspace, post } = await setup()

    const response = await post('/api/team/worker/add', {
      name: 'Boshy',
      role: 'coder',
      preset: 'geminu',
      autostart: false,
    })
    expect(response.status).toBe(400)
    expect(String(response.json.error)).toContain('geminu')
    expect(String(response.json.error)).toContain('opencode')
    expect(store.listWorkers(workspace.id).some((worker) => worker.name === 'Boshy')).toBe(false)
  })

  test('known preset persists a resolved launch config the worker can start from', async () => {
    const { store, workspace, post } = await setup()

    const response = await post('/api/team/worker/add', {
      name: 'Codey',
      role: 'coder',
      preset: 'opencode',
      autostart: false,
    })
    expect(response.status).toBe(201)
    expect(response.json.ok).toBe(true)
    const workerId = String(response.json.worker_id)

    // Regression: the route used to persist a bare { commandPresetId } with
    // command=undefined — a config no spawn could ever use.
    const config = store.peekAgentLaunchConfig(workspace.id, workerId)
    expect(config?.command).toBe('opencode')
    expect(config?.commandPresetId).toBe('opencode')
    expect(Array.isArray(config?.args)).toBe(true)
  })

  test('start on a worker without a launch config returns the actionable hint, not a 500', async () => {
    const { store, workspace, post } = await setup()
    store.addWorker(workspace.id, { name: 'Naked', role: 'coder' })

    const response = await post('/api/team/worker/start', { name: 'Naked' })
    expect(response.status).toBe(400)
    expect(String(response.json.error)).toContain('team engine Naked')
    expect(String(response.json.error)).not.toContain('Agent launch config not found')
  })

  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'start succeeds after the preset-configured add (full one-command chain)',
    async () => {
      const { store, workspace, post } = await setup()
      const created = await post('/api/team/worker/add', {
        name: 'Runner',
        role: 'coder',
        preset: 'opencode',
        autostart: false,
      })
      expect(created.status).toBe(201)

      // Swap in a spawnable passive config (same seam the engine switch uses);
      // the guard must let a preset-configured worker through to the starter.
      const workerId = String(created.json.worker_id)
      const worker = store.listWorkers(workspace.id).find((entry) => entry.id === workerId)
      if (!worker) throw new Error('worker missing')
      const workspacePath = workspace.path
      store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: [join(workspacePath, 'passive-worker.cjs')],
      })

      const started = await post('/api/team/worker/start', { name: 'Runner' })
      expect(started.status).toBe(200)
      expect(started.json.ok).toBe(true)
    },
    20_000
  )
})
