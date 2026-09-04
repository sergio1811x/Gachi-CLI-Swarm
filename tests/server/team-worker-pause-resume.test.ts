import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * Этап 2.1: `team worker pause|resume <name>` suspends/resumes the worker's
 * live ConPTY run via the existing terminal-run plumbing. The recovery
 * watchdog already treats a paused run as intentionally silent, so pausing is
 * safe against false stall alerts. 404 for an unknown worker, 409 when the
 * worker has no live run — those two paths need no real PTY and are covered
 * unconditionally; the suspend/resume happy path needs a live ConPTY child
 * and is platform-scoped like the other ConPTY suites.
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

const workerAction = async (
  baseUrl: string,
  body: Record<string, unknown>,
  action: 'pause' | 'resume'
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}/api/team/worker/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

interface Harness {
  store: ReturnType<typeof createRuntimeStore>
  baseUrl: string
  auth: Record<string, string>
  workspaceId: string
  busyWorkerId: string
}

const setup = async (dataDir: string): Promise<Harness> => {
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
  const token = store.peekAgentToken(orchestrator.id)

  const busy = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
  store.configureAgentLaunch(workspace.id, busy.id, {
    command: process.execPath,
    args: [workerScript],
  })
  await store.startAgent(workspace.id, busy.id, { gachiPort: '4010' })

  // A worker that was configured but never started — no run at all (409).
  store.addWorker(workspace.id, { name: 'Idle', role: 'coder' })

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('no port')

  return {
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token: token ?? '',
    },
    workspaceId: workspace.id,
    busyWorkerId: busy.id,
  }
}

describe('team worker pause/resume (Этап 2.1)', () => {
  test('404 for unknown worker, 409 for a worker without a live run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-pause-'))
    tempDirs.push(dataDir)
    const harness = await setup(dataDir)

    const missing = await workerAction(harness.baseUrl, { ...harness.auth, name: 'Ghost' }, 'pause')
    expect(missing.status).toBe(404)
    expect(String(missing.json.error)).toContain('Ghost')

    const noRun = await workerAction(harness.baseUrl, { ...harness.auth, name: 'Idle' }, 'pause')
    expect(noRun.status).toBe(409)
    expect(String(noRun.json.error)).toContain('No active run')

    const noRunResume = await workerAction(
      harness.baseUrl,
      { ...harness.auth, name: 'Idle' },
      'resume'
    )
    expect(noRunResume.status).toBe(409)
  })

  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'pause suspends and resume releases the live worker PTY',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-pause-pty-'))
      tempDirs.push(dataDir)
      const harness = await setup(dataDir)

      const paused = await workerAction(
        harness.baseUrl,
        { ...harness.auth, name: 'Montage' },
        'pause'
      )
      expect(paused.status).toBe(200)
      expect(paused.json.ok).toBe(true)
      expect(paused.json.paused).toBe(true)
      expect(typeof paused.json.run_id).toBe('string')
      expect(
        harness.store.getActiveRunByAgentId(harness.workspaceId, harness.busyWorkerId)?.paused
      ).toBe(true)

      const resumed = await workerAction(
        harness.baseUrl,
        { ...harness.auth, name: 'Montage' },
        'resume'
      )
      expect(resumed.status).toBe(200)
      expect(resumed.json.ok).toBe(true)
      expect(resumed.json.paused).toBe(false)
      expect(
        harness.store.getActiveRunByAgentId(harness.workspaceId, harness.busyWorkerId)?.paused
      ).toBe(false)
    },
    30_000
  )
})
