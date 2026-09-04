import { describe, expect, test } from 'vitest'

import {
  createRuntimeSupervisor,
  type RuntimeSupervisorDeps,
} from '../../src/server/runtime-supervisor.js'

const RATE_LIMIT_OUTPUT = 'API Error: 429 rate_limit_error'
const CLI_MISSING_OUTPUT = 'bash: claude: command not found'
const AUTH_OUTPUT = 'Invalid API key · Please run /login to authenticate'
const NEUTRAL_CRASH_OUTPUT = 'worker exited unexpectedly'

/**
 * R3.3: workers whose failure is `cli-missing` or `auth` are benched (launch
 * config cleared) so the dispatcher stops selecting them until a human fixes
 * the environment. Any other category must NOT bench.
 */

const buildFixture = (output: string, exitCode: number) => {
  const journal: string[] = []
  const disableCalls: Array<{ agentId: string; reason: string }> = []
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
        taskId: 'task-1',
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
          id: 'task-1',
          status: 'running',
          title: 'work',
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
    disableWorker: (workspaceId: string, agentId: string, reason: string) => {
      void workspaceId
      disableCalls.push({ agentId, reason })
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return {
    journal,
    updates,
    disableCalls,
    runExit: () => {
      supervisor.handleRunStarted('run-1', 'worker-a', 'ws1', Date.now(), null)
      supervisor.handleRunExited('run-1', 'worker-a', 'ws1', exitCode, Date.now())
    },
  }
}

describe('auto-disable worker on environment failures (R3.3)', () => {
  test('cli-missing benches the worker and journals the reason', () => {
    const fx = buildFixture(CLI_MISSING_OUTPUT, 127)
    fx.runExit()
    expect(fx.disableCalls).toEqual([{ agentId: 'worker-a', reason: 'cli-missing' }])
    expect(fx.journal.some((e) => e.startsWith('[WORKER DISABLED]'))).toBe(true)
  })

  test('auth failure benches the worker too', () => {
    const fx = buildFixture(AUTH_OUTPUT, 1)
    fx.runExit()
    expect(fx.disableCalls).toHaveLength(1)
    expect(fx.disableCalls[0]?.reason).toBe('auth')
  })

  test('rate-limit backoff does NOT bench the worker', () => {
    const fx = buildFixture(RATE_LIMIT_OUTPUT, 1)
    fx.runExit()
    expect(fx.disableCalls).toHaveLength(0)
    // Backoff still applies.
    expect(fx.updates.some((u) => u.lastFailureCategory === 'rate-limit')).toBe(true)
  })

  test('neutral crash does not bench the worker', () => {
    const fx = buildFixture(NEUTRAL_CRASH_OUTPUT, 137)
    fx.runExit()
    expect(fx.disableCalls).toHaveLength(0)
  })
})
