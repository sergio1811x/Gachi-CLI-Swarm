import { describe, expect, test } from 'vitest'

import {
  createRuntimeSupervisor,
  type RuntimeSupervisorDeps,
} from '../../src/server/runtime-supervisor.js'

/**
 * R3: a classified failure (rate-limit) stamps a backoff window on the task
 * and journals it. The dispatcher-side filter lives in queue-engine.
 */

const RATE_LIMIT_OUTPUT = [
  '⏺ Attempting request…',
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  'Request was rate limited',
].join('\n')

const buildFixture = () => {
  const journal: string[] = []
  const updates: Array<Record<string, unknown>> = []

  const deps = {
    agentHeartbeatStore: { get: () => undefined, record: () => {} },
    agentLifecycleStore: { get: () => undefined, transition: () => {} },
    recordStore: undefined,
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
      getLiveRun: (runId: string) => ({
        id: runId,
        agentId: 'worker-a',
        workspaceId: 'ws1',
        status: 'running',
        runtimeState: 'running',
        exitCode: null,
        output: RATE_LIMIT_OUTPUT,
        startedAt: Date.now(),
        taskId: 'task-rl',
        pid: null,
      }),
      getPtyOutputBus: () => ({ subscribe: () => () => {} }),
      stopAgentRun: () => {},
      waitForAgentRunExit: async () => {},
    } as never,
    workspaceStorePort: {
      hasAgent: () => true,
      markAgentStopped: () => {},
      getAgent: () => undefined,
    },
    taskStorePort: {
      getAssignedTaskForWorker: (_wsId: string, agentId: string) =>
        ({
          id: 'task-rl',
          status: 'running',
          title: 'rate limited work',
          assignedAgentId: agentId,
          dependencies: [],
          requiredSkills: [],
          priority: 'normal',
          attempts: 0,
          logs: [],
          comments: [],
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as never,
      getTask: (_wsId: string, taskId: string) =>
        ({
          id: taskId,
          status: 'running',
        }) as never,
      releaseTask: () => {},
      updateTask: (_wsId: string, _taskId: string, payload: Record<string, unknown>) => {
        updates.push(payload)
      },
      addTaskLog: (_wsId: string, _taskId: string, message: string) => {
        journal.push(message)
      },
    },
    autoPr: {
      isEnabled: () => false,
      publishBranch: () => ({ error: 'disabled' }) as never,
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return { journal, supervisor, updates }
}

describe('supervisor failure backoff wiring (R3)', () => {
  test('a rate-limited exit stamps nextRetryAt and journals the retry window', () => {
    const { journal, supervisor, updates } = buildFixture()
    supervisor.handleRunStarted('run-1', 'worker-a', 'ws1', Date.now(), null)

    supervisor.handleRunExited('run-1', 'worker-a', 'ws1', 1, Date.now())

    const stamped = updates.find((u) => typeof u.nextRetryAt === 'number') as
      | { nextRetryAt: number; lastFailureCategory?: string; status?: string }
      | undefined

    expect(stamped).toBeDefined()
    expect(stamped?.lastFailureCategory).toBe('rate-limit')
    expect(stamped?.status).toBe('ready')
    expect(stamped?.nextRetryAt).toBeGreaterThan(Date.now())

    expect(journal.some((e) => e.includes('[RUN FAILED] rate-limit'))).toBe(true)
    expect(journal.some((e) => e.startsWith('[RETRY rate-limit in'))).toBe(true)
  })

  test('a plain crash does not schedule any backoff', () => {
    const { journal, updates } = buildFixtureSafe()
    // Output that does NOT match any policy class.
    void journal
    expect(updates.every((u) => u.nextRetryAt === undefined)).toBe(true)
  })
})

/** Variant with non-matching output to pin the immediate-retry behavior. */
const buildFixtureSafe = () => {
  const fixture = buildFixtureWithOutput('worker exited unexpectedly')
  return fixture
}

function buildFixtureWithOutput(output: string) {
  const journal: string[] = []
  const updates: Array<Record<string, unknown>> = []

  const deps = {
    agentHeartbeatStore: { get: () => undefined, record: () => {} },
    agentLifecycleStore: { get: () => undefined, transition: () => {} },
    recordStore: undefined,
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
      getLiveRun: (runId: string) => ({
        id: runId,
        agentId: 'worker-a',
        workspaceId: 'ws1',
        status: 'running',
        runtimeState: 'running',
        exitCode: null,
        output,
        startedAt: Date.now(),
        taskId: 'task-crash',
        pid: null,
      }),
      getPtyOutputBus: () => ({ subscribe: () => () => {} }),
      stopAgentRun: () => {},
      waitForAgentRunExit: async () => {},
    } as never,
    workspaceStorePort: {
      hasAgent: () => true,
      markAgentStopped: () => {},
      getAgent: () => undefined,
    },
    taskStorePort: {
      getAssignedTaskForWorker: () =>
        ({
          id: 'task-crash',
          status: 'running',
          title: 'plain crash work',
          dependencies: [],
          requiredSkills: [],
          priority: 'normal',
          attempts: 0,
          logs: [],
          comments: [],
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as never,
      getTask: (_wsId: string, taskId: string) => ({ id: taskId, status: 'running' }) as never,
      releaseTask: () => {},
      updateTask: (_wsId: string, _taskId: string, payload: Record<string, unknown>) => {
        updates.push(payload)
      },
      addTaskLog: (_wsId: string, _taskId: string, message: string) => {
        journal.push(message)
      },
    },
    autoPr: {
      isEnabled: () => false,
      publishBranch: () => ({ error: 'disabled' }) as never,
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  supervisor.handleRunStarted('run-1', 'worker-a', 'ws1', Date.now(), null)
  supervisor.handleRunExited('run-1', 'worker-a', 'ws1', 137, Date.now())
  return { journal, updates }
}
