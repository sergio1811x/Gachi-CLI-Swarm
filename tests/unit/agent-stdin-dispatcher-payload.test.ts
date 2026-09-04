import { describe, expect, test } from 'vitest'

import {
  buildOrchestratorReportPayload,
  buildOrchestratorStatusPayload,
  buildOrchestratorUserInputPayload,
  buildWorkerDispatchPayload,
} from '../../src/server/agent-stdin-dispatcher.js'
import { buildWorkerReminderTail } from '../../src/server/gachi-team-guidance.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

const lineIndexOf = (payload: string, needle: string): number =>
  payload.split('\n').findIndex((line) => line === needle || line.includes(needle))

describe.skipIf(SKIP_CONPTY_WINDOWS)('buildOrchestratorReportPayload', () => {
  test('starts with the report header and includes the body verbatim', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'fix shipped', [])
    expect(payload.split('\n')[0]).toBe('[Gachi system message: report from @coder-1]')
    expect(payload).toContain('fix shipped')
  })

  test('renders every artifact path on its own `artifact: <path>` line', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'done', ['a.md', 'b.png'])
    const lines = payload.split('\n')
    expect(lines).toContain('artifact: a.md')
    expect(lines).toContain('artifact: b.png')
  })

  test('ends with a trailing newline so xterm/bracketed-paste submits the message', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'done', [])
    expect(payload.endsWith('\n')).toBe(true)
  })
})

describe('buildOrchestratorStatusPayload', () => {
  test('starts with the status header (distinct from the report header)', () => {
    const payload = buildOrchestratorStatusPayload('coder-1', 'waiting on tests', [])
    expect(payload.split('\n')[0]).toBe('[Gachi system message: status update from @coder-1]')
    expect(payload).toContain('waiting on tests')
  })
})

describe('buildOrchestratorUserInputPayload', () => {
  test('passes user text cleanly as plain text without system reminder spam', () => {
    const payload = buildOrchestratorUserInputPayload('please draft the migration')
    expect(payload).toBe('please draft the migration')
  })

  test('preserves multi-line user input as-is', () => {
    const payload = buildOrchestratorUserInputPayload('line one\nline two')
    expect(payload).toBe('line one\nline two')
  })
})

describe('buildWorkerDispatchPayload', () => {
  test('keeps the existing dispatch header, role, obligation prose, and task body intact', () => {
    const payload = buildWorkerDispatchPayload(
      'orchestrator-1',
      'Coder — implements features',
      'disp-42',
      'add error handling to login.ts'
    )
    expect(payload).toContain('[Gachi system message: dispatch from @orchestrator-1]')
    expect(payload).toContain('Your role: Coder — implements features')
    expect(payload).toContain('dispatch_id: disp-42')
    expect(payload).toContain('add error handling to login.ts')
  })

  test('appends the worker reminder tail with the dispatch_id interpolated', () => {
    const payload = buildWorkerDispatchPayload('orchestrator-1', 'Coder', 'disp-77', 'task body')
    expect(payload).toContain(buildWorkerReminderTail('disp-77'))
    // No leaked placeholder.
    expect(payload).not.toContain('--dispatch <id>')
  })

  test('places the worker reminder AFTER the task body so it is the last thing the worker sees', () => {
    const payload = buildWorkerDispatchPayload('orchestrator-1', 'Coder', 'disp-99', 'do the thing')
    const taskBodyIdx = lineIndexOf(payload, 'do the thing')
    const reminderIdx = lineIndexOf(payload, '<gachi-system-reminder>')
    expect(taskBodyIdx).toBeGreaterThanOrEqual(0)
    expect(reminderIdx).toBeGreaterThan(taskBodyIdx)
  })
})
