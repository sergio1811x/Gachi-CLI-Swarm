import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createAgentRunRecordStore } from '../../src/server/agent-run-record-store.js'
import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { taskStore } from '../../src/server/task-store.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

/** Narrow a possibly-undefined fixture value; keeps biome's noNonNullAssertion happy. */
const must = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`fixture missing: ${label}`)
  return value
}

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  taskStore.clear()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

interface FakeEntry {
  snapshot: AgentRunSnapshot
  onExit?: (event: { runId: string; exitCode: number | null }) => void
}

interface FakeAgentManager extends AgentManager {
  _emitExit: (runId: string, exitCode: number | null) => void
  _runs: Map<string, FakeEntry>
}

/**
 * PTY-less manager mirroring the real PTY lifecycle: `startAgent` registers a
 * run in `starting` state, `stopRun` kills it (snapshot flips to exited/error
 * and `onExit` fires), and `_emitExit` simulates a process exiting on its own.
 * Both trigger the real exit chain (session journal, run completion,
 * supervisor release, task settlement, re-dispatch).
 */
const createFakeAgentManager = (): FakeAgentManager => {
  const bus = createPtyOutputBus()
  const runs = new Map<string, FakeEntry>()
  let counter = 0

  const emitExit = (runId: string, exitCode: number | null) => {
    const entry = runs.get(runId)
    if (!entry) return
    entry.snapshot.status = exitCode === 0 ? 'exited' : 'error'
    entry.snapshot.exitCode = exitCode
    entry.onExit?.({ runId, exitCode })
  }

  return {
    _runs: runs,
    _emitExit: emitExit,
    getOutputBus() {
      return bus
    },
    pauseRun() {},
    resizeRun() {},
    resumeRun() {},
    writeInput() {},
    getRun(runId) {
      const entry = runs.get(runId)
      if (!entry) throw new Error(`Run not found: ${runId}`)
      return { ...entry.snapshot }
    },
    removeRun(runId) {
      runs.delete(runId)
    },
    async startAgent(input) {
      const snapshot: AgentRunSnapshot = {
        agentId: input.agentId,
        exitCode: null,
        output: '',
        pid: 1000 + counter,
        runId: `run-${++counter}`,
        status: 'starting',
      }
      runs.set(snapshot.runId, { snapshot, onExit: input.onExit })
      return snapshot
    },
    stopRun(runId) {
      const entry = runs.get(runId)
      if (!entry) return
      if (entry.snapshot.status === 'starting' || entry.snapshot.status === 'running') {
        emitExit(runId, null)
      }
    },
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the execution loop')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const createWorkspace = (store: ReturnType<typeof createRuntimeStore>, dataDir: string) => {
  const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'E2E')
  const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
  store.configureAgentLaunch(workspace.id, worker.id, {
    args: [],
    command: '/bin/bash',
  })
  return { workspace, worker }
}

describe('execution loop (server e2e)', () => {
  test('scenario 1: ready task is dispatched to a run, and a clean exit lands it in review', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-loop-s1-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)
    const { workspace, worker } = createWorkspace(store, dataDir)

    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Implement feature',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)

    expect(taskStore.getTask(workspace.id, task.id)?.status).toBe('running')
    const run = store.getAgentRun(workspace.id, worker.id)
    expect(run).toBeDefined()
    expect(must(run, 'run').taskId).toBe(task.id)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('working')

    manager._emitExit(must(run, 'run').id, 0)

    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'review')
    expect(taskStore.getTask(workspace.id, task.id)).toMatchObject({ status: 'review' })
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    expect(store.getAgentRun(workspace.id, worker.id)).toBeUndefined()
    expect(store.listActiveRuns()).toEqual([])
    expect(must(store.getRun(must(run, 'run').id), 'persisted run').runtimeState).toBe('exited')
    expect(must(store.getRun(must(run, 'run').id), 'persisted run').exitCode).toBe(0)
  })

  test('scenario 2: a crashed run requeues its task and a replacement worker retries it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-loop-s2-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)
    const { workspace, worker } = createWorkspace(store, dataDir)

    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Fragile task',
    })
    await store.dispatchAllWorkspaceTasks(workspace.id)
    const firstRun = must(store.getAgentRun(workspace.id, worker.id), 'first run')
    expect(taskStore.getTask(workspace.id, task.id)?.status).toBe('running')

    manager._emitExit(firstRun.id, 1)

    expect(must(store.getRun(firstRun.id), 'run after crash').runtimeState).toBe('error')

    // The loop autonomously requeues the task and re-dispatches it to a fresh
    // run without any manual intervention (the dispatcher restarts the worker).
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')
    const retried = must(taskStore.getTask(workspace.id, task.id), 'retried task')
    expect(retried.attempts).toBe(2)
    expect(store.getWorker(workspace.id, worker.id).status).toBe('working')

    const retryRun = must(store.getAgentRun(workspace.id, worker.id), 'retry run')
    expect(retryRun.id).not.toBe(firstRun.id)
    expect(retryRun.taskId).toBe(task.id)
    manager._emitExit(retryRun.id, 0)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'review')
    expect(taskStore.getTask(workspace.id, task.id)).toMatchObject({ status: 'review' })
  })

  test('scenario 3: after a restart reconcile fails orphaned runs and the loop resumes', async () => {
    // Simulate a hard crash: the process died but the exit handler never ran,
    // leaving an orphaned active run record in the database.
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-loop-s3-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-loop-s3-ws-'))
    tempDirs.push(dataDir, workspacePath)

    const seedDb = new Database(join(dataDir, 'runtime.sqlite'))
    initializeRuntimeDatabase(seedDb)
    const workspaceStore = createWorkspaceStore(seedDb, [])
    const workspace = workspaceStore.createWorkspace(workspacePath, 'Survivor')
    const worker = workspaceStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    workspaceStore.markAgentStarted(workspace.id, worker.id)
    const agentRunStore = createAgentRunStore(seedDb)
    agentRunStore.saveLaunchConfig(workspace.id, worker.id, {
      args: [],
      command: '/bin/bash',
    })
    taskStore.init(seedDb)
    const seededTask = taskStore.createTask(workspace.id, {
      assignedAgentId: worker.id,
      role: 'coder',
      status: 'running',
      title: 'Survive the restart',
    })
    const recordStore = createAgentRunRecordStore(seedDb)
    recordStore.upsertRun({
      agentId: worker.id,
      createdAt: Date.now(),
      endedAt: null,
      error: null,
      exitCode: null,
      id: 'run-orphaned',
      lastHeartbeat: Date.now(),
      lastOutput: '',
      lifecycleState: 'working',
      pid: 4242,
      runtimeState: 'running',
      startedAt: Date.now(),
      taskId: seededTask.id,
      updatedAt: Date.now(),
      workspaceId: workspace.id,
    })
    seedDb.close()

    const secondStore = createRuntimeStore({ agentManager: createFakeAgentManager(), dataDir })
    stores.push(secondStore)

    // Startup reconcile (already run during store creation) failed the orphaned
    // run. The requeued task may already be re-dispatched by the reconcile's
    // auto-dispatch, so the assertions below only pin down what cannot race.
    expect(secondStore.reconcileRuns()).toEqual({ failed: 0, restored: 0, stale: 0 })
    const task = must(taskStore.getTask(workspace.id, seededTask.id), 'seeded task')
    expect(['ready', 'claimed', 'assigned', 'running']).toContain(task.status)
    expect(secondStore.listActiveRuns()).toEqual([])
    expect(
      secondStore
        .getRunHistory()
        .some((entry) => entry.id === 'run-orphaned' && entry.runtimeState === 'error')
    ).toBe(true)

    // The requeued task is picked up again on the next dispatch.
    await secondStore.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')
    expect(taskStore.getTask(workspace.id, task.id)).toMatchObject({
      attempts: 1,
      status: 'running',
    })
  })

  test('scenario 4: the closed loop sustains many tasks without losses or ghost-busy agents', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-loop-s4-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)
    const { workspace, worker } = createWorkspace(store, dataDir)

    const taskCount = 15
    for (let i = 0; i < taskCount; i += 1) {
      const task = taskStore.createTask(workspace.id, {
        role: 'coder',
        status: 'ready',
        title: `Task ${i}`,
      })
      await store.dispatchAllWorkspaceTasks(workspace.id)
      await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')
      const run = must(store.getAgentRun(workspace.id, worker.id), 'final run')
      manager._emitExit(run.id, 0)
      await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'review')
    }

    const tasks = taskStore.listTasks(workspace.id)
    expect(tasks).toHaveLength(taskCount)
    expect(tasks.every((task) => task.status === 'review')).toBe(true)
    expect(tasks.some((task) => task.status === 'failed' || task.status === 'running')).toBe(false)
    expect(store.listActiveRuns()).toEqual([])
    expect(store.getWorker(workspace.id, worker.id).status).toBe('stopped')
    expect(store.getAgentHealth(workspace.id, worker.id).status).toBe('NOT_RUNNING')
  }, 30_000)
})
