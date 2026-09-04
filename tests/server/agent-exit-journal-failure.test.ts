import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

/**
 * B6 regression: the PTY-exit pipeline used to start with synchronous session
 * journal writes (snapshot + event). When those threw — e.g. Windows
 * EPERM/EBUSY on the atomic rename, or any transient fs error — the exit
 * handler never ran: the agent summary stayed `working`, the bound card stayed
 * `running`, and the worker was silently dead until a daemon restart. The
 * journal write must be best-effort so the exit pipeline ALWAYS settles the
 * agent (summary → stopped) and its task (sticky release → ready).
 */

const tempDirs: string[] = []
const stores: Array<{ close: () => Promise<void> | void }> = []

afterEach(async () => {
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

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

describe('worker exit settles agent and task even when the journal write fails (B6)', () => {
  test('crashed worker: summary → stopped, sticky card → ready, journal error non-fatal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-exit-journal-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    // Silent worker that dies on its own shortly after start.
    const workerScript = join(workspacePath, 'crashing-worker.cjs')
    writeFileSync(
      workerScript,
      'process.stdin.resume();\nsetTimeout(() => process.exit(1), 400);\n'
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')

    const worker = store.addWorker(workspace.id, { name: 'Montage', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      command: process.execPath,
      args: [workerScript],
    })
    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const card = taskStore.createTask(workspace.id, {
      title: 'Ship the login flow',
      description: 'in flight when the worker died',
      status: 'running',
      assignedAgentId: worker.id,
    })

    // Keep the released card in READY for assertions: pause the workspace
    // dispatcher so nothing re-claims the sticky card while we observe it.
    store.settings.setAppState(`dispatch_paused_${workspace.id}`, '1')

    // Sabotage the session journal exactly like a real fs failure would:
    // replace the agent journal directory with a plain file so every journal
    // write from now on throws ENOTDIR.
    const agentDir = join(
      workspacePath,
      '.gachi',
      'agents',
      worker.id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    )
    rmSync(agentDir, { force: true, recursive: true })
    writeFileSync(agentDir, 'journal blocked', 'utf8')

    const summaryOf = () =>
      store.getWorkspaceSnapshot(workspace.id).agents.find((a) => a.id === worker.id)

    await waitFor(
      () => summaryOf()?.status === 'stopped',
      15_000,
      'agent summary never reached stopped after worker exit (exit pipeline broken): ' +
        summaryOf()?.status
    )

    const after = taskStore.getTask(workspace.id, card.id)
    expect(after?.status).toBe('ready')
    // Sticky binding is kept: the released card still points at its worker.
    expect(after?.assignedAgentId).toBe(worker.id)
  }, 30_000)
})
