import { describe, expect, test } from 'vitest'

import {
  createRuntimeSupervisor,
  type RuntimeSupervisorDeps,
} from '../../src/server/runtime-supervisor.js'

/**
 * R4.1: after 3+ attempts with a non-transient failure class the supervisor
 * creates an incident card linked via parentTaskId and journals it. Transient
 * classes (rate-limit/quota/network) keep retrying silently.
 */

let runSeq = 0
const buildFixture = (options: { output: string; attempts: number; hasOpenIssue?: boolean }) => {
  const journal: string[] = []
  const createdIssues: Array<{ parentTaskId: string; title: string }> = []

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
        output: options.output,
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
          title: 'flaky integration suite',
          attempts: options.attempts,
          dependencies: [],
          requiredSkills: [],
          priority: 'normal',
          logs: [],
          comments: [],
          artifacts: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as never,
      getTask: (_wsId: string, taskId: string) => ({ id: taskId, status: 'running' }) as never,
      releaseTask: () => {},
      updateTask: () => {},
      addTaskLog: (_wsId: string, _taskId: string, message: string) => {
        journal.push(message)
      },
      hasOpenChildIssue: (_wsId: string, _taskId: string) => options.hasOpenIssue === true,
      createIssueCard: (_wsId: string, input: { parentTaskId: string; title: string }) => {
        createdIssues.push(input)
        return { id: 'issue-1' }
      },
    },
    disableWorker: () => {},
    autoPr: {
      isEnabled: () => false,
      publishBranch: () => ({ error: 'disabled' }) as never,
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  const errors: string[] = []
  return {
    journal,
    createdIssues,
    errors,
    runExit: () => {
      const runId = `run-${++runSeq}`
      try {
        supervisor.handleRunStarted(runId, 'worker-a', 'ws1', Date.now(), null)
      } catch (e) {
        errors.push(`started: ${e instanceof Error ? e.stack : String(e)}`)
        return
      }
      try {
        supervisor.handleRunExited(runId, 'worker-a', 'ws1', 1, Date.now())
      } catch (e) {
        errors.push(`exited: ${e instanceof Error ? e.stack : String(e)}`)
      }
    },
  }
}

describe('auto-issue on repeated non-transient failures (R4.1)', () => {
  test('3+ attempts with crash → issue card created and journaled', () => {
    const fx = buildFixture({ output: 'worker exited unexpectedly', attempts: 3 })
    fx.runExit()
    expect(fx.createdIssues).toHaveLength(1)
    expect(fx.createdIssues[0]?.parentTaskId).toBe('task-1')
    expect(fx.createdIssues[0]?.title).toContain('[ISSUE]')
    expect(fx.journal.some((e) => e.startsWith('[ISSUE CREATED] #issue-1'))).toBe(true)
  })

  test('below attempt threshold → no issue card', () => {
    const fx = buildFixture({ output: 'worker exited unexpectedly', attempts: 2 })
    fx.runExit()
    expect(fx.createdIssues).toHaveLength(0)
  })

  test('open issue already exists → not duplicated', () => {
    const fx = buildFixture({
      output: 'worker exited unexpectedly',
      attempts: 5,
      hasOpenIssue: true,
    })
    fx.runExit()
    expect(fx.createdIssues).toHaveLength(0)
  })

  test('transient category (rate-limit) never creates an issue card', () => {
    const fx = buildFixture({
      output: 'API Error: 429 rate_limit_error',
      attempts: 10,
    })
    fx.runExit()
    expect(fx.createdIssues).toHaveLength(0)
  })

  test('cli-missing benches worker AND creates issue card (human action needed)', () => {
    const fx = buildFixture({ output: 'bash: claude: command not found', attempts: 4 })
    fx.runExit()
    expect(fx.createdIssues).toHaveLength(1)
    expect(fx.createdIssues[0]?.title).toContain('cli-missing')
  })
})
