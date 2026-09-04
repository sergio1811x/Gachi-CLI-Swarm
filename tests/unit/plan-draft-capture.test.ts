import { describe, expect, test } from 'vitest'

import {
  buildPlannerPrompt,
  createPlanDraftCapture,
  type ParsedPlanTask,
} from '../../src/server/plan-draft.js'

const GROUP = '11111111-2222-4333-8444-555555555555'

describe('plan draft capture (R2.2)', () => {
  test('parses tasks split across chunks with ANSI + bullets', () => {
    const created: Array<ParsedPlanTask & { group: string }> = []
    let finished = -1
    const capture = createPlanDraftCapture({
      isPending: (id) => id === GROUP,
      createTask: (group, task) => {
        created.push({ ...task, group })
        return true
      },
      finish: (_g, count) => {
        finished = count
      },
    })

    capture.push('\x1b[36m●\x1b[39m \x1b[1m[PLAN_BEG')
    capture.push(`IN]\x1b[22m ${GROUP}\n`)
    capture.push(
      '● [PLAN_TASK] Auth module :: implement login flow :: :: auth,typescript :: coder\n'
    )
    capture.push('[PLAN_TASK] UI page :: wire the form :: 1 :: react :: frontend\n')
    capture.push('\x1b[2m[PLAN_DO')
    capture.push(`NE]\x1b[0m ${GROUP}\n`)

    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({
      group: GROUP,
      title: 'Auth module',
      dependencyOrdinals: [],
      requiredSkills: ['auth', 'typescript'],
      role: 'coder',
    })
    expect(created[1]).toMatchObject({
      title: 'UI page',
      dependencyOrdinals: [1],
      role: 'coder', // 'frontend' alias maps to coder
    })
    expect(finished).toBe(2)
  })

  test('unknown group ids are ignored entirely', () => {
    const created: ParsedPlanTask[] = []
    let finishedCount = -2
    const capture = createPlanDraftCapture({
      isPending: () => false,
      createTask: (_g, task) => {
        created.push(task)
        return true
      },
      finish: (_g, count) => {
        finishedCount = count
      },
    })
    capture.push(
      `[PLAN_BEGIN] deadbeef000000000000000000000000\n[PLAN_TASK] X :: y :: :: :: coder\n[PLAN_DONE] deadbeef000000000000000000000000\n`
    )
    expect(created).toHaveLength(0)
    expect(finishedCount).toBe(-2)
  })

  test('forward dependencies are dropped; bad roles fall back to custom; cap at 12', () => {
    const created: ParsedPlanTask[] = []
    const capture = createPlanDraftCapture({
      isPending: (id) => id === GROUP,
      createTask: (_g, task) => {
        created.push(task)
        return true
      },
      finish: () => {},
    })

    const lines = [`[PLAN_BEGIN] ${GROUP}`]
    lines.push('[PLAN_TASK] T1 :: first :: 5 :: :: qa') // forward dep 5 → dropped; qa→tester
    for (let i = 2; i <= 15; i++) {
      lines.push(`[PLAN_TASK] Task ${i} :: d :: ${i - 1} :: :: reviewer`)
    }
    lines.push(`[PLAN_DONE] ${GROUP}`)
    capture.push(`${lines.join('\n')}\n`)

    expect(created).toHaveLength(12) // cap
    expect(created[0]?.dependencyOrdinals).toEqual([])
    expect(created[0]?.role).toBe('tester')
    // Last accepted is #12 → its dep points to ordinal 11 which exists.
    expect(created[11]?.dependencyOrdinals).toEqual([11])
  })

  test('a bare CR repaint does not glue the stale prefix into plan lines', () => {
    const created: ParsedPlanTask[] = []
    const capture = createPlanDraftCapture({
      isPending: (id) => id === GROUP,
      createTask: (_g, task) => {
        created.push(task)
        return true
      },
      finish: () => {},
    })

    // Spinner repaints the unterminated line; deleting \r used to produce
    // "[PLAN_TAS[PLAN_TASK] …" which the anchored regex silently dropped.
    capture.push(`[PLAN_BEGIN] ${GROUP}\n`)
    capture.push('● [PLAN_TAS')
    capture.push('\r\x1b[2K[PLAN_TASK] Auth :: login flow :: :: auth :: coder\n')

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ title: 'Auth', role: 'coder' })
  })

  test('CRLF-terminated plan lines still parse', () => {
    const created: ParsedPlanTask[] = []
    let finished = -1
    const capture = createPlanDraftCapture({
      isPending: (id) => id === GROUP,
      createTask: (_g, task) => {
        created.push(task)
        return true
      },
      finish: (_g, count) => {
        finished = count
      },
    })

    capture.push(`[PLAN_BEGIN] ${GROUP}\r\n`)
    capture.push('[PLAN_TASK] UI :: wire form :: :: react :: frontend\r\n')
    capture.push(`[PLAN_DONE] ${GROUP}\r\n`)

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ title: 'UI', role: 'coder' })
    expect(finished).toBe(1)
  })

  test('prompt builder embeds goal and group and states the contract', () => {
    const prompt = buildPlannerPrompt('Build a CRM dashboard', GROUP)
    expect(prompt).toContain(`GROUP: ${GROUP}`)
    expect(prompt).toContain('GOAL: Build a CRM dashboard')
    expect(prompt).toContain('[PLAN_BEGIN]')
    expect(prompt).toContain('[PLAN_TASK]')
    expect(prompt).toContain('[PLAN_DONE]')
  })
})
