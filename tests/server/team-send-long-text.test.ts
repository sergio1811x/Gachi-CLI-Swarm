import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { buildWorkerDispatchPayload } from '../../src/server/agent-stdin-dispatcher.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * Этап 1 regression guard: `team send` must deliver a long, multi-line task
 * text WITHOUT truncation. A historic ~228-char cut was the B7 name-splitting
 * bug, not a length limit — the real contract is:
 *   - the card description keeps the FULL body (only the title is derived:
 *     first line, capped at 80 chars),
 *   - the dispatch ledger row persists the FULL payload text,
 *   - the worker PTY prompt (buildWorkerDispatchPayload) embeds the FULL body.
 * The PTY leg needs a live ConPTY child and is platform-scoped; the ledger,
 * card and payload-builder legs run everywhere.
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

const waitFor = async (assertion: () => void, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

const LONG_HEAD = 'LONGTEXT-HEAD-9f3a-implement-the-module'
const LONG_TAIL = 'LONGTEXT-TAIL-77c4-end-of-task'
const longText = [
  `${LONG_HEAD}: include login support`,
  '',
  ...Array.from(
    { length: 12 },
    (_, i) =>
      'Step ' +
      String(i + 1) +
      ': check step-' +
      String(i + 1) +
      '.js and update test ' +
      String(i + 1) +
      ' expectations'
  ),
  '',
  `Final marker: ${LONG_TAIL}`,
].join('\n')

describe('team send delivers long task text without truncation (Этап 1)', () => {
  test('full body reaches card description, dispatch ledger and the PTY payload builder', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-send-longtext-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    // Passive script so the worker PTY stays alive and accepts delivery.
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
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${String(address.port)}`
    const token = store.peekAgentToken(orchestrator.id)

    expect(longText.length).toBeGreaterThan(500)
    const response = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspace.id,
        from_agent_id: orchestrator.id,
        token,
        to: 'Montage',
        text: longText,
      }),
    })
    expect(response.status).toBe(202)

    // 1) Dispatch ledger keeps the FULL payload text — head and tail markers
    //    both present, nothing clipped at either end.
    const dispatch = store.listDispatches(workspace.id).find((item) => item.toAgentId === worker.id)
    expect(dispatch).toBeDefined()
    expect(dispatch?.text).toContain(LONG_HEAD)
    expect(dispatch?.text).toContain(LONG_TAIL)
    expect(dispatch?.text.length).toBeGreaterThanOrEqual(longText.length)

    // 2) Card keeps the FULL body; only the title is derived
    //    (first line, capped at 80 chars).
    const assigned = taskStore.getAssignedTaskForWorker(workspace.id, worker.id)
    expect(assigned).toBeDefined()
    expect(assigned?.description).toContain(LONG_HEAD)
    expect(assigned?.description).toContain(LONG_TAIL)
    expect(assigned?.description.length).toBeGreaterThanOrEqual(longText.length)
    expect(assigned?.title).toBe(longText.split('\n')[0]?.slice(0, 80))

    // 3) The exact production prompt builder embeds the FULL body between the
    //    dispatch header and the reminder tail — no intermediate slicing.
    const payload = buildWorkerDispatchPayload(
      orchestrator.name,
      worker.description,
      String(dispatch?.id),
      longText,
      assigned ? { id: assigned.id, title: assigned.title } : undefined
    )
    expect(payload).toContain(LONG_HEAD)
    expect(payload).toContain(LONG_TAIL)
    expect(payload.indexOf(LONG_HEAD)).toBeLessThan(payload.indexOf(LONG_TAIL))
    expect(payload.indexOf(longText)).toBeGreaterThanOrEqual(0)
  })

  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'echoed PTY output shows the full body pasted into the worker prompt',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-send-longtext-pty-'))
      tempDirs.push(dataDir)
      const workspacePath = join(dataDir, 'ws')
      mkdirSync(workspacePath, { recursive: true })
      // Echo script: everything pasted into stdin is written back to stdout,
      // so the run output mirror shows the exact prompt the worker received.
      const workerScript = join(workspacePath, 'echo-worker.cjs')
      writeFileSync(
        workerScript,
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
          'process.stdin.resume();',
        ].join('\n')
      )

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
      store.configureAgentLaunch(workspace.id, worker.id, {
        command: process.execPath,
        args: [workerScript],
      })
      await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

      const app = createApp({ store })
      await new Promise<void>((resolve) => {
        app.server.listen(0, '127.0.0.1', () => resolve())
      })
      servers.push(app.server)
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      const baseUrl = `http://127.0.0.1:${String(address.port)}`
      const token = store.peekAgentToken(orchestrator.id)

      const response = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestrator.id,
          token,
          to: 'Montage',
          text: longText,
        }),
      })
      expect(response.status).toBe(202)

      const run = () => store.getActiveRunByAgentId(workspace.id, worker.id)
      await waitFor(() => {
        const output = run()?.output.replace(/\r\n/g, '\n') ?? ''
        expect(output).toContain(LONG_HEAD)
        expect(output).toContain(LONG_TAIL)
      })
      const finalOutput = run()?.output.replace(/\r\n/g, '\n') ?? ''
      expect(finalOutput.indexOf(LONG_HEAD)).toBeLessThan(finalOutput.indexOf(LONG_TAIL))
    },
    30_000
  )
})
