import '../helpers/mock-node-pty.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { rmWithRetry } from '../helpers/platform.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []
const stores: RuntimeStore[] = []

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
  // Release SQLite handles BEFORE removing temp dirs — Windows EBUSY otherwise.
  // Bounded: a hung close must not blow the hook timeout.
  for (const store of stores.splice(0)) {
    await Promise.race([
      store.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ])
  }

  for (const dir of tempDirs.splice(0)) {
    try {
      rmWithRetry(dir)
    } catch {
      // Handle still held somewhere: retry after the process settles instead
      // of failing the suite over leftover temp files.
      const timer = setTimeout(() => {
        try {
          rmWithRetry(dir, { attempts: 3 })
        } catch {}
      }, 5_000)
      timer.unref?.()
    }
  }
}, 20_000)

describe('runtime runs api (unit)', () => {
  test('GET /api/runtime/runs/:runId returns live run snapshot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-run-api-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const scriptPath = join(workspacePath, 'echo.js')
    writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 50)\nconsole.log('ready')\n")

    const store = createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    })
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    store.configureAgentLaunch(workspace.id, orchestrator.id, {
      command: 'node',
      args: [scriptPath],
    })

    const run = await store.startAgent(workspace.id, orchestrator.id, {
      gachiPort: '4010',
    })

    stores.push(store)
    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(`${baseUrl}/api/runtime/runs/${run.runId}`, {
      headers: { cookie },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        agentId: orchestrator.id,
        runId: run.runId,
      })
    )
  })
})
