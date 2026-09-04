import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { readAgentSessionSnapshot } from '../../src/server/agent-session-journal.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const stores: Array<ReturnType<typeof createRuntimeStore>> = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
  }
})

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle transition')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const describeWithAttachableConsole = process.platform === 'win32' ? describe.skip : describe

describeWithAttachableConsole('agent lifecycle runtime integration', () => {
  test('persists the real PTY lifecycle from worker creation through stop', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-lifecycle-runtime-data-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-lifecycle-runtime-workspace-'))
    tempDirs.push(dataDir, workspacePath)

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Lifecycle')
    const worker = store.addWorker(workspace.id, { name: 'worker', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: ['-e', "console.log('journal-ready'); setInterval(() => {}, 1000)"],
      command: process.execPath,
    })

    const run = await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })
    expect(store.getAgentLifecycleState(workspace.id, worker.id)).toBe('ready')
    const transcriptPath = join(
      workspacePath,
      '.gachi',
      'agents',
      worker.id,
      'history',
      'transcript.log'
    )
    await waitFor(() => {
      try {
        return readFileSync(transcriptPath, 'utf8').includes('journal-ready')
      } catch {
        return false
      }
    })

    store.stopAgentRun(run.runId)
    await waitFor(() => store.getAgentLifecycleState(workspace.id, worker.id) === 'stopped')

    const db = new Database(join(dataDir, 'runtime.sqlite'), { readonly: true })
    const events = db
      .prepare(
        'SELECT to_state FROM agent_lifecycle_events WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(workspace.id, worker.id) as Array<{ to_state: string }>
    db.close()

    expect(events.map((event) => event.to_state)).toEqual([
      'created',
      'starting',
      'ready',
      'stopping',
      'stopped',
    ])
    expect(readAgentSessionSnapshot(workspacePath, worker.id)).toMatchObject({
      agentId: worker.id,
      command: process.execPath,
      runId: run.runId,
      status: 'failed',
    })
    expect(
      readFileSync(
        join(workspacePath, '.gachi', 'agents', worker.id, 'history', 'events.jsonl'),
        'utf8'
      )
    ).toContain('"type":"started"')
    expect(readFileSync(transcriptPath, 'utf8')).toContain('journal-ready')
  })
})
