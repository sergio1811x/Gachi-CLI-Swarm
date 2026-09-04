import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'

import { createAgentRunRecordStore } from '../../src/server/agent-run-record-store.js'
import type { RuntimeSupervisorDeps } from '../../src/server/runtime-supervisor.js'
import {
  createRuntimeSupervisor,
  ERROR_BUDGET_THRESHOLD,
} from '../../src/server/runtime-supervisor.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

/** Minimal supervisor fixture: runs start and exit immediately with a code. */
const buildFixture = () => {
  const exceeded = vi.fn()
  const recovered = vi.fn()
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  const recordStore = createAgentRunRecordStore(db)
  const deps = {
    agentHeartbeatStore: { get: () => undefined, record: () => {} },
    agentLifecycleStore: { get: () => undefined, transition: () => {} },
    recordStore,
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
      getLiveRun: () => ({ output: 'boom' }),
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
      getTask: () => undefined,
      getAssignedTaskForWorker: () => undefined,
      releaseTask: () => {},
      updateTask: () => {},
      addTaskLog: () => {},
    },
    onErrorBudgetExceeded: exceeded,
    onBreakerRecovered: recovered,
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return {
    exceeded,
    recovered,
    supervisor,
    runOnce: (runId: string, exitCode: number) => {
      supervisor.handleRunStarted(runId, 'w1', 'ws1', Date.now(), null)
      supervisor.handleRunExited(runId, 'w1', 'ws1', exitCode, Date.now())
    },
  }
}

describe('workspace error budget (R10)', () => {
  test(`fires once at ${ERROR_BUDGET_THRESHOLD} consecutive failures`, () => {
    const fx = buildFixture()
    for (let i = 0; i < ERROR_BUDGET_THRESHOLD; i += 1) {
      fx.runOnce(`run-${i}`, 1)
    }
    expect(fx.exceeded).toHaveBeenCalledTimes(1)

    // Further failures do not re-fire (already past the threshold).
    fx.runOnce('run-extra', 1)
    expect(fx.exceeded).toHaveBeenCalledTimes(1)
  })

  test('a success resets the streak', () => {
    const fx = buildFixture()
    for (let i = 0; i < ERROR_BUDGET_THRESHOLD - 1; i += 1) {
      fx.runOnce(`fail-${i}`, 1)
    }
    fx.runOnce('ok-run', 0)
    // Streak restarted — one short of the budget must stay silent.
    for (let i = 0; i < ERROR_BUDGET_THRESHOLD - 1; i += 1) {
      fx.runOnce(`fail2-${i}`, 1)
    }
    expect(fx.exceeded).not.toHaveBeenCalled()
    fx.runOnce('fail-final', 1)
    expect(fx.exceeded).toHaveBeenCalledTimes(1)
  })

  test('a clean run after failures reports breaker recovery', () => {
    const fx = buildFixture()
    fx.runOnce('fail-1', 1)
    fx.runOnce('fail-2', 1)
    fx.runOnce('ok-run', 0)
    expect(fx.recovered).toHaveBeenCalledTimes(1)
    // Recovery fires only when the streak was actually non-zero.
    fx.runOnce('ok-run-2', 0)
    expect(fx.recovered).toHaveBeenCalledTimes(1)
  })

  test('breaker auto-resume halves the streak so repeated breaches re-trip', () => {
    const fx = buildFixture()
    for (let i = 0; i < ERROR_BUDGET_THRESHOLD; i += 1) {
      fx.runOnce(`run-${i}`, 1)
    }
    expect(fx.exceeded).toHaveBeenCalledTimes(1)

    // Cooldown elapsed → dispatch resumed → streak halved (5 → 2): three
    // more failures re-trip the breaker for the escalated cooldown.
    fx.supervisor.softenErrorBudget('ws1')
    for (let i = 0; i < ERROR_BUDGET_THRESHOLD - 2; i += 1) {
      fx.runOnce(`more-${i}`, 1)
    }
    expect(fx.exceeded).toHaveBeenCalledTimes(2)
  })
  test('a manual stop does not burn the error-budget streak', () => {
    const exceeded = vi.fn()
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const recordStore = createAgentRunRecordStore(db)
    const supervisor = createRuntimeSupervisor({
      agentHeartbeatStore: { get: () => undefined, record: () => {} },
      // Exit while the lifecycle reports `stopping` → reason `manual_stop`.
      agentLifecycleStore: { get: () => ({ state: 'stopping' }), transition: () => {} },
      recordStore,
      agentRuntime: {
        getActiveRunByAgentId: () => undefined,
        getLiveRun: () => ({ output: 'boom' }),
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
        getTask: () => undefined,
        getAssignedTaskForWorker: () => undefined,
        releaseTask: () => {},
        updateTask: () => {},
        addTaskLog: () => {},
      },
      onErrorBudgetExceeded: exceeded,
      onBreakerRecovered: () => {},
    } as unknown as RuntimeSupervisorDeps)

    // Even five operator-initiated stops (nonzero exit, like a hard kill after stop)
    // must NOT trip the breaker — they are infrastructure, not worker failures.

    for (let i = 0; i < ERROR_BUDGET_THRESHOLD; i += 1) {
      supervisor.handleRunStarted(`stop-${i}`, 'w1', 'ws1', Date.now(), null)
      supervisor.handleRunExited(`stop-${i}`, 'w1', 'ws1', 1, Date.now())
    }
    expect(exceeded).not.toHaveBeenCalled()
  })
})
