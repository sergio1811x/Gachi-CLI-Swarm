import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getGachiTeamRules } from './gachi-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1024

const formatWorkers = (workers: AgentSummary[]) => {
  if (workers.length === 0) return ['- no other workers right now']
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const formatRestartWindow = (messages: RecoveryMessage[]) => {
  const sends = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' }> => {
      return message.type === 'send'
    }
  )
  if (sends.length === 0) return ['- no new dispatches during the restart']
  return sends.slice(-5).map((message) => `- send -> ${message.to}: ${message.text}`)
}

export const buildEnvSyncMessage = ({
  agent,
  tasksContent,
  workers,
  workspace,
  restartWindowMessages,
}: {
  agent: AgentSummary
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  restartWindowMessages: RecoveryMessage[]
}) =>
  wrapSystemMessage(
    [
      'Just restarted you. What changed in the environment while you were down:',
      `- current workspace: ${workspace.name}`,
      '- current workers:',
      ...formatWorkers(workers),
      `- current ${TASKS_RELATIVE_PATH} content:`,
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(empty)',
      ...formatRestartWindow(restartWindowMessages),
      agent.role === 'orchestrator' ? '- Worker dispatch rules:' : '- Worker boundaries:',
      ...getGachiTeamRules(agent).map((rule) => `  - ${rule}`),
      `Continue from here. If unsure, check with team list / Read ${TASKS_RELATIVE_PATH} or ask the user.`,
    ].join('\n')
  )
