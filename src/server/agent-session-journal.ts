import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renameWithWindowsRetry } from './tasks-file.js'

export interface AgentSessionSnapshot {
  agentId: string
  command: string
  runId: string
  status: 'running' | 'stopped' | 'failed'
  task?: AgentSessionTaskContext | undefined
  updatedAt: number
}

export interface AgentSessionTaskContext {
  artifacts: string[]
  status: string
  summary?: string | undefined
  taskId: string
  updatedAt: number
}

export interface AgentSessionEvent {
  at: number
  runId: string
  task?: AgentSessionTaskContext | undefined
  type: 'started' | 'stopped' | 'failed' | 'task_updated'
}

const getAgentDirectory = (workspacePath: string, agentId: string) =>
  join(workspacePath, '.gachi', 'agents', agentId.replaceAll(/[^a-zA-Z0-9._-]/g, '_'))

const getCurrentPath = (workspacePath: string, agentId: string) =>
  join(getAgentDirectory(workspacePath, agentId), 'current.json')

const getHistoryPath = (workspacePath: string, agentId: string) =>
  join(getAgentDirectory(workspacePath, agentId), 'history', 'events.jsonl')

const getTranscriptPath = (workspacePath: string, agentId: string) =>
  join(getAgentDirectory(workspacePath, agentId), 'history', 'transcript.log')

export const writeAgentSessionSnapshot = (
  workspacePath: string,
  snapshot: AgentSessionSnapshot
) => {
  const directory = getAgentDirectory(workspacePath, snapshot.agentId)
  mkdirSync(join(directory, 'history'), { recursive: true })
  const currentPath = getCurrentPath(workspacePath, snapshot.agentId)
  const temporaryPath = `${currentPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  // current.json is overwritten on every run update and read concurrently by
  // session resume — a plain rename intermittently fails on Windows (EPERM/
  // EACCES/EBUSY), so use the same retry as the tasks file (R9).
  renameWithWindowsRetry(temporaryPath, currentPath)
}

export const appendAgentSessionEvent = (
  workspacePath: string,
  agentId: string,
  event: AgentSessionEvent
) => {
  const historyPath = getHistoryPath(workspacePath, agentId)
  mkdirSync(join(getAgentDirectory(workspacePath, agentId), 'history'), { recursive: true })
  appendFileSync(historyPath, `${JSON.stringify(event)}\n`, 'utf8')
}

export const appendAgentSessionTranscript = (
  workspacePath: string,
  agentId: string,
  chunk: string
) => {
  const transcriptPath = getTranscriptPath(workspacePath, agentId)
  mkdirSync(join(getAgentDirectory(workspacePath, agentId), 'history'), { recursive: true })
  appendFileSync(transcriptPath, chunk, 'utf8')
}

export const readAgentSessionSnapshot = (workspacePath: string, agentId: string) =>
  JSON.parse(readFileSync(getCurrentPath(workspacePath, agentId), 'utf8')) as AgentSessionSnapshot

/**
 * Returns the last durable session state when an agent is being restarted.
 * A first launch has no journal yet; malformed journal data is deliberately
 * allowed to surface rather than silently dropping a worker's task context.
 */
export const readExistingAgentSessionSnapshot = (workspacePath: string, agentId: string) => {
  const currentPath = getCurrentPath(workspacePath, agentId)
  return existsSync(currentPath)
    ? (JSON.parse(readFileSync(currentPath, 'utf8')) as AgentSessionSnapshot)
    : undefined
}

export const updateAgentSessionTaskContext = (
  workspacePath: string,
  agentId: string,
  task: AgentSessionTaskContext
) => {
  const currentPath = getCurrentPath(workspacePath, agentId)
  if (!existsSync(currentPath)) return false
  const snapshot = readAgentSessionSnapshot(workspacePath, agentId)
  writeAgentSessionSnapshot(workspacePath, { ...snapshot, task, updatedAt: task.updatedAt })
  appendAgentSessionEvent(workspacePath, agentId, {
    at: task.updatedAt,
    runId: snapshot.runId,
    task,
    type: 'task_updated',
  })
  return true
}
