import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import {
  BREAKER_STAGE_KEY_PREFIX,
  BREAKER_UNTIL_KEY_PREFIX,
} from '../../src/server/error-budget-breaker.js'
import { DISPATCH_PAUSED_KEY_PREFIX } from '../../src/server/permission-mode.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

/**
 * Orchestrator CLI control surface:
 * - `team resume` → POST /api/team/dispatch-resume: clears the error-budget
 *   breaker from the CLI exactly like the UI resume path (flag + cooldown
 *   deadline + escalation stage + softened streak).
 * - `team worker describe` → POST /api/team/worker/describe: rewrites the
 *   worker's persistent description used in every dispatch prompt.
 *
 * Auth tokens are minted at run start, so the harness starts one keep-alive
 * child per agent (survives headless consoles, no real CLI engines involved).
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
  baseUrl: string
  workspaceId: string
  orchestratorAuth: Record<string, unknown>
  workerAuth: Record<string, unknown>
  workerName: string
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

  const startKeepAlive = async (agentId: string) => {
    store.configureAgentLaunch(workspace.id, agentId, {
      command: process.execPath,
      args: [keepAlive],
    })
    await store.startAgent(workspace.id, agentId, { gachiPort: '4010' })
  }
  await startKeepAlive(orchestrator.id)

  const worker = store.addWorker(workspace.id, {
    name: 'Image Gen B',
    role: 'coder',
    description: 'Image generation via gptimage inside Docker',
  })
  await startKeepAlive(worker.id)

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  const baseAuth = { project_id: workspace.id }
  return {
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspaceId: workspace.id,
    orchestratorAuth: {
      ...baseAuth,
      from_agent_id: orchestrator.id,
      token: store.peekAgentToken(orchestrator.id) ?? '',
    },
    workerAuth: {
      ...baseAuth,
      from_agent_id: worker.id,
      token: store.peekAgentToken(worker.id) ?? '',
    },
    workerName: worker.name,
  }
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

describe('POST /api/team/dispatch-resume (team resume)', () => {
  test('fully closes an open breaker: flag, cooldown deadline and stage reset', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-resume-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    h.store.settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${h.workspaceId}`, '1')
    h.store.settings.setAppState(
      `${BREAKER_UNTIL_KEY_PREFIX}${h.workspaceId}`,
      String(Date.now() + 5 * 60_000)
    )
    h.store.settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${h.workspaceId}`, '2')

    const result = await post(h.baseUrl, '/api/team/dispatch-resume', {
      ...h.orchestratorAuth,
      reason: 'fixed the failing engine',
    })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, dispatch_paused: false, was_paused: true })

    expect(
      h.store.settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${h.workspaceId}`)?.value
    ).toBe('0')
    expect(h.store.settings.getAppState(`${BREAKER_UNTIL_KEY_PREFIX}${h.workspaceId}`)?.value).toBe(
      '0'
    )
    expect(h.store.settings.getAppState(`${BREAKER_STAGE_KEY_PREFIX}${h.workspaceId}`)?.value).toBe(
      '0'
    )
  })

  test('reports was_paused false when nothing was paused and still resets stale keys', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-resume-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    // Legacy residue: flag cleared but deadline/stage left behind by an older
    // build — the resume must not leave them armed.
    h.store.settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${h.workspaceId}`, '123')
    h.store.settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${h.workspaceId}`, '3')

    const result = await post(h.baseUrl, '/api/team/dispatch-resume', h.orchestratorAuth)
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, dispatch_paused: false, was_paused: false })
    expect(h.store.settings.getAppState(`${BREAKER_STAGE_KEY_PREFIX}${h.workspaceId}`)?.value).toBe(
      '0'
    )
  })

  test('a plain worker is rejected (orchestrator-only verb)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-resume-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    const result = await post(h.baseUrl, '/api/team/dispatch-resume', h.workerAuth)
    expect(result.status).toBe(403)
  })
})

describe('POST /api/team/worker/describe (team worker describe)', () => {
  test('rewrites the persistent description used in dispatch prompts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-describe-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    const next = 'Image generation via flow2api HTTP endpoint; no Docker involved'
    const result = await post(h.baseUrl, '/api/team/worker/describe', {
      ...h.orchestratorAuth,
      name: h.workerName,
      description: next,
    })
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ ok: true, name: h.workerName, description: next })

    const persisted = h.store
      .listWorkers(h.workspaceId)
      .find((candidate) => candidate.name === h.workerName)
    expect(persisted?.description).toBe(next)
  })

  test('unknown worker → 404, missing description → 400', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-describe-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    const missing = await post(h.baseUrl, '/api/team/worker/describe', {
      ...h.orchestratorAuth,
      name: 'Ghost',
      description: 'whatever',
    })
    expect(missing.status).toBe(404)

    const noText = await post(h.baseUrl, '/api/team/worker/describe', {
      ...h.orchestratorAuth,
      name: h.workerName,
    })
    expect(noText.status).toBe(400)
  })

  test('a plain worker cannot rewrite descriptions', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-describe-'))
    tempDirs.push(dataDir)
    const h = await setup(dataDir)

    const result = await post(h.baseUrl, '/api/team/worker/describe', {
      ...h.workerAuth,
      name: h.workerName,
      description: 'self-serve prompt rewrite',
    })
    expect(result.status).toBe(403)
  })
})
