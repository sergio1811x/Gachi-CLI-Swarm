import type { AgentSummary } from '../shared/types.js'

export const DEFAULT_MAX_CONCURRENT_WORKERS = 4

export const countActiveWorkers = (agents: AgentSummary[]) =>
  agents.filter((agent) => agent.role !== 'orchestrator' && agent.status === 'working').length

export const hasWorkerCapacity = (
  agents: AgentSummary[],
  maxConcurrentWorkers = DEFAULT_MAX_CONCURRENT_WORKERS
) => countActiveWorkers(agents) < maxConcurrentWorkers
