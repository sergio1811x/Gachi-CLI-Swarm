import { describe, expect, test } from 'vitest'

import {
  buildProtocolDoc,
  buildTaskContextReinjectionPayload,
  buildWorkerReminderTail,
  buildWorkerReportNudgePayload,
  getGachiTeamRules,
  ORCHESTRATOR_REMINDER_TAIL,
} from '../../src/server/gachi-team-guidance.js'

describe('ORCHESTRATOR_REMINDER_TAIL', () => {
  test('wraps the reminder in a gachi-system-reminder XML envelope', () => {
    expect(ORCHESTRATOR_REMINDER_TAIL.startsWith('<gachi-system-reminder>')).toBe(true)
    expect(ORCHESTRATOR_REMINDER_TAIL.endsWith('</gachi-system-reminder>')).toBe(true)
  })

  test('names the role and the exact dispatch verb so a post-/compact agent can re-anchor', () => {
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('Orchestrator')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('team send "<worker-name>" "<task>"')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('team cancel --dispatch <id> "<reason>"')
  })

  test('forbids the CLI built-in subagent escape hatch', () => {
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('Never call')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('Task')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('Explore')
  })

  test('strictly forbids stopping/restarting the runtime from inside the session', () => {
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('NEVER stop, restart, or kill the runtime')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('child PTY process of the runtime')
    expect(ORCHESTRATOR_REMINDER_TAIL).toContain('separate terminal')
  })
})

describe('buildWorkerReminderTail', () => {
  test('wraps the reminder in a gachi-system-reminder XML envelope', () => {
    const tail = buildWorkerReminderTail('disp-1234')
    expect(tail.startsWith('<gachi-system-reminder>')).toBe(true)
    expect(tail.endsWith('</gachi-system-reminder>')).toBe(true)
  })

  test('interpolates the dispatch_id into the team-report syntax line', () => {
    const tail = buildWorkerReminderTail('disp-abc')
    expect(tail).toContain('team report "<result>" --dispatch disp-abc')
    expect(tail).toContain('team report --stdin --dispatch disp-abc')
  })

  test('different dispatch_ids produce different reminder bodies', () => {
    const left = buildWorkerReminderTail('disp-1')
    const right = buildWorkerReminderTail('disp-2')
    expect(left).not.toEqual(right)
    expect(left).toContain('disp-1')
    expect(left).not.toContain('disp-2')
    expect(right).toContain('disp-2')
    expect(right).not.toContain('disp-1')
  })

  test('names the role and forbids nested subagents', () => {
    const tail = buildWorkerReminderTail('disp-x')
    expect(tail).toContain('Worker')
    expect(tail).toContain('Do not launch nested CLI subagents')
  })
})

describe('buildWorkerReportNudgePayload', () => {
  test('without a task it is directive and forbids bare status replies', () => {
    const payload = buildWorkerReportNudgePayload()
    expect(payload).toContain('IDLE CHECK')
    expect(payload).toContain('do not reply with a status line')
    expect(payload).toContain('Do NOT reply with "I am active"')
  })

  test('names the exact assigned task and pre-binds the --dispatch id', () => {
    const payload = buildWorkerReportNudgePayload({
      taskId: 'abcdef12',
      dispatchId: 'disp-9',
      title: 'Fix the flaky test',
    })
    expect(payload).toContain('"Fix the flaky test"')
    expect(payload).toContain('disp-9')
    expect(payload).toContain('--dispatch disp-9')
    // A worker that lost its task context must be able to release itself.
    expect(payload).toContain('lost task context')
  })

  test('offers a release path when the worker does not recognize any task', () => {
    const payload = buildWorkerReportNudgePayload()
    expect(payload).toContain('team status "idle"')
  })
})

describe('buildTaskContextReinjectionPayload', () => {
  test('restores the task binding and the report protocol after compaction', () => {
    const payload = buildTaskContextReinjectionPayload({
      taskId: 'abcdef12',
      dispatchId: 'disp-9',
      title: 'Fix the flaky test',
    })
    expect(payload).toContain('#abcdef12 "Fix the flaky test"')
    expect(payload).toContain('--dispatch disp-9')
    // The freshly compacted window gets the full binding, not a question.
    expect(payload).toContain('Do not re-ask')
  })

  test('without a task it points the worker at team list instead of a binding', () => {
    const payload = buildTaskContextReinjectionPayload()
    expect(payload).toContain('team list')
    expect(payload).not.toContain('Your assigned task:')
  })
})

describe('buildProtocolDoc', () => {
  test('renders both orchestrator and worker rule sections', () => {
    const doc = buildProtocolDoc()
    expect(doc).toContain('## Orchestrator rules')
    expect(doc).toContain('## Worker rules')
    expect(doc).toContain('## `team` CLI — orchestrator')
    expect(doc).toContain('## `team` CLI — worker')
    expect(doc).toContain('team cancel --dispatch <id> "<reason>"')
  })

  test('carries the strict service-kill prohibition and command-preservation rules', () => {
    const doc = buildProtocolDoc()
    expect(doc).toContain('NEVER stop, restart, or kill the runtime process')
    expect(doc).toContain('Do not change your own CLI launch command')
  })

  test('orchestrator rules include the strict prohibitions', () => {
    const rules = getGachiTeamRules({ role: 'orchestrator' })
    expect(
      rules.some((rule) => rule.startsWith('NEVER stop, restart, or kill the runtime process'))
    ).toBe(true)
    expect(rules.some((rule) => rule.startsWith('Do not change your own CLI launch command'))).toBe(
      true
    )
  })

  test('mentions the .gachi/PROTOCOL.md cat-recover path explicitly', () => {
    const doc = buildProtocolDoc()
    expect(doc).toContain('`cat .gachi/PROTOCOL.md`')
  })

  test('starts with an H1 heading so a tail of the file is still self-identifying', () => {
    const doc = buildProtocolDoc()
    expect(doc.split('\n')[0]).toBe('# Gachi CLI Swarm Team Protocol')
  })

  test('renders rule entries as a bulleted list (one bullet per rule, not a single paragraph)', () => {
    const doc = buildProtocolDoc()
    // Both sections should yield at least 3 bullets each (current rule counts
    // are 7 / 6; locking in "at least 3" tolerates future rule edits while
    // still catching the regression where renderRules collapsed bullets).
    const orchSection = doc.split('## Orchestrator rules')[1]?.split('## Worker rules')[0] ?? ''
    const workerSection = doc.split('## Worker rules')[1] ?? ''
    expect(
      orchSection.split('\n').filter((line) => line.startsWith('- ')).length
    ).toBeGreaterThanOrEqual(3)
    expect(
      workerSection.split('\n').filter((line) => line.startsWith('- ')).length
    ).toBeGreaterThanOrEqual(3)
  })
})
