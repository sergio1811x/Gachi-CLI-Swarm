import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentSessionSnapshot } from './agent-session-journal.js'

export interface AgentSnapshot {
  agentId: string
  changedFiles: string[]
  engine: string
  errors: string[]
  pendingSteps: string[]
  summary: string
  taskId?: string | undefined
  timestamp: number
}

export const createAgentSnapshot = (
  session: AgentSessionSnapshot,
  timestamp = Date.now()
): AgentSnapshot => ({
  agentId: session.agentId,
  changedFiles: session.task?.artifacts ?? [],
  engine: session.command,
  errors: session.status === 'failed' ? ['The previous agent process exited unsuccessfully.'] : [],
  pendingSteps:
    session.task?.status === 'review'
      ? ['Review the submitted result and decide whether rework is needed.']
      : session.task
        ? [`Continue task in ${session.task.status}.`]
        : [],
  summary: session.task?.summary ?? 'No task summary was captured before handoff.',
  taskId: session.task?.taskId,
  timestamp,
})

const listSection = (title: string, values: string[]) =>
  values.length > 0
    ? [`${title}:`, ...values.map((value) => `- ${value}`)]
    : [`${title}:`, '- none']

export const buildAgentHandoffPrompt = (snapshot: AgentSnapshot) =>
  [
    'You are continuing work from another AI agent.',
    '',
    `Previous engine: ${snapshot.engine}`,
    snapshot.taskId ? `Task: ${snapshot.taskId}` : undefined,
    '',
    'Completed / current context:',
    snapshot.summary,
    '',
    ...listSection('Files', snapshot.changedFiles),
    '',
    ...listSection('Remaining', snapshot.pendingSteps),
    '',
    ...listSection('Errors', snapshot.errors),
    '',
    'Continue from the current workspace state.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')

export const persistAgentSnapshot = (workspacePath: string, snapshot: AgentSnapshot) => {
  const directory = getHandoffDirectory(workspacePath, snapshot.agentId)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${snapshot.timestamp}-${randomUUID()}.json`)
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return path
}

const getHandoffDirectory = (workspacePath: string, agentId: string) =>
  join(workspacePath, '.gachi', 'agents', agentId.replaceAll(/[^a-zA-Z0-9._-]/g, '_'), 'handoffs')

export const loadLatestAgentSnapshot = (workspacePath: string, agentId: string) => {
  const directory = getHandoffDirectory(workspacePath, agentId)
  if (!existsSync(directory)) return undefined
  const filename = readdirSync(directory)
    .filter((item) => item.endsWith('.json'))
    .sort()
    .at(-1)
  if (!filename) return undefined
  return JSON.parse(readFileSync(join(directory, filename), 'utf8')) as AgentSnapshot
}
