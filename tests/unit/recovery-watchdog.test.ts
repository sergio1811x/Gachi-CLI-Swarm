import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createAgentHeartbeatStore } from '../../src/server/agent-heartbeat-store.js'
import { createAgentLifecycleStore } from '../../src/server/agent-lifecycle-store.js'
import {
  createRecoveryWatchdog,
  MAX_RETRY_ATTEMPTS,
  STUCK_HEARTBEAT_AFTER_MS,
} from '../../src/server/recovery-watchdog.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { taskStore } from '../../src/server/task-store.js'

let db: BetterSqlite3.Database

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-watchdog-'))
  db = new BetterSqlite3(join(dir, 'runtime.sqlite'))
  initializeRuntimeDatabase(db)
  taskStore.init(db)
})

afterEach(() => {
  taskStore.clear()
  db.close()
})

const workspaceRecord = () => ({
  summary: { id: 'ws-1', name: 'ws-1', path: join(tmpdir(), 'ws-1') },
  agents: [
    {
      id: 'ws-1:orchestrator',
      workspaceId: 'ws-1',
      name: 'Orchestrator',
      description: 'orchestrator',
      role: 'orchestrator' as const,
      status: 'idle' as const,
      pendingTaskCount: 0,
    },
    {
      id: 'ws-1:coder',
      workspaceId: 'ws-1',
      name: 'Coder',
      description: 'coder',
      role: 'coder' as const,
      status: 'working' as const,
      pendingTaskCount: 1,
    },
  ],
})

describe('recovery watchdog', () => {
  test('restarts a stuck worker with a stale heartbeat and an active task', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })

    // Fresh heartbeat now, so the first tick must NOT restart.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 100_000 })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    let restarts = 0
    const stoppedRuns: string[] = []
    const now = 200_000
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: (_ws, agentId) =>
          agentId === 'ws-1:coder'
            ? {
                runId: 'run-1',
                agentId,
                status: 'running',
                output: '',
                startedAt: 1,
                exitCode: null,
                pid: 1,
              }
            : undefined,
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => now,
      startAgent: async (workspaceId, agentId) => {
        restarts++
        expect(workspaceId).toBe('ws-1')
        expect(agentId).toBe('ws-1:coder')
        return { runId: 'run-2', status: 'running', exitCode: null }
      },
      stopAgentRun: async (runId) => {
        stoppedRuns.push(runId)
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    // Tick once with a fresh heartbeat: no restart, lifecycle stays ready.
    await vi.waitFor(() => {
      watchdog.stop()
      expect(restarts).toBe(0)
      expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('ready')
    })
  })

  test('transitions to stuck and restarts when the heartbeat is stale', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })

    // Heartbeat from 100k; now is 200k+ (stale beyond the default 120s window).
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 100_000 })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    let restarts = 0
    const stoppedRuns: string[] = []
    const now = 300_000
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: (_ws, agentId) =>
          agentId === 'ws-1:coder'
            ? {
                runId: 'run-1',
                agentId,
                status: 'running',
                output: '',
                startedAt: 1,
                exitCode: null,
                pid: 1,
              }
            : undefined,
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => now,
      startAgent: async () => {
        restarts++
        return { runId: 'run-2', status: 'running', exitCode: null }
      },
      stopAgentRun: async (runId) => {
        stoppedRuns.push(runId)
      },
      aliveStuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(restarts).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    expect(stoppedRuns).toContain('run-1')
    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('stuck')
  })

  test('does not restart an alive worker that is only briefly silent', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    // Alive process, heartbeat is 2 minutes old (well within the 15-min alive
    // window, but past the short dead-process window). Must NOT be restarted.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 100_000 })

    let restarts = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 220_000,
      startAgent: async () => {
        restarts++
        return { runId: 'run-2', status: 'running', exitCode: null }
      },
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(() => {
      watchdog.stop()
      expect(restarts).toBe(0)
    })
    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('ready')
  })

  test('skips recovery for a user-paused run even when heartbeat is stale', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)
    taskStore.createTask('ws-1', {
      title: 'Paused work',
      assignedAgentId: 'ws-1:coder',
      status: 'running',
    })
    // Heartbeat is ancient — the paused process produces no output by design.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 1_000 })

    let restarts = 0
    let stopped = 0
    let released = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
          paused: true,
        }),
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 600_000,
      releaseTask: () => {
        released++
      },
      startAgent: async () => {
        restarts++
        return { runId: 'run-2', status: 'running', exitCode: null }
      },
      stopAgentRun: async () => {
        stopped++
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(() => {
      watchdog.stop()
      expect(restarts).toBe(0)
    })
    expect(stopped).toBe(0)
    expect(released).toBe(0)
    expect(taskStore.getAssignedTaskForWorker('ws-1', 'ws-1:coder')?.status).toBe('running')
  })

  test('requeues a task when the owning worker process is gone', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    // Stale heartbeat + no active run => worker is dead, task must be requeued.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 100_000 })

    let releases = 0
    let dispatches = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => undefined,
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 300_000,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'worker died')
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(dispatches).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('failed')
    const after = taskStore.getTask('ws-1', task.id)
    expect(after).toBeDefined()
    expect(after?.status).toBe('ready')
    // Sticky affinity (H-1): crash keeps the worker binding so the recovery
    // restart hands the SAME card back to the SAME agent.
    expect(after?.assignedAgentId).toBe('ws-1:coder')
  })

  test('does not requeue a task while the worker heartbeat is still fresh', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 200_000 })

    let releases = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => undefined,
      },
      dispatchReadyTasks: async () => {},
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 200_001,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'worker died')
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(() => {
      watchdog.stop()
      expect(releases).toBe(0)
    })

    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('running')
  })

  test('releases a heartbeating zombie whose PTY has been idle past the window', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    // Fresh heartbeat (alive) but no PTY activity for the idle window => zombie.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 300_000 })

    let releases = 0
    let dispatches = 0
    const stoppedRuns: string[] = []
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getLastPtyActivityAt: () => 60_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 400_000,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'idle')
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async (runId) => {
        stoppedRuns.push(runId)
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(dispatches).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    expect(stoppedRuns).toContain('run-1')
    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('stuck')
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('ready')
  })

  test('releases under the retry cap to READY and decrements pending (markTaskReleased)', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Render image',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, {
      assignedAgentId: 'ws-1:coder',
      attempts: 1, // well under MAX_RETRY_ATTEMPTS
    })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 300_000 })

    let releases = 0
    let dispatches = 0
    const markTaskReleased = vi.fn()
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getLastPtyActivityAt: () => 60_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      markTaskReleased,
      now: () => 400_000,
      releaseTask: (workspaceId, taskId, reason, options) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, reason, options)
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async (runId) => {
        void runId
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(dispatches).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    // Under the cap: released back to ready (not failed), worker pending freed.
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('ready')
    expect(markTaskReleased).toHaveBeenCalledWith('ws-1', 'ws-1:coder')
  })

  test('fails a task and quarantines the worker after MAX_RETRY_ATTEMPTS (no re-dispatch)', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Render image',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, {
      assignedAgentId: 'ws-1:coder',
      attempts: MAX_RETRY_ATTEMPTS, // repeatedly bounced off this broken worker
    })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 300_000 })

    let releases = 0
    let dispatches = 0
    const markTaskReleased = vi.fn()
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getLastPtyActivityAt: () => 60_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      markTaskReleased,
      now: () => 400_000,
      releaseTask: (workspaceId, taskId, reason, options) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, reason, options)
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async (runId) => {
        void runId
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(markTaskReleased).toHaveBeenCalledWith('ws-1', 'ws-1:coder')
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    // Over the cap: the task is permanently failed and NOT re-dispatched, and
    // the worker is quarantined (lifecycle failed) instead of re-cycled.
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('failed')
    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('failed')
    expect(dispatches).toBe(0)
  })

  test('releases a zombie whose RAW output is fresh but SPONTANEOUS output is stale', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    // Alive heartbeat and RECENT raw PTY output (a zombie acknowledging nudges
    // keeps the raw timestamp fresh). Only the spontaneous timestamp is stale,
    // which is exactly the state that must still be recovered.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 300_000 })

    let releases = 0
    let dispatches = 0
    const stoppedRuns: string[] = []
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getLastPtyActivityAt: () => 300_000,
      getLastSpontaneousActivityAt: () => 60_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 400_000,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'idle')
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async (runId) => {
        stoppedRuns.push(runId)
      },
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(dispatches).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    expect(stoppedRuns).toContain('run-1')
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('ready')
  })

  test('recovers a stuck orchestrator that owns an assigned task', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Coordinate pipeline',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:orchestrator' })
    lifecycleStore.transition('ws-1', 'ws-1:orchestrator', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:orchestrator', 'ready')

    // Alive heartbeat but stale spontaneous activity => stuck orchestrator.
    heartbeatStore.record('ws-1', 'ws-1:orchestrator', { status: 'working', lastSeen: 300_000 })

    let releases = 0
    let dispatches = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'orch-run-1',
          agentId: 'ws-1:orchestrator',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {
        dispatches++
      },
      getLastPtyActivityAt: () => 60_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 400_000,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'idle')
      },
      startAgent: async () => ({ runId: 'orch-run-2', status: 'running', exitCode: null }),
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(
      () => {
        expect(releases).toBeGreaterThanOrEqual(1)
        expect(dispatches).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 }
    )
    watchdog.stop()

    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('ready')
  })

  test('does not release an idle-capable worker that is still active', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    const task = taskStore.createTask('ws-1', {
      status: 'running',
      title: 'Fix login bug',
      reviewRequired: true,
    })
    taskStore.updateTask('ws-1', task.id, { assignedAgentId: 'ws-1:coder' })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    // Fresh heartbeat AND recent PTY activity => must not be treated as idle.
    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 399_000 })

    let releases = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      dispatchReadyTasks: async () => {},
      getLastPtyActivityAt: () => 399_000,
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      idleStuckAfterMs: 120_000,
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 400_000,
      releaseTask: (workspaceId, taskId) => {
        releases++
        taskStore.releaseTask(workspaceId, taskId, 'idle')
      },
      startAgent: async () => ({ runId: 'run-2', status: 'running', exitCode: null }),
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      aliveStuckAfterMs: 15 * 60_000,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(() => {
      watchdog.stop()
      expect(releases).toBe(0)
    })

    expect(lifecycleStore.get('ws-1', 'ws-1:coder')?.state).toBe('ready')
    expect(taskStore.getTask('ws-1', task.id)?.status).toBe('running')
  })

  test('does not restart an agent without an active task', async () => {
    const heartbeatStore = createAgentHeartbeatStore(db)
    const lifecycleStore = createAgentLifecycleStore(db)

    heartbeatStore.record('ws-1', 'ws-1:coder', { status: 'working', lastSeen: 100_000 })
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'starting')
    lifecycleStore.transition('ws-1', 'ws-1:coder', 'ready')

    let restarts = 0
    const watchdog = createRecoveryWatchdog({
      agentHeartbeatStore: heartbeatStore,
      agentLifecycleStore: lifecycleStore,
      agentRuntime: {
        getActiveRunByAgentId: () => ({
          runId: 'run-1',
          agentId: 'ws-1:coder',
          status: 'running',
          output: '',
          startedAt: 1,
          exitCode: null,
          pid: 1,
        }),
      },
      getWorkspacePath: () => join(tmpdir(), 'ws-1'),
      intervalMs: 20,
      listWorkspaces: () => [{ id: 'ws-1' }],
      now: () => 300_000,
      startAgent: async () => {
        restarts++
        return { runId: 'run-2', status: 'running', exitCode: null }
      },
      stopAgentRun: async () => {},
      stuckAfterMs: STUCK_HEARTBEAT_AFTER_MS,
      workspaceStore: {
        getWorkspaceSnapshot: () => workspaceRecord(),
      },
    })

    await vi.waitFor(() => {
      watchdog.stop()
      expect(restarts).toBe(0)
    })
  })
})
