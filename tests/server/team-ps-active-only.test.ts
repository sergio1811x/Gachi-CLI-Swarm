import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * Этап 3.1: `team ps` reads the team list route with `?active_only=1`.
 * Workers without a live run (never started, or settled to stopped/failed)
 * must be filtered out; the unfiltered list stays complete. The deterministic
 * legs run against the UI variant of the route (no PTY needed); the live-run
 * inclusion leg needs a real ConPTY child and is platform-scoped.
 */

type TeamListPayload = Array<{
  id: string
  name: string
  status: string
  has_active_run: boolean
}>

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

const waitFor = async (predicate: () => boolean, timeoutMs: number, message: string) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

const setupStore = (dataDir: string) => {
  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(dataDir, 'Alpha')
  const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) throw new Error('Expected default orchestrator')
  const app = createApp({ store })
  servers.push(app.server)
  return new Promise<{
    store: typeof store
    workspaceId: string
    orchestratorId: string
    baseUrl: string
  }>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve({
        store,
        workspaceId: workspace.id,
        orchestratorId: orchestrator.id,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

const getUiTeam = async (
  baseUrl: string,
  workspaceId: string,
  uiToken: string,
  query = ''
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspaceId}/team${query}`, {
    method: 'GET',
    headers: { cookie: `gachi_ui_token=${uiToken}` },
  })
  return { status: response.status, json: await response.json() }
}

const getAgentTeam = async (
  baseUrl: string,
  workspaceId: string,
  agentId: string,
  token: string,
  query = ''
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/team${query}`, {
    method: 'GET',
    headers: { 'x-gachi-agent-id': agentId, 'x-gachi-agent-token': token },
  })
  return { status: response.status, json: await response.json() }
}

describe('team ps — active_only list filter (Этап 3.1)', () => {
  test('active_only=1 excludes never-started workers; unfiltered list stays full', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-ps-idle-'))
    tempDirs.push(dataDir)
    const harness = await setupStore(dataDir)
    const he = harness.store.addWorker(harness.workspaceId, { name: 'He-Man', role: 'coder' })
    const she = harness.store.addWorker(harness.workspaceId, { name: 'She-Ra', role: 'coder' })
    const uiToken = harness.store.getUiToken()

    const idle = await getUiTeam(harness.baseUrl, harness.workspaceId, uiToken, '?active_only=1')
    expect(idle.status).toBe(200)
    expect(idle.json).toEqual([])

    const full = await getUiTeam(harness.baseUrl, harness.workspaceId, uiToken)
    expect(full.status).toBe(200)
    const workers = full.json as TeamListPayload
    expect(workers.map((worker) => worker.id).sort()).toEqual([he.id, she.id].sort())
    for (const worker of workers) {
      expect(worker.has_active_run).toBe(false)
    }
  })

  test('agent route still demands a token; active_only honors the auth check', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-ps-auth-'))
    tempDirs.push(dataDir)
    const harness = await setupStore(dataDir)
    harness.store.addWorker(harness.workspaceId, { name: 'He-Man', role: 'coder' })

    const noToken = await getAgentTeam(
      harness.baseUrl,
      harness.workspaceId,
      harness.orchestratorId,
      ''
    )
    expect(noToken.status).toBe(401)

    const wrongToken = await getAgentTeam(
      harness.baseUrl,
      harness.workspaceId,
      harness.orchestratorId,
      'not-the-token'
    )
    expect(wrongToken.status).toBe(401)
  })

  test(
    'active_only=1 keeps live runs and drops settled crashes',
    { skip: SKIP_CONPTY_WINDOWS },
    async () => {
      const { writeFileSync } = await import('node:fs')
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-ps-live-'))
      tempDirs.push(dataDir)
      const harness = await setupStore(dataDir)
      const workspacePath = dataDir
      const passiveScript = join(workspacePath, 'passive-worker.cjs')
      writeFileSync(passiveScript, 'process.stdin.resume()\n')
      const crashScript = join(workspacePath, 'crashing-worker.cjs')
      writeFileSync(crashScript, 'process.stdin.resume()\nsetTimeout(() => process.exit(1), 300)\n')

      const live = harness.store.addWorker(harness.workspaceId, { name: 'Live One', role: 'coder' })
      harness.store.configureAgentLaunch(harness.workspaceId, live.id, {
        command: process.execPath,
        args: [passiveScript],
      })
      await harness.store.startAgent(harness.workspaceId, live.id, { gachiPort: '4010' })

      const dead = harness.store.addWorker(harness.workspaceId, { name: 'Dead One', role: 'coder' })
      harness.store.configureAgentLaunch(harness.workspaceId, dead.id, {
        command: process.execPath,
        args: [crashScript],
      })
      await harness.store.startAgent(harness.workspaceId, dead.id, { gachiPort: '4010' })

      const summaryOf = (agentId: string) =>
        harness.store
          .getWorkspaceSnapshot(harness.workspaceId)
          .agents.find((agent) => agent.id === agentId)
      await waitFor(
        () => summaryOf(dead.id)?.status === 'stopped',
        15_000,
        `Dead One summary never reached stopped: ${String(summaryOf(dead.id)?.status)}`
      )

      const token = harness.store.peekAgentToken(harness.orchestratorId)
      if (!token) throw new Error('Expected orchestrator token after start')
      const result = await getAgentTeam(
        harness.baseUrl,
        harness.workspaceId,
        harness.orchestratorId,
        token,
        '?active_only=1'
      )
      expect(result.status).toBe(200)
      const workers = result.json as TeamListPayload
      const ids = workers.map((worker) => worker.id)
      expect(ids).toContain(live.id)
      expect(ids).not.toContain(dead.id)
      for (const worker of workers) {
        expect(worker.has_active_run).toBe(true)
      }
    },
    30_000
  )
})
