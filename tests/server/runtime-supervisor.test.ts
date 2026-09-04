import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentHeartbeatStore } from '../../src/server/agent-heartbeat-store.js'
import { createAgentLifecycleStore } from '../../src/server/agent-lifecycle-store.js'
import { createAgentRunRecordStore } from '../../src/server/agent-run-record-store.js'
import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import { createRuntimeSupervisor } from '../../src/server/runtime-supervisor.js'
import { applySchemaVersion21 } from '../../src/server/sqlite-schema-v21.js'
import { applySchemaVersion22 } from '../../src/server/sqlite-schema-v22.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'A', path: '/tmp/a' }

const tempDirs: string[] = []
const openDbs: Database.Database[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const createStores = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-supervisor-'))
  tempDirs.push(dataDir)
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  openDbs.push(db)
  db.exec(`
    CREATE TABLE agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL,
      lifecycle_state TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      last_heartbeat INTEGER,
      last_output TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  applySchemaVersion21(db)
  applySchemaVersion22(db)
  applySchemaVersion23(db)
  return {
    db,
    heartbeatStore: createAgentHeartbeatStore(db),
    lifecycleStore: createAgentLifecycleStore(db),
    recordStore: createAgentRunRecordStore(db),
  }
}

interface FakeAgentRuntimeOptions {
  startReturnsRunning?: boolean
}

interface LiveRun {
  agentId: string
  exitCode: number | null
  output: string
  pid: number | null
  runId: string
  startedAt: number
  status: 'starting' | 'running' | 'exited' | 'error'
}

const createFakeAgentRuntime = (options: FakeAgentRuntimeOptions = {}) => {
  const bus = createPtyOutputBus()
  const runs = new Map<string, LiveRun>()
  let runIdCounter = 0
  let onRunStarted:
    | ((
        runId: string,
        agentId: string,
        workspaceId: string,
        startedAt: number,
        pid: number | null
      ) => void)
    | undefined
  let onRunExited:
    | ((
        runId: string,
        agentId: string,
        workspaceId: string,
        exitCode: number | null,
        endedAt: number
      ) => void)
    | undefined

  const isActiveStatus = (status: LiveRun['status']) =>
    status === 'starting' || status === 'running'

  return {
    bus,
    getActiveRunByAgentId: (_workspaceId: string, agentId: string) => {
      for (const run of runs.values()) {
        if (run.agentId === agentId && isActiveStatus(run.status)) return { ...run }
      }
      return undefined
    },
    getPtyOutputBus: () => bus,
    publish: (chunk: string) => {
      for (const run of runs.values()) {
        if (!isActiveStatus(run.status)) continue
        // Mirrors the real PTY: first output means the process is live.
        run.status = 'running'
        bus.publish(run.runId, chunk)
      }
    },
    setHooks: (hooks: { onRunStarted?: typeof onRunStarted; onRunExited?: typeof onRunExited }) => {
      onRunStarted = hooks.onRunStarted
      onRunExited = hooks.onRunExited
    },
    startAgent: async (workspace: WorkspaceSummary, agentId: string) => {
      const run: LiveRun = {
        agentId,
        exitCode: null,
        output: '',
        pid: 4242,
        runId: `run-${++runIdCounter}`,
        startedAt: Date.now(),
        status: options.startReturnsRunning ? 'running' : 'starting',
      }
      runs.set(run.runId, run)
      // Mirrors the real runtime: the starter fires onRunStarted after the
      // live run is registered.
      onRunStarted?.(run.runId, agentId, workspace.id, run.startedAt, run.pid)
      return { ...run }
    },
    stopAgentRun: (runId: string, exitCode = 0) => {
      const run = runs.get(runId)
      if (!run) return
      run.status = exitCode === 0 ? 'exited' : 'error'
      run.exitCode = exitCode
      const endedAt = Date.now()
      // Mirrors the real runtime: exit handling fires onRunExited, which
      // removes the run from the active set.
      runs.delete(runId)
      onRunExited?.(runId, run.agentId, 'ws-1', exitCode, endedAt)
    },
    waitForAgentRunExit: async () => {},
    _setActive: (run: LiveRun) => {
      runs.set(run.runId, { ...run })
    },
    _removeActive: (runId: string) => {
      runs.delete(runId)
    },
  }
}

const wireHooks = (
  runtime: ReturnType<typeof createFakeAgentRuntime>,
  supervisor: ReturnType<typeof createRuntimeSupervisor>
) => {
  runtime.setHooks({
    onRunStarted: (runId, agentId, workspaceId, startedAt, pid) =>
      supervisor.handleRunStarted(runId, agentId, workspaceId, startedAt, pid),
    onRunExited: (runId, agentId, workspaceId, exitCode, endedAt) =>
      supervisor.handleRunExited(runId, agentId, workspaceId, exitCode, endedAt),
  })
}

describe('runtime supervisor (server)', () => {
  test('startAgent returns a unified run and marks starting state', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })

    expect(run).toMatchObject({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      pid: 4242,
      runtimeState: 'starting',
      lifecycleState: 'starting',
      endedAt: null,
      exitCode: null,
      lastOutput: '',
    })
    expect(run.id).toBe('run-1')
    expect(run.startedAt).toBeGreaterThan(0)
    expect(supervisor.getRun(run.id)).toBeDefined()
    expect(supervisor.getAgentRun('ws-1', 'agent-1')).toBeDefined()
  })

  test('output chunk flips starting to running and records lastOutput', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    expect(supervisor.getAgentRun('ws-1', 'agent-1')!.runtimeState).toBe('starting')

    runtime.publish('first line\n')
    const run = supervisor.getAgentRun('ws-1', 'agent-1')!
    expect(run.runtimeState).toBe('running')
    expect(run.lastOutput).toBe('first line\n')
  })

  test('heartbeat and lifecycle stores are merged into the model view', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    heartbeatStore.record('ws-1', 'agent-1', { phase: 'implementing', status: 'working' })
    lifecycleStore.transition('ws-1', 'agent-1', 'starting', { runId: 'run-1' })
    lifecycleStore.transition('ws-1', 'agent-1', 'ready')
    lifecycleStore.transition('ws-1', 'agent-1', 'working')

    const run = supervisor.getAgentRun('ws-1', 'agent-1')!
    expect(run.lifecycleState).toBe('working')
    expect(run.lastHeartbeat).toBeGreaterThan(0)
  })

  test('bindTask links the active run to the task', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(run.id, 'task-42')
    expect(supervisor.getRun(run.id)!.taskId).toBe('task-42')
  })

  test('handleRunExited completes the run and unsubscribes from output', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    runtime.stopAgentRun(run.id, 0)

    const exited = supervisor.getRun(run.id)!
    expect(exited.runtimeState).toBe('exited')
    expect(exited.exitCode).toBe(0)
    expect(exited.endedAt).toBeGreaterThan(0)

    runtime.publish('ignored after exit')
    expect(supervisor.getRun(run.id)!.lastOutput).toBe('')
    expect(supervisor.getAgentRun('ws-1', 'agent-1')).toBeUndefined()
    expect(supervisor.listActiveRuns()).toEqual([])
  })

  test('non-zero exit completes as error state', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    runtime.stopAgentRun(run.id, 1)
    expect(supervisor.getRun(run.id)!.runtimeState).toBe('error')
    expect(supervisor.getRun(run.id)!.exitCode).toBe(1)
  })

  test('getAgentRun falls back to live runtime snapshot for untracked runs', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })

    runtime._setActive({
      agentId: 'agent-9',
      exitCode: null,
      output: 'tail chunk',
      pid: 777,
      runId: 'run-9',
      startedAt: 500,
      status: 'running',
    })

    const run = supervisor.getAgentRun('ws-1', 'agent-9')!
    expect(run).toMatchObject({
      id: 'run-9',
      agentId: 'agent-9',
      pid: 777,
      runtimeState: 'running',
      lastOutput: 'tail chunk',
    })
    expect(supervisor.getRun('run-9')).toBeUndefined()
  })

  test('listActiveRuns returns only running runs sorted newest first', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    const first = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    const second = await supervisor.startAgent(workspace, 'agent-2', { gachiPort: '4010' })
    runtime.stopAgentRun(first.id, 0)

    const active = supervisor.listActiveRuns()
    expect(active.map((run) => run.id)).toEqual([second.id])
  })

  test('close unsubscribes all output listeners', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
    })
    wireHooks(runtime, supervisor)

    await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.close()

    runtime.publish('should be ignored')
    expect(supervisor.getAgentRun('ws-1', 'agent-1')!.lastOutput).toBe('')
  })

  test('releaseAgentRun success moves the owned task to review and frees the agent', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort, state } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)
    lifecycleStore.transition('ws-1', 'agent-1', 'starting', { runId: null })
    lifecycleStore.transition('ws-1', 'agent-1', 'ready')
    lifecycleStore.transition('ws-1', 'agent-1', 'working')

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(run.id, 'task-1')
    taskStorePort.addTask({ id: 'task-1', status: 'running' })

    supervisor.releaseAgentRun(run.id, {
      exitCode: 0,
      endedAt: 9000,
      reason: 'success',
    })

    expect(taskStorePort.getTask('ws-1', 'task-1')).toMatchObject({ status: 'review' })
    expect(state.agentStopped).toBe(true)
    expect(lifecycleStore.get('ws-1', 'agent-1')?.state).toBe('stopped')
    expect(supervisor.getRun(run.id)!.runtimeState).toBe('exited')
    expect(supervisor.listActiveRuns()).toEqual([])
  })

  test('releaseAgentRun crash requeues the owned task and marks the agent failed', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort, state } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)
    lifecycleStore.transition('ws-1', 'agent-1', 'starting', { runId: null })
    lifecycleStore.transition('ws-1', 'agent-1', 'ready')
    lifecycleStore.transition('ws-1', 'agent-1', 'working')

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(run.id, 'task-2')
    taskStorePort.addTask({ id: 'task-2', status: 'running' })

    supervisor.releaseAgentRun(run.id, {
      exitCode: 1,
      endedAt: 9000,
      reason: 'crash',
    })

    expect(taskStorePort.getTask('ws-1', 'task-2')).toMatchObject({ status: 'ready' })
    expect(state.agentStopped).toBe(true)
    expect(lifecycleStore.get('ws-1', 'agent-1')?.state).toBe('failed')
    expect(supervisor.getRun(run.id)!.runtimeState).toBe('error')
  })

  test('releaseAgentRun falls back to the assigned task when the run is not bound', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { releasedTaskIds, workspaceStorePort, taskStorePort } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    taskStorePort.assignedTask = { id: 'task-3', status: 'running' }

    supervisor.releaseAgentRun(run.id, { exitCode: 1, endedAt: 9000, reason: 'crash' })

    expect(releasedTaskIds).toContain('task-3')
  })

  test('releaseAgentRun is idempotent and skips a stale exit when a newer run is active', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort, state } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)
    lifecycleStore.transition('ws-1', 'agent-1', 'starting', { runId: null })
    lifecycleStore.transition('ws-1', 'agent-1', 'ready')
    lifecycleStore.transition('ws-1', 'agent-1', 'working')

    const first = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    taskStorePort.addTask({ id: 'task-4', status: 'running' })
    taskStorePort.assignedTask = { id: 'task-4', status: 'running' }

    // A newer run supersedes the first one; the stale exit must not touch the task.
    const second = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })

    expect(supervisor.getRun(first.id)!.runtimeState).toBe('error')
    expect(supervisor.getRun(second.id)!.runtimeState).toBe('starting')
    expect(state.agentStopped).toBe(false)
    expect(taskStorePort.getTask('ws-1', 'task-4')).toMatchObject({ status: 'running' })

    // Explicit double-release stays a no-op.
    supervisor.releaseAgentRun(first.id, { exitCode: 0, endedAt: 9000, reason: 'success' })
    expect(taskStorePort.getTask('ws-1', 'task-4')).toMatchObject({ status: 'running' })
  })

  test('a superseded exit defers its card: the orphan settles when the replacement exits unbound', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)

    const first = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(first.id, 'task-7')
    taskStorePort.addTask({ id: 'task-7', status: 'running' })

    // The replacement starts (superseding the first run) but has NOT bound
    // the card yet — the handoff delivery lands after run start, so the card
    // must stay running through the handoff window.
    const second = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    expect(taskStorePort.getTask('ws-1', 'task-7')).toMatchObject({ status: 'running' })

    // The replacement exits WITHOUT ever binding the card (e.g. a custom
    // command) — the orphaned card must not stay stuck in `running`.
    supervisor.releaseAgentRun(second.id, { exitCode: 1, endedAt: 9500, reason: 'crash' })
    expect(taskStorePort.getTask('ws-1', 'task-7')).toMatchObject({ status: 'ready' })
  })

  test('a handoff bind claims the orphaned card and the replacement settles it normally', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)

    const first = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(first.id, 'task-8')
    taskStorePort.addTask({ id: 'task-8', status: 'running' })

    const second = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    expect(taskStorePort.getTask('ws-1', 'task-8')).toMatchObject({ status: 'running' })

    // Engine switch: the replacement binds the SAME card — the handoff is
    // confirmed and the orphan entry must not requeue it.
    supervisor.bindTask(second.id, 'task-8')
    supervisor.releaseAgentRun(second.id, { exitCode: 0, endedAt: 9500, reason: 'success' })
    expect(taskStorePort.getTask('ws-1', 'task-8')).toMatchObject({ status: 'review' })
  })

  test('releaseAgentRun manual_stop requeues the task', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(run.id, 'task-5')
    taskStorePort.addTask({ id: 'task-5', status: 'running' })

    supervisor.releaseAgentRun(run.id, {
      exitCode: null,
      endedAt: 9000,
      reason: 'manual_stop',
    })

    expect(taskStorePort.getTask('ws-1', 'task-5')).toMatchObject({ status: 'ready' })
  })

  test('healthCheck classifies HEALTHY/SUSPECTED/STUCK/DEAD/NOT_RUNNING', async () => {
    const { heartbeatStore, lifecycleStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      healthyHeartbeatMaxAgeMs: 100,
      stuckHeartbeatMaxAgeMs: 200,
    })
    wireHooks(runtime, supervisor)

    expect(supervisor.healthCheck('ws-1', 'agent-9').status).toBe('NOT_RUNNING')

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    heartbeatStore.record('ws-1', 'agent-1', { status: 'working', phase: 'x' })
    expect(supervisor.healthCheck('ws-1', 'agent-1').status).toBe('HEALTHY')

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(supervisor.healthCheck('ws-1', 'agent-1').status).toBe('SUSPECTED')

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(supervisor.healthCheck('ws-1', 'agent-1').status).toBe('STUCK')

    // Simulate a process that died without the exit event: the run record is
    // still tracked as active but the live runtime no longer owns it.
    runtime._removeActive(run.id)
    expect(supervisor.healthCheck('ws-1', 'agent-1').status).toBe('DEAD')
  })

  test('reconcile fails orphaned active runs and requeues their tasks', async () => {
    const { heartbeatStore, lifecycleStore, recordStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort, state } = createPorts('agent-1')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      recordStore,
      taskStorePort,
      workspaceStorePort,
    })
    wireHooks(runtime, supervisor)

    const run = await supervisor.startAgent(workspace, 'agent-1', { gachiPort: '4010' })
    supervisor.bindTask(run.id, 'task-6')
    taskStorePort.addTask({ id: 'task-6', status: 'running' })

    // Simulate a crash/restart: a fresh runtime has no live process for the
    // persisted run, and the model is rebuilt from the record store.
    supervisor.close()
    const restartedRuntime = createFakeAgentRuntime()
    const restarted = createRuntimeSupervisor({
      agentRuntime: restartedRuntime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      recordStore,
      taskStorePort,
      workspaceStorePort,
    })
    restarted.reconcile()

    expect(taskStorePort.getTask('ws-1', 'task-6')).toMatchObject({ status: 'ready' })
    expect(state.agentStopped).toBe(true)
    expect(restarted.listActiveRuns()).toEqual([])
    expect(restarted.getRunHistory().some((entry) => entry.id === run.id)).toBe(true)
  })

  test('reconcile completes legacy active runs that lack a workspace mapping', () => {
    const { db, heartbeatStore, lifecycleStore, recordStore } = createStores()
    const runtime = createFakeAgentRuntime()
    const { workspaceStorePort, taskStorePort } = createPorts('agent-legacy')
    const supervisor = createRuntimeSupervisor({
      agentRuntime: runtime,
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      recordStore,
      taskStorePort,
      workspaceStorePort,
    })

    // Pre-schema-v23 rows carry a NULL workspace_id; reconcile must complete
    // them without trying to dispatch/free through a missing workspace.
    const now = Date.now()
    db.prepare(
      `INSERT INTO agent_runs (run_id, agent_id, workspace_id, task_id, pid, status, started_at, created_at, updated_at)
       VALUES ('run-legacy', 'agent-legacy', NULL, NULL, 1, 'running', ?, ?, ?)`
    ).run(now, now, now)

    expect(() => supervisor.reconcile()).not.toThrow()
    expect(supervisor.listActiveRuns()).toEqual([])
  })
})

interface FakeTask {
  id: string
  status: string
}

interface FakePorts {
  addTask: (task: FakeTask) => void
  assignedTask?: FakeTask | undefined
  releasedTaskIds: string[]
  state: { agentStopped: boolean }
  taskStorePort: {
    addTask: (task: FakeTask) => void
    assignedTask: FakeTask | undefined
    getAssignedTaskForWorker: () => FakeTask | undefined
    getTask: (workspaceId: string, taskId: string) => FakeTask | undefined
    releaseTask: (workspaceId: string, taskId: string) => void
    updateTask: (workspaceId: string, taskId: string, updates: { status: string }) => void
  }
  workspaceStorePort: {
    getAgent: (workspaceId: string, agentId: string) => AgentSummary
    hasAgent: (workspaceId: string, agentId: string) => boolean
    markAgentStopped: (workspaceId: string, agentId: string) => void
  }
}

const createPorts = (agentId: string): FakePorts => {
  const tasks = new Map<string, FakeTask>()
  const state = { agentStopped: false }
  const releasedTaskIds: string[] = []
  let assignedTask: FakeTask | undefined
  return {
    addTask(task) {
      tasks.set(task.id, task)
    },
    releasedTaskIds,
    state,
    get assignedTask() {
      return assignedTask
    },
    set assignedTask(value) {
      assignedTask = value
    },
    taskStorePort: {
      addTask(task) {
        tasks.set(task.id, task)
      },
      get assignedTask() {
        return assignedTask
      },
      set assignedTask(value) {
        assignedTask = value
      },
      getAssignedTaskForWorker() {
        return assignedTask
      },
      getTask(_workspaceId, taskId) {
        return tasks.get(taskId)
      },
      releaseTask(_workspaceId, taskId) {
        releasedTaskIds.push(taskId)
        const task = tasks.get(taskId)
        if (task) task.status = 'ready'
      },
      updateTask(_workspaceId, taskId, updates) {
        const task = tasks.get(taskId)
        if (task) task.status = updates.status
      },
    },
    workspaceStorePort: {
      getAgent: (_workspaceId, id) =>
        ({
          id,
          name: 'worker',
          pendingTaskCount: 0,
          role: 'coder',
          status: 'working',
          workspaceId: _workspaceId,
        }) as AgentSummary,
      hasAgent: (_workspaceId, id) => id === agentId,
      markAgentStopped() {
        state.agentStopped = true
      },
    },
  }
}
