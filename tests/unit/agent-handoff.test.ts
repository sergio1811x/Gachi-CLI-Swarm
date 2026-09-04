import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  buildAgentHandoffPrompt,
  createAgentSnapshot,
  loadLatestAgentSnapshot,
  persistAgentSnapshot,
} from '../../src/server/agent-handoff.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

describe('agent handoff snapshot', () => {
  test('captures engine-neutral work context and produces a continuation prompt', () => {
    const snapshot = createAgentSnapshot(
      {
        agentId: 'worker-1',
        command: 'claude',
        runId: 'run-1',
        status: 'failed',
        task: {
          artifacts: ['src/auth.ts'],
          status: 'review',
          summary: 'Authentication middleware was updated.',
          taskId: 'task-1',
          updatedAt: 100,
        },
        updatedAt: 100,
      },
      200
    )

    expect(snapshot).toMatchObject({
      changedFiles: ['src/auth.ts'],
      engine: 'claude',
      taskId: 'task-1',
    })
    expect(buildAgentHandoffPrompt(snapshot)).toContain('Previous engine: claude')
    expect(buildAgentHandoffPrompt(snapshot)).toContain('src/auth.ts')
    expect(buildAgentHandoffPrompt(snapshot)).toContain('Review the submitted result')
  })

  test('persists and loads the latest handoff for a different agent engine', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-handoff-'))
    temporaryDirectories.push(workspacePath)
    const snapshot = createAgentSnapshot(
      { agentId: 'worker-1', command: 'claude', runId: 'run-1', status: 'stopped', updatedAt: 100 },
      200
    )

    persistAgentSnapshot(workspacePath, snapshot)

    expect(loadLatestAgentSnapshot(workspacePath, 'worker-1')).toEqual(snapshot)
  })
})
