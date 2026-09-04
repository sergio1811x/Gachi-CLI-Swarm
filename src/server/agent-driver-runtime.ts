import type { AgentManager, AgentRunSnapshot, StartAgentInput } from './agent-manager.js'

export interface AgentDriverHealth {
  healthy: boolean
  status: AgentRunSnapshot['status']
}

export interface AgentDriverCheckpoint {
  launch: StartAgentInput
  snapshot: AgentRunSnapshot
}

/**
 * Runtime boundary for an AI agent engine. CLI-specific profiles decide how
 * input is formatted; drivers own the executable process lifecycle.
 */
export interface AgentDriverRuntime {
  captureState: (runId: string) => AgentRunSnapshot
  createCheckpoint: (runId: string, launch: StartAgentInput) => AgentDriverCheckpoint
  healthCheck: (runId: string) => AgentDriverHealth
  restoreState: (checkpoint: AgentDriverCheckpoint) => Promise<AgentRunSnapshot>
  restart: (runId: string, input: StartAgentInput) => Promise<AgentRunSnapshot>
  sendMessage: (runId: string, input: Buffer | string) => void
  start: (input: StartAgentInput) => Promise<AgentRunSnapshot>
  stop: (runId: string) => void
}

export const createPtyAgentDriver = (manager: AgentManager): AgentDriverRuntime => ({
  captureState(runId) {
    return manager.getRun(runId)
  },
  createCheckpoint(runId, launch) {
    return { launch, snapshot: manager.getRun(runId) }
  },
  healthCheck(runId) {
    const status = manager.getRun(runId).status
    return { healthy: status === 'starting' || status === 'running', status }
  },
  restoreState(checkpoint) {
    return manager.startAgent(checkpoint.launch)
  },
  async restart(runId, input) {
    manager.stopRun(runId)
    return manager.startAgent(input)
  },
  sendMessage(runId, input) {
    manager.writeInput(runId, input)
  },
  start(input) {
    return manager.startAgent(input)
  },
  stop(runId) {
    manager.stopRun(runId)
  },
})
