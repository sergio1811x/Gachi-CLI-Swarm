import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * B5 regression: `team report` with no live orchestrator PTY used to throw
 * PtyInactiveError (409) BEFORE the card was settled, leaving the dispatch
 * hanging in running/assigned with nobody to hand it over to. The report must
 * always settle the card into review; the orchestrator notification is queued
 * in the inbox and flushed on every heartbeat tick (which also self-heals a
 * crashed orchestrator run).
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

describe('team report without a live orchestrator run (B5)', () => {
  test('worker report settles the card into review instead of 409-ing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-report-no-orch-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    // Passive script keeps the WORKER run alive — the run mints the CLI token
    // the report route authenticates against. The orchestrator is never
    // started: that is the whole point of this regression.
    const workerScript = join(workspacePath, 'passive-worker.cjs')
    writeFileSync(workerScript, 'process.stdin.resume();\n')

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')

    const worker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })
    const workerToken = store.peekAgentToken(worker.id)

    // In-flight card the worker is about to report on.
    const card = taskStore.createTask(workspace.id, {
      title: 'Ship the login flow',
      description: 'in flight when the orchestrator died',
      status: 'running',
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

    const response = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: worker.id,
        token: workerToken,
        result: 'Login flow implemented, tests green, artifacts on disk.',
      }),
    })
    // 202 + ok — the report is recorded; delivery to the (absent) orchestrator
    // is retried later via the inbox instead of failing the whole report.
    expect(response.status).toBe(202)
    const body = (await response.json()) as { ok: boolean; forward_error: string | null }
    expect(body.ok).toBe(true)
    expect(body.forward_error).toBeNull()

    const after = taskStore.getTask(workspace.id, card.id)
    expect(after?.status).toBe('review')
    expect(after?.result).toContain('Login flow implemented')
  })
})
