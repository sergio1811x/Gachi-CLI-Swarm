import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * Этап 2.2: `team worker compact <name>` reuses the agent-control context
 * surface — the engine's own compact slash command (claude/codex `/compact`,
 * agy/qwen `/compress`, opencode `/compact`) is written into the live worker
 * PTY, and the bound card gets a `[COMPACT]` journal entry. Deterministic legs
 * covered here: 404 unknown worker, 409 no live run, 409 unsupported engine
 * (generic node launch has no engine adapter), 200 + journal for claude- and
 * opencode-profiled workers.
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

const setup = async (dataDir: string) => {
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  const workerScript = join(workspacePath, 'passive-worker.cjs')
  writeFileSync(workerScript, 'process.stdin.resume();\n')
  // Fake claude launcher: never spawned — it only has to sit in the persisted
  // launch cache, where the engine resolver matches its basename to claude.
  const fakeClaude = join(workspacePath, 'claude.cmd')
  writeFileSync(fakeClaude, 'rem fake\n')
  // Same trick for the opencode profile (`/compact` regression).
  const fakeOpencode = join(workspacePath, 'opencode.cmd')
  writeFileSync(fakeOpencode, 'rem fake\n')
  // A REAL opencode-named launcher that echoes every stdin chunk back with
  // JSON.stringify — lets the CR/LF submission regression assert on the actual
  // PTY input bytes. Lives in a subdir because engine resolution matches the
  // command basename exactly.
  const echoDir = join(workspacePath, 'echo')
  mkdirSync(echoDir, { recursive: true })
  const echoScript = join(echoDir, 'echo-stdin.cjs')
  writeFileSync(
    echoScript,
    [
      "process.stdout.write('ready\\n> ')",
      '// Raw mode emulates a real TUI: bytes are delivered as-is (a cooked',
      '// console would line-buffer them and never forward the paste markers).',
      'process.stdin.setRawMode(true)',
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => process.stdout.write('RX:' + JSON.stringify(chunk) + '\\n'))",
      'process.stdin.resume()',
      '',
    ].join('\n')
  )
  const echoOpencode = join(echoDir, 'opencode.cmd')
  writeFileSync(echoOpencode, '@node "%~dp0echo-stdin.cjs"\n')
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

  const engineWorker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
  store.configureAgentLaunch(workspace.id, engineWorker.id, {
    command: process.execPath,
    args: [workerScript],
  })
  await store.startAgent(workspace.id, engineWorker.id, { gachiPort: '4010' })
  // Re-stamp the persisted config as a claude launch while the live run keeps
  // the passive node script alive — same seam the engine-switch flow uses.
  store.configureAgentLaunch(workspace.id, engineWorker.id, {
    command: fakeClaude,
    args: [],
  })

  const plainWorker = store.addWorker(workspace.id, { name: 'Vanilla', role: 'coder' })
  store.configureAgentLaunch(workspace.id, plainWorker.id, {
    command: process.execPath,
    args: [workerScript],
  })
  await store.startAgent(workspace.id, plainWorker.id, { gachiPort: '4010' })

  const opencodeWorker = store.addWorker(workspace.id, { name: 'OpenCoder', role: 'coder' })
  store.configureAgentLaunch(workspace.id, opencodeWorker.id, {
    command: process.execPath,
    args: [workerScript],
  })
  await store.startAgent(workspace.id, opencodeWorker.id, { gachiPort: '4010' })
  store.configureAgentLaunch(workspace.id, opencodeWorker.id, {
    command: fakeOpencode,
    args: [],
  })

  // Live opencode-profiled worker whose launcher echoes every stdin chunk —
  // lets the submission regression assert on the actual PTY input bytes.
  const echoWorker = store.addWorker(workspace.id, { name: 'EchoKid', role: 'coder' })
  store.configureAgentLaunch(workspace.id, echoWorker.id, {
    command: echoOpencode,
    args: [],
  })
  await store.startAgent(workspace.id, echoWorker.id, { gachiPort: '4010' })

  // Started but never launched — no active run (409).
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
    workspaceId: workspace.id,
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: {
      project_id: workspace.id,
      from_agent_id: orchestrator.id,
      token: token ?? '',
    },
    engineWorkerId: engineWorker.id,
    plainWorkerId: plainWorker.id,
    opencodeWorkerId: opencodeWorker.id,
    echoWorkerId: echoWorker.id,
  }
}

const compact = async (
  baseUrl: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}/api/team/worker/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('team worker compact (Этап 2.2)', () => {
  // The happy path writes into a LIVE PTY; in non-interactive Windows consoles
  // the passive child dies instantly, so this leg is platform-scoped like the
  // other ConPTY suites. The 404/409 legs below run everywhere.
  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'compact resolves the engine, writes the command and journals the card',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-compact-'))
      tempDirs.push(dataDir)
      const harness = await setup(dataDir)

      const card = taskStore.createTask(harness.workspaceId, {
        title: 'Ship the login flow',
        description: 'in flight',
        status: 'running',
        assignedAgentId: harness.engineWorkerId,
      })

      const ok = await compact(harness.baseUrl, { ...harness.auth, name: 'Montage' })
      expect(ok.status).toBe(200)
      expect(ok.json.ok).toBe(true)
      expect(ok.json.action).toBe('compact')
      expect(ok.json.task_id).toBe(card.id)

      const logs = taskStore.getTask(harness.workspaceId, card.id)?.logs ?? []
      expect(logs.some((line) => line.includes('[COMPACT]'))).toBe(true)
    },
    20_000
  )

  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'compact resolves the opencode profile (regression: profile used to declare compact null)',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-compact-oc-'))
      tempDirs.push(dataDir)
      const harness = await setup(dataDir)

      const card = taskStore.createTask(harness.workspaceId, {
        title: 'Refactor the billing module',
        description: 'in flight',
        status: 'running',
        assignedAgentId: harness.opencodeWorkerId,
      })

      const ok = await compact(harness.baseUrl, { ...harness.auth, name: 'OpenCoder' })
      expect(ok.status).toBe(200)
      expect(ok.json.ok).toBe(true)
      expect(ok.json.action).toBe('compact')
      expect(ok.json.task_id).toBe(card.id)

      const logs = taskStore.getTask(harness.workspaceId, card.id)?.logs ?? []
      expect(logs.some((line) => line.includes('[COMPACT]'))).toBe(true)
    },
    20_000
  )

  test.skipIf(SKIP_CONPTY_WINDOWS)(
    'compact submits the command into the live PTY with a separate CR keystroke',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-compact-cr-'))
      tempDirs.push(dataDir)
      const harness = await setup(dataDir)

      const card = taskStore.createTask(harness.workspaceId, {
        title: 'Compact the echo worker',
        description: 'in flight',
        status: 'running',
        assignedAgentId: harness.echoWorkerId,
      })

      const ok = await compact(harness.baseUrl, { ...harness.auth, name: 'EchoKid' })
      expect(ok.status).toBe(200)
      expect(ok.json.ok).toBe(true)

      const logs = taskStore.getTask(harness.workspaceId, card.id)?.logs ?? []
      expect(logs.some((line) => line.includes('[COMPACT]'))).toBe(true)

      // The launcher echoes every stdin chunk as RX:<JSON>. Regression: the
      // raw single-write path sent "/compact\n" — the LF never submits in the
      // TUI, so the command sat in the input line. The dispatch seam must
      // deliver the text (bracketed paste) and a STANDALONE "\r" chunk.
      const runId = harness.store.listAgentRuns(harness.echoWorkerId).at(-1)?.runId
      expect(runId).toBeTruthy()
      let received = ''
      for (let attempt = 0; attempt < 60; attempt += 1) {
        received = harness.store.getLiveRun(runId).output
        if (received.includes('RX:"\\r"')) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(received).toContain('/compact')
      expect(received).toContain('200~')
      expect(received).toContain('RX:"\\r"')
      expect(received).not.toContain('RX:"/compact\\n"')
    },
    45_000
  )

  test('404 unknown worker, 409 without a run, 409 for an engine without compact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-compact-neg-'))
    tempDirs.push(dataDir)
    const harness = await setup(dataDir)

    const missing = await compact(harness.baseUrl, { ...harness.auth, name: 'Ghost' })
    expect(missing.status).toBe(404)
    expect(String(missing.json.error)).toContain('Ghost')

    const noRun = await compact(harness.baseUrl, { ...harness.auth, name: 'Idle' })
    expect(noRun.status).toBe(409)
    expect(String(noRun.json.error)).toContain('not running')

    // Generic node launch has no engine adapter — the control layer refuses
    // with a typed conflict instead of guessing a slash command.
    const unsupported = await compact(harness.baseUrl, { ...harness.auth, name: 'Vanilla' })
    expect(unsupported.status).toBe(409)
    expect(String(unsupported.json.error)).toContain('does not support')
  })
})
