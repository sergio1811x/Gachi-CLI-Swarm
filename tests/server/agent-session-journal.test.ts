import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  appendAgentSessionEvent,
  appendAgentSessionTranscript,
  readAgentSessionSnapshot,
  updateAgentSessionTaskContext,
  writeAgentSessionSnapshot,
} from '../../src/server/agent-session-journal.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

describe('agent session journal', () => {
  test('persists the current snapshot and append-only history inside the workspace', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-session-journal-'))
    temporaryDirectories.push(workspacePath)
    const snapshot = {
      agentId: 'worker:frontend',
      command: 'codex',
      runId: 'run-1',
      status: 'running' as const,
      updatedAt: 100,
    }

    writeAgentSessionSnapshot(workspacePath, snapshot)
    appendAgentSessionEvent(workspacePath, snapshot.agentId, {
      at: 100,
      runId: 'run-1',
      type: 'started',
    })
    appendAgentSessionEvent(workspacePath, snapshot.agentId, {
      at: 200,
      runId: 'run-1',
      type: 'stopped',
    })
    appendAgentSessionTranscript(workspacePath, snapshot.agentId, 'agent output\n')

    expect(readAgentSessionSnapshot(workspacePath, snapshot.agentId)).toEqual(snapshot)
    expect(
      readFileSync(
        join(workspacePath, '.gachi', 'agents', 'worker_frontend', 'history', 'events.jsonl'),
        'utf8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { at: 100, runId: 'run-1', type: 'started' },
      { at: 200, runId: 'run-1', type: 'stopped' },
    ])
    expect(
      readFileSync(
        join(workspacePath, '.gachi', 'agents', 'worker_frontend', 'history', 'transcript.log'),
        'utf8'
      )
    ).toBe('agent output\n')
  })

  test('links a running session to the kanban task and handoff artifacts', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-session-journal-'))
    temporaryDirectories.push(workspacePath)
    const snapshot = {
      agentId: 'worker-1',
      command: 'codex',
      runId: 'run-1',
      status: 'running' as const,
      updatedAt: 100,
    }
    writeAgentSessionSnapshot(workspacePath, snapshot)

    expect(
      updateAgentSessionTaskContext(workspacePath, snapshot.agentId, {
        artifacts: ['src/app.ts'],
        status: 'review',
        summary: 'Ready for review',
        taskId: 'task-1',
        updatedAt: 200,
      })
    ).toBe(true)
    expect(readAgentSessionSnapshot(workspacePath, snapshot.agentId)).toMatchObject({
      task: {
        artifacts: ['src/app.ts'],
        status: 'review',
        summary: 'Ready for review',
        taskId: 'task-1',
      },
      updatedAt: 200,
    })
  })
})
