import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { AgentManager, AgentRunSnapshot } from '../../src/server/agent-manager.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/**
 * PTY-less manager mirroring a real CLI agent run: start registers a run in
 * `starting`, `_emitExit` simulates the process exiting, and the real exit
 * chain (session journal, supervisor release, task settlement, re-dispatch)
 * runs. This lets the full loop run without a ConPTY console.
 */
const createFakeAgentManager = (): AgentManager & {
  _emitExit: (runId: string, code: number | null) => void
  _publishOutput: (runId: string, chunk: string) => void
} => {
  const bus = createPtyOutputBus()
  const runs = new Map<
    string,
    { snapshot: AgentRunSnapshot; onExit?: (e: { runId: string; exitCode: number | null }) => void }
  >()
  let counter = 0
  const emitExit = (runId: string, exitCode: number | null) => {
    const entry = runs.get(runId)
    if (!entry) return
    entry.snapshot.status = exitCode === 0 ? 'exited' : 'error'
    entry.snapshot.exitCode = exitCode
    entry.onExit?.({ runId, exitCode })
  }
  return {
    _emitExit: emitExit,
    _publishOutput: (runId, chunk) => bus.publish(runId, chunk),
    getOutputBus: () => bus,
    pauseRun: () => {},
    resizeRun: () => {},
    resumeRun: () => {},
    writeInput: () => {},
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
        pid: 2000 + counter,
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

describe('agent runtime loop with structured completion contract', () => {
  test('create -> dispatch -> complete -> report -> next task (serial self-sustaining loop)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-agent-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Loop')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: [],
      command: '/bin/bash',
    })

    // Two tasks queued back to back: the second must only start after the first
    // settles, proving the loop is serial and self-sustaining with one worker.
    const first = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'First feature',
    })
    const second = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Second feature',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, first.id)?.status === 'running')
    const run = must(store.getAgentRun(workspace.id, worker.id), 'run')
    expect(run.taskId).toBe(first.id)

    // The single worker must not be handed the second task in the same tick:
    // it stays `ready` (not `assigned`) so it can be claimed after the first
    // run settles.
    expect(taskStore.getTask(workspace.id, second.id)?.status).toBe('ready')

    // A clean exit settles the first task into review and the dispatcher
    // autonomously moves on to the next ready task.
    manager._emitExit(run.id, 0)
    await waitFor(() => taskStore.getTask(workspace.id, first.id)?.status === 'review')
    await waitFor(() => taskStore.getTask(workspace.id, second.id)?.status === 'running')
    expect(must(store.getAgentRun(workspace.id, worker.id), 'second run').taskId).toBe(second.id)
  })

  test('a structured completion contract is captured from the worker report', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-contract-'))
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ agentManager: createFakeAgentManager(), dataDir })
    stores.push(store)

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Contract')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { args: [], command: '/bin/bash' })
    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Implement feature',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')

    store.reportTask(workspace.id, worker.id, {
      status: 'success',
      text: `Done.\nTASK_COMPLETED {\n  "summary": "Implemented first feature.",\n  "filesChanged": ["src/first.ts"],\n  "tests": ["pnpm test"],\n  "status": "completed"\n}`,
    })

    const reported = must(taskStore.getTask(workspace.id, task.id), 'reported task')
    expect(reported.completion).toMatchObject({
      filesChanged: ['src/first.ts'],
      status: 'completed',
      summary: 'Implemented first feature.',
      tests: ['pnpm test'],
    })
    expect(reported.status).toBe('review')
  })

  test('a worker can report an auto-assigned task that has no dispatch ledger row', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-autoreport-'))
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ agentManager: createFakeAgentManager(), dataDir })
    stores.push(store)

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'AutoReport')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    // Auto-assigned at worker start: the task is `assigned` to the worker with
    // NO dispatch-ledger row (see agent-run-starter auto-assign path). Before
    // the fix, reportTask threw ConflictError and the task hung forever.
    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'assigned',
      assignedAgentId: worker.id,
      title: 'Autonomous fix',
    })

    expect(() => store.reportTask(workspace.id, worker.id, { text: 'Fixed it.' })).not.toThrow()

    const reported = must(taskStore.getTask(workspace.id, task.id), 'reported task')
    expect(reported.status).toBe('review')
    expect(reported.result).toBe('Fixed it.')
  })

  test('a TASK_ACK handshake stamps the task log and emits TASK_STARTED', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-ack-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)

    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    store.registerRuntimeEventsListener((_ws, event) => {
      events.push({ type: event.type, payload: event.payload })
    })

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Ack')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { args: [], command: '/bin/bash' })
    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Ack me',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')
    const run = must(store.getAgentRun(workspace.id, worker.id), 'run')

    // Worker acknowledges receipt on the terminal bus.
    manager._publishOutput(run.id, 'TASK_ACK\n')
    await waitFor(() =>
      taskStore.getTask(workspace.id, task.id)?.logs?.some((l) => l.includes('[TASK_ACK]'))
    )

    const started = events.find((e) => e.type === 'TASK_STARTED')
    expect(started).toBeDefined()
    expect(started?.payload).toMatchObject({ taskId: task.id, status: 'running' })
  })

  test('task semantic events: TASK_STARTED on dispatch, TASK_COMPLETED on clean exit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-events-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)

    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    store.registerRuntimeEventsListener((_ws, event) => {
      events.push({ type: event.type, payload: event.payload })
    })

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Events')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, { args: [], command: '/bin/bash' })
    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Emit me',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')

    const run = must(store.getAgentRun(workspace.id, worker.id), 'run')
    manager._emitExit(run.id, 0)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'review')

    const started = events.find((e) => e.type === 'TASK_STARTED')
    const completed = events.find((e) => e.type === 'TASK_COMPLETED')
    expect(started).toBeDefined()
    expect(started?.payload).toMatchObject({ taskId: task.id, status: 'running' })
    expect(completed).toBeDefined()
    expect(completed?.payload).toMatchObject({ taskId: task.id, status: 'review' })
  })

  test('a crash mid-run requeues the task instead of dropping it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-fake-crash-'))
    tempDirs.push(dataDir)
    const manager = createFakeAgentManager()
    const store = createRuntimeStore({ agentManager: manager, dataDir })
    stores.push(store)

    const workspace = store.createWorkspace(join(dataDir, 'workspace'), 'Crash')
    const worker = store.addWorker(workspace.id, { name: 'Bob', role: 'coder' })
    store.configureAgentLaunch(workspace.id, worker.id, {
      args: [],
      command: '/bin/bash',
    })
    const task = taskStore.createTask(workspace.id, {
      role: 'coder',
      status: 'ready',
      title: 'Fragile',
    })

    await store.dispatchAllWorkspaceTasks(workspace.id)
    await waitFor(() => taskStore.getTask(workspace.id, task.id)?.status === 'running')
    const run = must(store.getAgentRun(workspace.id, worker.id), 'run')
    manager._emitExit(run.id, 1)

    // The loop autonomously requeues and re-dispatches to a fresh run.
    await waitFor(() => {
      const t = taskStore.getTask(workspace.id, task.id)
      return t?.status === 'running' && t.attempts === 2
    })
    expect(must(store.getAgentRun(workspace.id, worker.id), 'final run').taskId).toBe(task.id)
    expect(must(taskStore.getTask(workspace.id, task.id), 'task after retries').attempts).toBe(2)
  })
})
