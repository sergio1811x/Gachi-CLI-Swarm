import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * B2 regression: `team cancel`/`team task-delete` only accepted full task ids,
 * while the board and notifications render `#<first8>`. Short ids (with or
 * without `#`) must resolve; ambiguous prefixes must be rejected loudly.
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
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-short-id-'))
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

  const alphaOne = taskStore.createTask(workspace.id, {
    title: 'Alpha one',
    description: 'first',
    status: 'ready',
  })
  const alphaTwo = taskStore.createTask(workspace.id, {
    title: 'Alpha two',
    description: 'second',
    status: 'ready',
  })
  const beta = taskStore.createTask(workspace.id, {
    title: 'Beta',
    description: 'third',
    status: 'ready',
  })
  if (!alphaOne || !alphaTwo || !beta) throw new Error('Expected tasks to be created')
  return { store, workspace, orchestrator, alphaOne, alphaTwo, beta }
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

const post = async (baseUrl: string, path: string, body: Record<string, string>) => {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('team task short-id resolution (B2)', () => {
  test('resolveTaskId handles exact ids, #-prefixed and bare prefixes, and rejects ambiguity', async () => {
    const { store, workspace, alphaOne, beta } = await setup()

    expect(taskStore.resolveTaskId(workspace.id, alphaOne.id)?.id).toBe(alphaOne.id)
    expect(taskStore.resolveTaskId(workspace.id, `#${alphaOne.id.slice(0, 8)}`)?.id).toBe(
      alphaOne.id
    )
    expect(taskStore.resolveTaskId(workspace.id, `  ${beta.id.slice(0, 10)} `)?.id).toBe(beta.id)
    expect(taskStore.resolveTaskId(workspace.id, 'zzzzzzzz')).toBeUndefined()

    // Pigeonhole: uuid ids start with one of 16 hex chars, so 17 tasks force a
    // first-char collision — a one-char prefix must be reported as ambiguous.
    for (let i = 0; i < 17; i += 1) {
      taskStore.createTask(workspace.id, { title: `Filler ${i}`, description: '', status: 'ready' })
    }
    const firstChars = new Map<string, number>()
    for (const task of taskStore.listTasks(workspace.id)) {
      firstChars.set(task.id[0], (firstChars.get(task.id[0]) ?? 0) + 1)
    }
    const ambiguousChar = [...firstChars.entries()].find(([, count]) => count >= 2)?.[0]
    expect(ambiguousChar).toBeTruthy()
    expect(() => taskStore.resolveTaskId(workspace.id, ambiguousChar)).toThrow(/Ambiguous task id/)
  })

  test('team task-delete accepts a #short id and removes the card', async () => {
    const { store, workspace, orchestrator, alphaOne } = await setup()
    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const response = await post(baseUrl, '/api/team/task-delete', {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      task_id: `#${alphaOne.id.slice(0, 8)}`,
      reason: 'zombie card',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(taskStore.getTask(workspace.id, alphaOne.id)).toBeUndefined()
  })

  test('team cancel accepts a bare short id and cancels the card', async () => {
    const { store, workspace, orchestrator, beta } = await setup()
    const baseUrl = await startServer(store)
    const token = store.peekAgentToken(orchestrator.id)

    const response = await post(baseUrl, '/api/team/cancel', {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token,
      task_id: beta.id.slice(0, 8),
      reason: 'no longer needed',
    })
    expect(response.status).toBe(202)
    const body = (await response.json()) as { ok: boolean; task_id: string }
    expect(body.ok).toBe(true)
    expect(body.task_id).toBe(beta.id)
    expect(taskStore.getTask(workspace.id, beta.id)?.status).toBe('canceled')
  })
})
