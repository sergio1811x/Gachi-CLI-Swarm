import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * Этап 2.3 / 2.4:
 * - `team worker restart-all-crashed` relaunches ONLY workers whose summary
 *   settled to stopped/failed and that still have a persisted launch config;
 *   live workers are untouched.
 * - `team note <name> "<text>"` injects a raw system note into the worker's
 *   live PTY without creating a card or dispatching the queue.
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

const waitFor = async (predicate: () => boolean, timeoutMs: number, message: string) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

const post = async (
  baseUrl: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('team worker restart-all-crashed and note (Этап 2.3/2.4)', () => {
  test('restart-all-crashed relaunches only dead workers with a launch config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-restart-crashed-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    const passiveScript = join(workspacePath, 'passive-worker.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume();\n')
    const crashScript = join(workspacePath, 'crashing-worker.cjs')
    writeFileSync(crashScript, 'process.stdin.resume();\nsetTimeout(() => process.exit(1), 400);\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [passiveScript],
    })
    await store.startAgent(workspace.id, orchestrator.id, { gachiPort: '4010' })
    const token = store.peekAgentToken(orchestrator.id)

    const phoenix = store.addWorker(workspace.id, { name: 'Phoenix', role: 'coder' })
    store.configureAgentLaunch(workspace.id, phoenix.id, {
      command: process.execPath,
      args: [crashScript],
    })
    await store.startAgent(workspace.id, phoenix.id, { gachiPort: '4010' })

    const alive = store.addWorker(workspace.id, { name: 'Alive', role: 'coder' })
    store.configureAgentLaunch(workspace.id, alive.id, {
      command: process.execPath,
      args: [passiveScript],
    })
    await store.startAgent(workspace.id, alive.id, { gachiPort: '4010' })

    // Wait until Phoenix's crash settled its summary to stopped.
    const summaryOf = (agentId: string) =>
      store.getWorkspaceSnapshot(workspace.id).agents.find((a) => a.id === agentId)
    await waitFor(
      () => summaryOf(phoenix.id)?.status === 'stopped',
      15_000,
      `Phoenix summary never reached stopped: ${String(summaryOf(phoenix.id)?.status)}`
    )

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const auth = {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token: token ?? '',
    }

    const result = await post(baseUrl, '/api/team/worker/restart-all-crashed', auth)
    expect(result.status).toBe(200)
    expect(result.json.ok).toBe(true)
    expect(result.json.restarted).toBe(1)
    const results = result.json.results as Array<{ name: string; started: boolean }>
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('Phoenix')
    expect(results[0]?.started).toBe(true)

    // Phoenix is live again; Alive's run was never bounced.
    expect(store.getActiveRunByAgentId(workspace.id, phoenix.id)).toBeDefined()
    expect(store.getActiveRunByAgentId(workspace.id, alive.id)).toBeDefined()
  }, 30_000)

  test('note injects into the live PTY without creating a card; 404/409 edges', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-note-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    const passiveScript = join(workspacePath, 'passive-worker.cjs')
    writeFileSync(passiveScript, 'process.stdin.resume();\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: process.execPath,
      args: [passiveScript],
    })
    await store.startAgent(workspace.id, orchestrator.id, { gachiPort: '4010' })
    const token = store.peekAgentToken(orchestrator.id)

    const worker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [passiveScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })
    store.addWorker(workspace.id, { name: 'Idle', role: 'coder' })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const auth = {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token: token ?? '',
    }

    const ok = await post(baseUrl, '/api/team/worker/note', {
      ...auth,
      name: 'Montage',
      text: 'keep the API contract stable while refactoring',
    })
    expect(ok.status).toBe(200)
    expect(ok.json.ok).toBe(true)
    expect(ok.json.run_id).toBeTypeOf('string')

    // The whole point of `note`: NO card, NO dispatch, NO queue movement.
    expect(taskStore.listTasks(workspace.id)).toEqual([])

    const missing = await post(baseUrl, '/api/team/worker/note', {
      ...auth,
      name: 'Ghost',
      text: 'anything',
    })
    expect(missing.status).toBe(404)

    const noRun = await post(baseUrl, '/api/team/worker/note', {
      ...auth,
      name: 'Idle',
      text: 'anything',
    })
    expect(noRun.status).toBe(409)
    expect(String(noRun.json.error)).toContain('No active run')
  }, 30_000)
})
