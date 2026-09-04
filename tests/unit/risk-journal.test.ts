import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentRunRecordStore } from '../../src/server/agent-run-record-store.js'
import type { RuntimeSupervisorDeps } from '../../src/server/runtime-supervisor.js'
import { createRuntimeSupervisor } from '../../src/server/runtime-supervisor.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const dbs: import('better-sqlite3').Database[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

const buildFixture = (runOutput: string) => {
  const db = new Database(':memory:')
  dbs.push(db)
  initializeRuntimeDatabase(db)
  const recordStore = createAgentRunRecordStore(db)
  const journal: string[] = []

  const deps = {
    agentHeartbeatStore: { get: () => undefined, record: () => {} },
    agentLifecycleStore: { get: () => undefined, transition: () => {} },
    recordStore,
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
      getLiveRun: () => ({ output: runOutput }),
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
      getAssignedTaskForWorker: () => ({ id: 'task-1', status: 'running' }) as never,
      getTask: () => undefined,
      releaseTask: () => {},
      updateTask: () => {},
      addTaskLog: (_wsId: string, _taskId: string, message: string) => {
        journal.push(message)
      },
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return {
    journal,
    runOnce: (runId: string, exitCode = 0) => {
      supervisor.handleRunStarted(runId, 'worker-a', 'ws1', Date.now(), null)
      supervisor.handleRunExited(runId, 'worker-a', 'ws1', exitCode, Date.now())
    },
  }
}

describe('[RISK] journaling on run exit (R10)', () => {
  test('risky commands land in the task journal', () => {
    const fx = buildFixture('$ git push --force origin main\nnpm publish\nall done, exit 0')
    fx.runOnce('run-risky')
    expect(fx.journal).toEqual(['[RISK] force-push, publish'])
  })

  test('clean output journals nothing', () => {
    const fx = buildFixture('rm -rf node_modules\ngit commit -m "feat"\n')
    fx.runOnce('run-clean')
    expect(fx.journal).toHaveLength(0)
  })
})
