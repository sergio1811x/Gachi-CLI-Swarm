import type { AgentSummary } from '../shared/types.js'
import type { TaskRecord } from './task-store.js'
import { healthScoreBonus } from './worker-health.js'

const isAvailable = (agent: AgentSummary, isStartable?: (agentId: string) => boolean) =>
  agent.role !== 'orchestrator' && (agent.status !== 'stopped' || isStartable?.(agent.id) === true)

const skillScore = (agent: AgentSummary, requiredSkills: string[]) => {
  const description = agent.description.toLocaleLowerCase()
  return requiredSkills.reduce(
    (score, skill) => score + (description.includes(skill.toLocaleLowerCase()) ? 20 : 0),
    0
  )
}

const hasRequiredSkills = (agent: AgentSummary, requiredSkills: string[]) => {
  const description = agent.description.toLocaleLowerCase()
  return requiredSkills.every((skill) => description.includes(skill.toLocaleLowerCase()))
}

export const selectWorkerForTask = (
  task: TaskRecord,
  agents: AgentSummary[],
  isStartable?: (agentId: string) => boolean,
  getHealth?: (agentId: string) => number | null
) =>
  agents
    .filter(
      (agent) => isAvailable(agent, isStartable) && hasRequiredSkills(agent, task.requiredSkills)
    )
    .map((agent) => ({
      agent,
      score:
        (task.role && task.role === agent.role ? 100 : 0) +
        skillScore(agent, task.requiredSkills) -
        agent.pendingTaskCount * 10 -
        (agent.status === 'working' ? 15 : 0) +
        // R3.2: rolling health nudges selection toward reliable workers.
        healthScoreBonus(getHealth?.(agent.id) ?? null),
    }))
    .sort((left, right) => right.score - left.score || left.agent.id.localeCompare(right.agent.id))
    .at(0)?.agent
