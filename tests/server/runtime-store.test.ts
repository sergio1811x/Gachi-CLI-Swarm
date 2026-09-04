import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { taskStore } from '../../src/server/task-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import { rmWithRetry } from '../helpers/platform.js'

const tempDirs: string[] = []
const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const createFakeAgentManager = (): AgentManager => {
  const runs = new Map<string, AgentRunSnapshot>()

  return {
    getOutputBus() {
      return outputBus
    },
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
    getRun(runId) {
      const run = runs.get(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      return run
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const run = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1,
        runId: `run-${input.agentId}`,
        status: 'starting' as const,
      }
      runs.set(run.runId, run)
      return run
    },
    stopRun() {},
    writeInput() {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  taskStore.clear()
  for (const dir of tempDirs.splice(0)) rmWithRetry(dir, { recursive: true, force: true })
})

describe('runtime store', () => {
  test('can create workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')

    expect(workspace).toMatchObject({
      name: 'Alpha',
      path: '/tmp/gachi-alpha',
    })
  })

  test('createWorkspace does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-create-workspace-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workspaces')) {
        throw new Error('insert workspace failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.createWorkspace('/tmp/gachi-alpha', 'Alpha')).toThrow(
      /insert workspace failed/
    )
    expect(workspaceStore.listWorkspaces()).toEqual([])

    db.close()
  })

  test('each workspace automatically has one orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const snapshot = store.getWorkspaceSnapshot(workspace.id)

    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.agents[0]).toMatchObject({
      name: 'Orchestrator',
      role: 'orchestrator',
      status: 'stopped',
      pendingTaskCount: 0,
    })
  })

  test('can add worker', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(worker).toMatchObject({
      workspaceId: workspace.id,
      name: 'Alice',
      role: 'coder',
      status: 'stopped',
      pendingTaskCount: 0,
    })
  })

  test('dispatchTask increments worker pending count and marks it working', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY started: worker is idle, not stopped (spec §3.6.4 keeps
    // stopped workers from being silently promoted to working when their
    // PTY isn't actually running).
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('working')
  })

  test('restores a missing Kanban card from an open dispatch without duplicating it', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-reconcile', 'Reconcile')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Restore this task card')
    const task = taskStore.getTaskByDispatchId(workspace.id, dispatch.id)
    expect(task).toBeDefined()
    taskStore.deleteTask(workspace.id, task!.id)

    expect(store.reconcileTasksFromDispatches(workspace.id)).toBe(1)
    // Deleted cards never resurrect into an active worker: an open (not
    // reported) dispatch is restored as `backlog` so the dispatcher — not a
    // ghost run — decides what happens next.
    expect(taskStore.getTaskByDispatchId(workspace.id, dispatch.id)).toMatchObject({
      assignedAgentId: worker.id,
      dispatchId: dispatch.id,
      status: 'backlog',
      title: 'Restore this task card',
    })
    expect(store.reconcileTasksFromDispatches(workspace.id)).toBe(0)
  })

  test('restores a reported dispatch into Review with its worker report', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-reconcile-report', 'Reconcile report')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.getWorker(workspace.id, worker.id).status = 'idle'

    const dispatch = await store.dispatchTask(workspace.id, worker.id, 'Write the report')
    store.reportTask(workspace.id, worker.id, { text: 'Verified on disk.' })
    const task = taskStore.getTaskByDispatchId(workspace.id, dispatch.id)
    expect(task).toBeDefined()
    taskStore.deleteTask(workspace.id, task!.id)

    expect(store.reconcileTasksFromDispatches(workspace.id)).toBe(1)
    expect(taskStore.getTaskByDispatchId(workspace.id, dispatch.id)).toMatchObject({
      dispatchId: dispatch.id,
      result: 'Verified on disk.',
      status: 'review',
    })
  })

  test('rebuilds missing task cards from the dispatch ledger during runtime restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-task-restart-'))
    tempDirs.push(dataDir)
    const firstStore = createRuntimeStore({ dataDir })
    const workspace = firstStore.createWorkspace(dataDir, 'Restart recovery')
    const worker = firstStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    firstStore.getWorker(workspace.id, worker.id).status = 'idle'
    const dispatch = await firstStore.dispatchTask(
      workspace.id,
      worker.id,
      'Keep this task after restart'
    )
    const task = taskStore.getTaskByDispatchId(workspace.id, dispatch.id)
    expect(task).toBeDefined()
    taskStore.deleteTask(workspace.id, task!.id)
    await firstStore.close()

    const secondStore = createRuntimeStore({ dataDir })
    // Startup recovery deliberately requeues a task whose process did not
    // survive the restart; without a live run it lands in `backlog` (never
    // straight into ready/running) so dispatch re-evaluates affinity first.
    expect(taskStore.getTaskByDispatchId(workspace.id, dispatch.id)).toMatchObject({
      assignedAgentId: worker.id,
      dispatchId: dispatch.id,
      status: 'backlog',
    })
    await secondStore.close()
  })

  test('dispatchTask keeps a stopped worker stopped while accumulating queue', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // worker.addWorker initialises status='stopped' (PTY hasn't started).

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(1)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('startAgent success promotes a fresh worker from stopped to idle', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
  })

  test('startAgent resets a queued worker back to idle (status tracks activity, not backlog)', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Worker was running, took a dispatch (pendingTaskCount=1, status='working'),
    // then user hit [Restart]. A fresh PTY hasn't done any work yet — the next
    // team send is what should flip status back to 'working', not the leftover
    // queue depth.
    store.getWorker(workspace.id, worker.id).status = 'idle'
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('idle')
    // pendingTaskCount stays so WorkerModal / recovery summary can still surface
    // the backlog — the status field just doesn't read from it anymore.
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('startAgent transitions a stopped worker with pending backlog to idle (restart path)', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate the hydration end-state after a gachi restart: worker status is
    // 'stopped' (PTY isn't running), but dispatch ledger replay left
    // pendingTaskCount > 0 because the previous session ended before the
    // worker reported back. User hits [Restart] -> startAgent -> must NOT
    // auto-promote to 'working'.
    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    expect(store.getWorker(workspace.id, worker.id).pendingTaskCount).toBe(1)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.status).toBe('idle')
    expect(updatedWorker.pendingTaskCount).toBe(1)
  })

  test('startAgent is idempotent when a live run already exists (no 500 on double start)', async () => {
    const store = createRuntimeStore({ agentManager: createFakeAgentManager() })
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.configureAgentLaunch(workspace.id, worker.id, { command: '/bin/bash', args: [] })

    const first = await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })
    // The PTY is live; a retry (orchestrator double-tap of `team worker start`
    // while the run sits in `working`/`waiting_input`) must be a no-op instead
    // of throwing on the illegal `waiting_input -> starting` transition.
    const second = await store.startAgent(workspace.id, worker.id, { gachiPort: '4010' })

    expect(second.runId).toBe(first.runId)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('idle')
    expect(store.getAgentLifecycleState(workspace.id, worker.id)).not.toBe('starting')
  })

  test('reportTask resets worker pending count and returns it to idle', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('idle')
  })

  test('reportTask keeps a stopped worker stopped while draining pending count', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    store.dispatchTask(workspace.id, worker.id, 'Implement feature')
    store.getWorker(workspace.id, worker.id).status = 'stopped'
    store.reportTask(workspace.id, worker.id, { status: 'success', text: 'Done' })

    const updatedWorker = store.getWorker(workspace.id, worker.id)
    expect(updatedWorker.pendingTaskCount).toBe(0)
    expect(updatedWorker.status).toBe('stopped')
  })

  test('listWorkers excludes orchestrator', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })
    store.addWorker(workspace.id, {
      name: 'Bob',
      role: 'tester',
    })

    expect(store.listWorkers(workspace.id)).toMatchObject([
      {
        id: expect.any(String),
        description: expect.any(String),
        name: 'Alice',
        role: 'coder',
        status: 'stopped',
        pendingTaskCount: 0,
      },
      {
        id: expect.any(String),
        description: expect.any(String),
        name: 'Bob',
        role: 'tester',
        status: 'stopped',
        pendingTaskCount: 0,
      },
    ])
  })

  test('rejects duplicate worker names within the same workspace', () => {
    const store = createRuntimeStore()

    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    store.addWorker(workspace.id, {
      name: 'Alice',
      role: 'coder',
    })

    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('normalizes worker names on create before storing and matching duplicates', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')

    const worker = store.addWorker(workspace.id, {
      name: ' Alice ',
      role: 'coder',
    })

    expect(worker.name).toBe('Alice')
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({ id: worker.id, name: 'Alice' })
    )
    expect(() =>
      store.addWorker(workspace.id, {
        name: 'Alice',
        role: 'tester',
      })
    ).toThrow('Worker name already exists: Alice')
  })

  test('rejects blank worker names on create', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')

    expect(() => store.addWorker(workspace.id, { name: '   ', role: 'coder' })).toThrow(
      'Worker name must not be empty'
    )
  })

  test('addWorker does not mutate memory when DB insert fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-add-worker-db-fail-'))
    tempDirs.push(dataDir)
    const db = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(db)
    const workspaceStore = createWorkspaceStore(db, [])
    const workspace = workspaceStore.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const originalPrepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((source: string) => {
      if (source.startsWith('INSERT INTO workers')) {
        throw new Error('insert worker failed')
      }
      return originalPrepare(source)
    })

    expect(() => workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })).toThrow(
      /insert worker failed/
    )
    expect(workspaceStore.listWorkers(workspace.id)).toEqual([])

    db.close()
  })
})
