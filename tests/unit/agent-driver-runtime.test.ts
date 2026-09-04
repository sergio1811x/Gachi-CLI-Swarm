import { describe, expect, test, vi } from 'vitest'

import { createPtyAgentDriver } from '../../src/server/agent-driver-runtime.js'
import type {
  AgentManager,
  AgentRunSnapshot,
  StartAgentInput,
} from '../../src/server/agent-manager.js'

const launch: StartAgentInput = {
  agentId: 'worker-1',
  command: 'node',
  cwd: 'C:/workspace',
}

const snapshot: AgentRunSnapshot = {
  agentId: 'worker-1',
  exitCode: null,
  output: '',
  pid: 42,
  runId: 'run-1',
  status: 'running',
}

const createManager = (run = snapshot) =>
  ({
    getOutputBus: vi.fn(),
    getRun: vi.fn(() => run),
    pauseRun: vi.fn(),
    removeRun: vi.fn(),
    resizeRun: vi.fn(),
    resumeRun: vi.fn(),
    startAgent: vi.fn(async () => snapshot),
    stopRun: vi.fn(),
    writeInput: vi.fn(),
  }) as unknown as AgentManager

describe('PTY agent driver', () => {
  test('owns start, stop, restart, message delivery and checkpoint restore', async () => {
    const manager = createManager()
    const driver = createPtyAgentDriver(manager)

    expect(driver.captureState('run-1')).toBe(snapshot)
    expect(driver.healthCheck('run-1')).toEqual({ healthy: true, status: 'running' })
    expect(driver.createCheckpoint('run-1', launch)).toEqual({ launch, snapshot })

    driver.sendMessage('run-1', 'hello')
    driver.stop('run-1')
    await driver.restart('run-1', launch)
    await driver.restoreState({ launch, snapshot })

    expect(manager.writeInput).toHaveBeenCalledWith('run-1', 'hello')
    expect(manager.stopRun).toHaveBeenCalledTimes(2)
    expect(manager.startAgent).toHaveBeenCalledTimes(2)
    expect(manager.startAgent).toHaveBeenLastCalledWith(launch)
  })

  test('reports exited and failed runs as unhealthy', () => {
    const manager = createManager({ ...snapshot, status: 'exited' })

    expect(createPtyAgentDriver(manager).healthCheck('run-1')).toEqual({
      healthy: false,
      status: 'exited',
    })
  })
})
