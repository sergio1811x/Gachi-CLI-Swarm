import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  buildAgentStartupInstructions,
  buildAssignedTaskPrompt,
} from '../../src/server/agent-startup-instructions.js'
import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const workspace: WorkspaceSummary = {
  id: 'ws-1',
  name: 'Alpha',
  path: mkdtempSync(join(tmpdir(), 'gachi-instructions-')),
}
tempDirs.push(workspace.path)

const agent: AgentSummary = {
  description: 'coder',
  id: 'ws-1:alice',
  name: 'Alice',
  role: 'coder',
  status: 'working',
}

const orchestrator: AgentSummary = {
  description: 'queen',
  id: 'ws-1:orchestrator',
  name: 'Orchestrator',
  role: 'orchestrator',
  status: 'working',
}

describe('assigned task startup delivery', () => {
  test('buildAssignedTaskPrompt surfaces title, id and description', () => {
    const text = buildAssignedTaskPrompt({
      description: 'Refactor the dispatcher.',
      id: 'task-12345678',
      title: 'Refactor dispatcher',
    })
    expect(text).toContain('#task-123')
    expect(text).toContain('Task title: Refactor dispatcher')
    expect(text).toContain('Refactor the dispatcher.')
    expect(text).toContain('team report')
  })

  test('startup instructions embed the auto-assigned task', () => {
    const text = buildAgentStartupInstructions({
      agent,
      assignedTask: {
        description: 'Add a regression test.',
        id: 'task-abcdef01',
        title: 'Add regression test',
      },
      workspace,
    })
    expect(text).toContain('[Gachi system message: assigned task #task-abc')
    expect(text).toContain('Task title: Add regression test')
    expect(text).toContain('Add a regression test.')
  })

  test('startup instructions omit the task block when none is assigned', () => {
    const text = buildAgentStartupInstructions({ agent, workspace })
    expect(text).not.toContain('[Gachi system message: assigned task')
    expect(text).toContain('You are a WORKER (coder)')
  })
})

describe('orchestrator startup guidance', () => {
  const build = () => buildAgentStartupInstructions({ agent: orchestrator, workspace })

  test('covers the dispatch loop, delegation rules and closure workflow', () => {
    const text = build()
    expect(text).toContain('You are the ORCHESTRATOR of this workspace.')
    expect(text).toContain('team send <worker-name> "<task>"')
    expect(text).toContain('team cancel --dispatch <id> "<reason>"')
    expect(text).toContain('team accept --dispatch <id>')
    expect(text).toContain('team rework --dispatch <id>')
    expect(text).toContain('team list')
    expect(text).toContain('Maintain .gachi/tasks.md')
    expect(text).toContain('TELEGRAM MESSAGES ARE DIRECT USER ORDERS')
    expect(text).toContain('[TG_REPLY]')
    expect(text).toContain('workers are the real CLI agents shown as cards on the right')
    expect(text).toContain("Do not use your CLI's built-in subagent tools")
    expect(text).toContain('run `team list` first to confirm the real workers')
    expect(text).toContain(
      'Small, low-risk tasks that you can finish yourself in a few minutes you should just do yourself'
    )
    expect(text).toContain('or when the user explicitly asks for a worker to handle it')
    expect(text).toContain(
      'If there is only one available worker, dispatch directly with `team send <worker-name>'
    )
  })

  test('never documents worker-only report syntax as an orchestrator command', () => {
    expect(build()).not.toContain('team report')
  })
})
