import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import { createTeamOperations } from '../../src/server/team-operations.js'

afterEach(() => {
  taskStore.clear()
  vi.restoreAllMocks()
})

describe('team atomicity', () => {
  const makeDispatch = (overrides: Record<string, unknown> = {}) => ({
    artifacts: [],
    createdAt: Date.now() - 10 * 60_000,
    deliveredAt: null,
    fromAgentId: 'ws-orchestrator',
    id: 'dispatch-1',
    reportedAt: null,
    reportText: null,
    sequence: 1,
    status: 'submitted',
    submittedAt: Date.now() - 5 * 60_000,
    text: 'Implement login',
    toAgentId: 'worker-1',
    workspaceId: 'ws',
    ...overrides,
  })

  test('reinjectUndeliveredDispatch replays the same dispatch id when the paste was swallowed', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = makeDispatch({ toAgentId: worker.id, fromAgentId: null })
    const writeSendPrompt = vi.fn()
    const markDispatchSubmitted = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt,
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => dispatch as never),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted,
      workspaceStore: {
        getWorker: store.getWorker,
        getAgent: store.getAgent,
      } as never,
    })

    const reinjected = ops.reinjectUndeliveredDispatch(workspace.id, worker.id, 90_000)

    expect(reinjected).toBe(true)
    // The SAME dispatch id and text are replayed — idempotent payload.
    expect(writeSendPrompt).toHaveBeenCalledWith(
      workspace.id,
      worker.id,
      dispatch.id,
      expect.any(String),
      expect.any(String),
      dispatch.text
    )
    // submittedAt is refreshed so the retry cadence stays bounded.
    expect(markDispatchSubmitted).toHaveBeenCalledWith(dispatch.id)
  })

  test('reinjectUndeliveredDispatch refuses fresh, already-delivered, or runless dispatches', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const writeSendPrompt = vi.fn()
    const baseOps = (openDispatch: unknown) =>
      createTeamOperations({
        agentRuntime: {
          getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
          writeSendPrompt,
        } as never,
        createDispatch: vi.fn(),
        deleteDispatch: vi.fn(),
        deleteMessage: vi.fn(),
        findOpenDispatch: vi.fn(() => openDispatch as never),
        insertMessage: vi.fn(() => ({ sequence: 1 })),
        markDispatchReportedByWorker: vi.fn(),
        markDispatchSubmitted: vi.fn(),
        workspaceStore: {
          getWorker: store.getWorker,
          getAgent: store.getAgent,
        } as never,
      })

    // Freshly submitted — within the grace window.
    expect(
      baseOps(makeDispatch({ submittedAt: Date.now() })).reinjectUndeliveredDispatch(
        workspace.id,
        worker.id,
        90_000
      )
    ).toBe(false)
    // Already delivered.
    expect(
      baseOps(makeDispatch({ deliveredAt: Date.now() - 1000 })).reinjectUndeliveredDispatch(
        workspace.id,
        worker.id,
        90_000
      )
    ).toBe(false)
    // No active run — the nudge cleanup owns the card instead.
    const runlessOps = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeSendPrompt,
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => makeDispatch({ toAgentId: worker.id }) as never),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        getAgent: store.getAgent,
      } as never,
    })
    expect(runlessOps.reinjectUndeliveredDispatch(workspace.id, worker.id, 90_000)).toBe(false)

    expect(writeSendPrompt).not.toHaveBeenCalled()
  })

  test('cancelTaskById cancels the bound dispatch when one is open', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    taskStore.clear()
    const card = taskStore.createTask(workspace.id, {
      title: 'Zombie render',
      status: 'running',
      assignedAgentId: worker.id,
      dispatchId: 'dispatch-9',
    })
    const markDispatchCancelled = vi.fn(() => ({
      id: 'dispatch-9',
      toAgentId: worker.id,
    }))
    const markTaskCancelled = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeCancelPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => undefined),
      findOpenDispatchById: vi.fn(() => ({ id: 'dispatch-9', toAgentId: worker.id }) as never),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        getAgent: store.getAgent,
        markTaskCancelled,
      } as never,
    })

    try {
      const result = ops.cancelTaskById(workspace.id, card.id, {
        fromAgentId: orchestrator.id,
        reason: 'obsolete',
      })
      // The open dispatch path ran (cancel-by-dispatch semantics).
      expect(markDispatchCancelled).toHaveBeenCalledWith({
        dispatchId: 'dispatch-9',
        reason: 'obsolete',
        workspaceId: workspace.id,
      })
      expect(result.taskId).toBe(card.id)
      expect(taskStore.getTask(workspace.id, card.id)?.status).toBe('canceled')
    } finally {
      taskStore.clear()
    }
  })

  test('cancelTaskById cancels a dispatch-less card directly and frees the worker', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    taskStore.clear()
    const card = taskStore.createTask(workspace.id, {
      title: 'Orphaned card',
      status: 'assigned',
      assignedAgentId: worker.id,
    })
    const markTaskCancelled = vi.fn()
    const writeCancelPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeCancelPrompt,
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => undefined),
      findOpenDispatchById: vi.fn(() => undefined),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        getAgent: store.getAgent,
        markTaskCancelled,
      } as never,
    })

    try {
      ops.cancelTaskById(workspace.id, card.id, {
        fromAgentId: orchestrator.id,
        reason: 'stale leftover',
      })
      expect(taskStore.getTask(workspace.id, card.id)?.status).toBe('canceled')
      expect(markTaskCancelled).toHaveBeenCalledWith(workspace.id, worker.id)
      expect(writeCancelPrompt).not.toHaveBeenCalled()
    } finally {
      taskStore.clear()
    }
  })

  test('deleteTaskCard removes the card and cancels its bound dispatch', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    taskStore.clear()
    const card = taskStore.createTask(workspace.id, {
      title: 'Resurrecting zombie',
      status: 'running',
      assignedAgentId: worker.id,
      dispatchId: 'dispatch-77',
    })
    const markDispatchCancelled = vi.fn(() => ({ id: 'dispatch-77', toAgentId: worker.id }))
    const markTaskCancelled = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        writeCancelPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(() => undefined),
      findOpenDispatchById: vi.fn(() => ({ id: 'dispatch-77', toAgentId: worker.id }) as never),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        getAgent: store.getAgent,
        markTaskCancelled,
      } as never,
    })

    try {
      const deleted = ops.deleteTaskCard(workspace.id, card.id, {
        fromAgentId: orchestrator.id,
        reason: 'purge zombie',
      })
      expect(deleted).toBe(true)
      // The card is gone — reconcile can no longer resurrect it.
      expect(taskStore.getTask(workspace.id, card.id)).toBeUndefined()
      expect(markDispatchCancelled).toHaveBeenCalled()
      expect(markTaskCancelled).toHaveBeenCalledWith(workspace.id, worker.id)
      expect(
        ops.deleteTaskCard(workspace.id, card.id, {
          fromAgentId: orchestrator.id,
          reason: 'again',
        })
      ).toBe(false)
    } finally {
      taskStore.clear()
    }
  })

  test('board delete survives reconcile: bound dispatch is cancelled with the card', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    taskStore.clear()

    try {
      // A real dispatch creates the card + ledger row.
      await store.dispatchTask(workspace.id, worker.id, 'Render zombie')
      const card = taskStore.getAssignedTaskForWorker(workspace.id, worker.id)
      expect(card).toBeDefined()
      expect(card?.dispatchId).toBeTruthy()

      // Board delete goes through deleteTaskCard (same as DELETE route).
      const deleted = store.deleteTaskCard(workspace.id, card!.id, {
        fromAgentId: orchestrator.id,
        reason: 'deleted from board',
      })
      expect(deleted).toBe(true)
      expect(taskStore.getTask(workspace.id, card!.id)).toBeUndefined()

      // Reconciliation must NOT resurrect the deleted card: its dispatch was
      // cancelled together with the card.
      const restored = store.reconcileTasksFromDispatches(workspace.id)
      expect(restored).toBe(0)
      expect(taskStore.getTask(workspace.id, card!.id)).toBeUndefined()
    } finally {
      taskStore.clear()
    }
  })

  test('startup reconcile resurrects a reported dispatch as review (not ready/running)', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Bob', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected orchestrator')
    taskStore.clear()

    try {
      await store.dispatchTask(workspace.id, worker.id, 'Reported work')
      // Worker reports against the dispatch: ledger row becomes 'reported'
      // and the card settles into review.
      await store.reportTask(workspace.id, worker.id, {
        dispatchId: taskStore.getAssignedTaskForWorker(workspace.id, worker.id)?.dispatchId,
        text: 'Done',
      })
      const card = taskStore.getAssignedTaskForWorker(workspace.id, worker.id)
      if (!card) throw new Error('Expected settled card')
      expect(card.status).toBe('review')

      // Bare delete leaves a reported dispatch behind…
      taskStore.deleteTask(workspace.id, card.id)
      expect(taskStore.getTask(workspace.id, card.id)).toBeUndefined()

      // …and reconcile brings it back as REVIEW (never straight to
      // ready/running where an idle worker would grab it).
      const restored = store.reconcileTasksFromDispatches(workspace.id)
      expect(restored).toBe(1)
      expect(taskStore.getTaskByDispatchId(workspace.id, card.dispatchId ?? '')?.status).toBe(
        'review'
      )
    } finally {
      taskStore.clear()
    }
  })

  test('dispatchTask does not bump pending count when message insert fails before PTY write', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const insertMessage = vi.fn(() => {
      throw new Error('insert message failed')
    })
    const createDispatch = vi.fn()
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const writeSendPrompt = vi.fn()
    const markTaskDispatched = vi.fn()
    const ops = createTeamOperations({
      agentRuntime: {
        writeSendPrompt,
        writeReportPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch,
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage,
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getAgent: store.getAgent,
        getWorker: store.getWorker,
        getWorkerByName: (workspaceId: string, workerName: string) => {
          const worker = store
            .getWorkspaceSnapshot(workspaceId)
            .agents.find((agent) => agent.name === workerName && agent.role !== 'orchestrator')
          if (!worker) {
            throw new Error(`Worker not found: ${workerName}`)
          }
          return worker
        },
        markTaskDispatched,
        markTaskReported: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/insert message failed/)

    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'stopped',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0)).toEqual([])
    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(insertMessage).toHaveBeenCalledTimes(1)
    expect(createDispatch).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(deleteDispatch).not.toHaveBeenCalled()
    expect(markTaskDispatched).not.toHaveBeenCalled()
  })

  test('dispatchTask deletes dispatch ledger record when worker start fails', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => undefined),
        writeReportPrompt: vi.fn(),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/No worker launch config available/)

    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 0,
        status: 'stopped',
      })
    )
  })

  test('dispatchTask revalidates worker after startup before writing stdin', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteDispatch = vi.fn()
    const deleteMessage = vi.fn()
    const markDispatchSubmitted = vi.fn()
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => undefined),
        peekAgentLaunchConfig: vi.fn(() => ({ command: 'node' })),
        startAgent: vi.fn(async () => {
          store.deleteWorker(workspace.id, worker.id)
          return { status: 'running' }
        }),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(() => dispatch),
      deleteDispatch,
      deleteMessage,
      findOpenDispatch: vi.fn(),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted,
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await expect(
      ops.dispatchTask(workspace.id, worker.id, 'Implement login', { fromAgentId: orchestrator.id })
    ).rejects.toThrow(/Agent not found|Worker not found/)

    expect(writeSendPrompt).not.toHaveBeenCalled()
    expect(markDispatchSubmitted).not.toHaveBeenCalled()
    expect(deleteDispatch).toHaveBeenCalledWith(dispatch.id)
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask with requireActiveRun throws and leaves pending count + messages untouched when orch run is absent', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    // Simulate PTY already running so dispatchTask can promote to working.
    store.getWorker(workspace.id, worker.id).status = 'idle'

    // Dispatch first so pendingTaskCount rises to 1 — gives reportTask something to decrement.
    store.dispatchTask(workspace.id, worker.id, 'Implement login')
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ status: 'queued', text: 'Implement login' })
    )
    const beforeMessages = store.listMessagesForRecovery(workspace.id, 0).length

    // Now request a report that REQUIRES an active orchestrator run. There is none,
    // so writeReportPrompt will throw. Nothing downstream (insertMessage, markTaskReported)
    // must run.
    expect(() =>
      store.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: 'Done',
        requireActiveRun: true,
      })
    ).toThrow()

    // pending count stays at 1 (no decrement), messages list unchanged.
    expect(store.listWorkers(workspace.id)).toContainEqual(
      expect.objectContaining({
        id: worker.id,
        pendingTaskCount: 1,
        status: 'working',
      })
    )
    expect(store.listMessagesForRecovery(workspace.id, 0).length).toBe(beforeMessages)
    expect(store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({
        status: 'queued',
        text: 'Implement login',
        reportText: null,
      })
    )
  })

  test('reportTask does not write orchestrator stdin when dispatch ledger update fails', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteMessage = vi.fn()
    const markTaskReported = vi.fn()
    const writeReportPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeReportPrompt,
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker: vi.fn(() => {
        throw new Error('dispatch ledger failed')
      }),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
    })

    expect(() =>
      ops.reportTask(workspace.id, worker.id, {
        requireActiveRun: true,
        status: 'success',
        text: 'Done',
      })
    ).toThrow(/dispatch ledger failed/)

    expect(writeReportPrompt).not.toHaveBeenCalled()
    expect(markTaskReported).not.toHaveBeenCalled()
    expect(deleteMessage).toHaveBeenCalledWith({ sequence: 1 })
  })

  test('reportTask settles the card and queues an orchestrator notification', () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const dispatch = {
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: `${workspace.id}:orchestrator`,
      id: 'dispatch-1',
      reportedAt: null,
      reportText: null,
      sequence: 1,
      status: 'queued',
      submittedAt: null,
      text: 'Implement login',
      toAgentId: worker.id,
      workspaceId: workspace.id,
    } as const
    const deleteMessage = vi.fn()
    const markDispatchReportedByWorker = vi.fn(() => ({ ...dispatch, status: 'reported' }))
    const markTaskReported = vi.fn()
    const pushOrchestratorUpdate = vi.fn()
    taskStore.clear()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        writeSendPrompt: vi.fn(),
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(),
      deleteDispatch: vi.fn(),
      deleteMessage,
      findOpenDispatch: vi.fn(() => dispatch),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchReportedByWorker,
      markDispatchSubmitted: vi.fn(),
      pushOrchestratorUpdate,
      workspaceStore: {
        getWorker: store.getWorker,
        markTaskReported,
      } as never,
    })

    try {
      const result = ops.reportTask(workspace.id, worker.id, {
        status: 'success',
        text: 'Done',
      })

      // The dispatch ledger records the report…
      expect(markDispatchReportedByWorker).toHaveBeenCalledWith({
        artifacts: [],
        reportText: 'Done',
        toAgentId: worker.id,
        workspaceId: workspace.id,
      })
      // …the worker is released exactly once for the settled card,
      expect(markTaskReported).toHaveBeenCalledTimes(1)
      expect(markTaskReported).toHaveBeenCalledWith(workspace.id, worker.id)
      // …nothing is rolled back,
      expect(deleteMessage).not.toHaveBeenCalled()
      // …and the orchestrator receives a push-first notification.
      expect(pushOrchestratorUpdate).toHaveBeenCalledTimes(1)
      const [, payload] = pushOrchestratorUpdate.mock.calls[0] as [string, string]
      expect(payload).toContain('@Alice')
      expect(payload).toContain('Done')
      expect(result.dispatch?.status).toBe('reported')
      expect(result.forwardError).toBeNull()
    } finally {
      taskStore.clear()
    }
  })

  test('dispatchTask pokes the worker existing task instead of creating a duplicate', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/gachi-alpha', 'Alpha')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected orchestrator')
    }

    const taskStore = (await import('../../src/server/task-store.js')).taskStore
    taskStore.clear()
    let seq = 0
    const dispatch = (input: { text: string }) => ({
      artifacts: [],
      createdAt: Date.now(),
      deliveredAt: null,
      fromAgentId: orchestrator.id,
      id: `dispatch-${++seq}`,
      reportedAt: null,
      reportText: null,
      status: 'queued' as const,
      submittedAt: null,
      text: input.text,
      toAgentId: worker.id,
      workspaceId: workspace.id,
    })
    const writeSendPrompt = vi.fn()

    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: vi.fn(() => ({ runId: 'run-1' })),
        peekAgentLaunchConfig: vi.fn(() => ({ command: 'node' })),
        startAgent: vi.fn(),
        writeReportPrompt: vi.fn(),
        writeSendPrompt,
        writeUserInputPrompt: vi.fn(),
      } as never,
      createDispatch: vi.fn(dispatch),
      deleteDispatch: vi.fn(),
      deleteDispatchForced: vi.fn(),
      deleteMessage: vi.fn(),
      findOpenDispatch: vi.fn(),
      // The poke path closes the superseded open dispatch before re-stamping
      // the card; the fake ledger starts with no open rows.
      findOpenDispatchById: vi.fn(() => undefined),
      insertMessage: vi.fn(() => ({ sequence: 1 })),
      markDispatchCancelled: vi.fn(() => undefined),
      markDispatchDelivered: vi.fn(),
      markDispatchReportedByWorker: vi.fn(),
      markDispatchSubmitted: vi.fn(),
      workspaceStore: {
        ...store,
        markAgentStarted: vi.fn(),
        markAgentStopped: vi.fn(),
      } as never,
    })

    await ops.dispatchTask(workspace.id, worker.id, 'First instruction', {
      fromAgentId: orchestrator.id,
    })
    const afterFirst = taskStore.listTasks(workspace.id)
    expect(afterFirst).toHaveLength(1)
    const firstId = afterFirst[0].id

    // A second dispatch to the SAME worker must poke the existing card, not create a new one.
    await ops.dispatchTask(workspace.id, worker.id, 'Second follow-up', {
      fromAgentId: orchestrator.id,
    })
    const afterSecond = taskStore.listTasks(workspace.id)
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0].id).toBe(firstId)
    expect(afterSecond[0].description).toContain('First instruction')
    expect(afterSecond[0].description).toContain('Second follow-up')
  })
})
