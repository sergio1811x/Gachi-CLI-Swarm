import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getGachiTeamRules } from './gachi-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1536

const formatUserInputs = (messages: RecoveryMessage[]) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs.slice(-5).map((message) => `- user: ${message.text}`)
    : ['- (no new user_input in the last hour)']
}

const formatTaskEvents = (messages: RecoveryMessage[], agent: AgentSummary) => {
  const taskEvents = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' | 'report' | 'status' }> => {
      if (agent.role === 'orchestrator') {
        if (message.type === 'send') return message.from === agent.id
        return message.type === 'report' || message.type === 'status'
      }
      if (message.type === 'send') return message.to === agent.id || message.from === agent.id
      return (message.type === 'report' || message.type === 'status') && message.from === agent.id
    }
  )
  return taskEvents.length > 0
    ? taskEvents.slice(-8).map((message) => {
        if (message.type === 'send') return `- send -> ${message.to}: ${message.text}`
        if (message.type === 'status') return `- status <- ${message.from}: ${message.text}`
        const status = message.status ? ` [${message.status}]` : ''
        return `- report <- ${message.from}${status}: ${message.text}`
      })
    : ['- (no recent task events)']
}

const getOpenTaskTargets = (agent: AgentSummary, workers: AgentSummary[]) =>
  agent.role === 'orchestrator' ? workers : [agent]

const formatOpenTasks = (
  messages: RecoveryMessage[],
  agent: AgentSummary,
  workers: AgentSummary[]
) => {
  const targetAgents = getOpenTaskTargets(agent, workers).filter(
    (target) => target.role !== 'orchestrator'
  )
  const targetIds = new Set(targetAgents.map((target) => target.id))
  const queues = new Map<string, Array<Extract<RecoveryMessage, { type: 'send' }>>>()

  for (const message of messages) {
    if (message.type === 'send' && targetIds.has(message.to)) {
      const queue = queues.get(message.to) ?? []
      queue.push(message)
      queues.set(message.to, queue)
      continue
    }

    if (message.type === 'report' && targetIds.has(message.from)) {
      queues.get(message.from)?.shift()
    }
  }

  const lines: string[] = []
  for (const target of targetAgents) {
    const queue = queues.get(target.id) ?? []
    for (const task of queue.slice(-8)) {
      lines.push(`- ${target.name}: ${task.text}`)
    }
    if (target.pendingTaskCount > queue.length) {
      lines.push(
        `- ${target.name}: ${target.pendingTaskCount - queue.length} pending with no recoverable detail`
      )
    }
  }

  return lines.length > 0 ? lines : ['- (no open tasks right now)']
}

const formatWorkers = (workers: AgentSummary[]) => {
  if (workers.length === 0) return ['- no other workers right now']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const getTaskSectionTitle = (agent: AgentSummary) =>
  agent.role === 'orchestrator' ? '## Tasks you dispatched' : '## Tasks recently dispatched to you'

export const buildRecoverySummary = ({
  agent,
  allTaskMessages,
  messages,
  tasksContent,
  workers,
  workspace,
}: {
  agent: AgentSummary
  allTaskMessages?: RecoveryMessage[]
  messages: RecoveryMessage[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
}) =>
  wrapSystemMessage(
    [
      `You are ${agent.name} (${agent.role}) in workspace ${workspace.name}.`,
      'Just restarted you, and you could not be resumed through native session resume. Here is the handoff context.',
      '',
      '## Conversation with the user in the last hour',
      ...formatUserInputs(messages),
      '',
      getTaskSectionTitle(agent),
      ...formatTaskEvents(messages, agent),
      '',
      '## Currently open tasks',
      ...formatOpenTasks(allTaskMessages ?? messages, agent, workers),
      '',
      `## Current ${TASKS_RELATIVE_PATH} state`,
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(empty)',
      '',
      '## Currently active workers',
      ...formatWorkers(workers),
      '',
      agent.role === 'orchestrator' ? '## Worker dispatch rules' : '## Worker boundaries',
      ...getGachiTeamRules(agent),
      '',
      'Continue from here. If anything is unclear, ask the user.',
    ].join('\n')
  )
