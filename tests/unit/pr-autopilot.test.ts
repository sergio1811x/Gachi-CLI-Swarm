import { describe, expect, test } from 'vitest'

import {
  autopilotMarker,
  buildPrReviewTaskInput,
  hasOpenAutopilotTask,
  parseSeenMap,
  readAutopilotMode,
  selectPrsToReview,
} from '../../src/server/pr-autopilot.js'

const settings = (values: Record<string, string>) => ({
  getAppState: (key: string) => (key in values ? { value: values[key] ?? null } : undefined),
})

describe('readAutopilotMode', () => {
  test('off by default; dry and live honored', () => {
    expect(readAutopilotMode(settings({}), 'ws')).toBe('off')
    expect(readAutopilotMode(settings({ pr_autopilot_ws: 'dry' }), 'ws')).toBe('dry')
    expect(readAutopilotMode(settings({ pr_autopilot_ws: 'live' }), 'ws')).toBe('live')
  })
})

describe('selectPrsToReview', () => {
  const pr = (number: number, headSha: string) => ({
    head: `feature-${number}`,
    headSha,
    number,
    title: `PR ${number}`,
    url: `https://x/pull/${number}`,
  })

  test('new PRs are selected, unchanged ones skipped', () => {
    const seen = { 7: { rounds: 1, sha: 'aaa' } }
    const out = selectPrsToReview([pr(7, 'aaa'), pr(9, 'bbb')], seen, 3)
    expect(out.map((entry) => entry.number)).toEqual([9])
    expect(out[0]?.reReview).toBe(false)
  })

  test('head move re-reviews until the rounds limit', () => {
    const seen = { 7: { rounds: 2, sha: 'old' } }
    const out = selectPrsToReview([pr(7, 'new')], seen, 3)
    expect(out).toHaveLength(1)
    expect(out[0]?.reReview).toBe(true)

    const exhausted = { 8: { rounds: 3, sha: 'old' } }
    expect(selectPrsToReview([pr(8, 'newer')], exhausted, 3)).toEqual([])
  })
})

describe('task card', () => {
  test('live mode instructs gh pr review; dry mode forbids verdicts', () => {
    const live = buildPrReviewTaskInput({
      mode: 'live',
      pr: { number: 42, title: 'Fix login', url: 'https://x/pull/42' },
      reReview: false,
      workspaceId: 'ws12345678',
    })
    expect(live.description).toContain(autopilotMarker('ws12345678', 42))
    expect(live.description).toContain('gh pr review 42 --approve')
    expect(live.title).toContain('#42')

    const dry = buildPrReviewTaskInput({
      mode: 'dry',
      pr: { number: 42, title: 'Fix login', url: 'https://x/pull/42' },
      reReview: true,
      workspaceId: 'ws',
    })
    expect(dry.description).toContain('DRY-RUN')
    expect(dry.description).toContain('RE-REVIEW')
    expect(dry.description).not.toContain('--approve')
    expect(dry.description).toContain('gh pr comment 42')
  })

  test('anti-flood finds only open cards of this PR', () => {
    const marker = autopilotMarker('ws1', 5)
    expect(hasOpenAutopilotTask([{ description: marker, status: 'ready' }], 'ws1', 5)).toBe(true)
    expect(hasOpenAutopilotTask([{ description: marker, status: 'done' }], 'ws1', 5)).toBe(false)
    expect(hasOpenAutopilotTask([], 'ws1', 6)).toBe(false)
  })
})

test('parseSeenMap tolerates garbage', () => {
  expect(parseSeenMap(null)).toEqual({})
  expect(parseSeenMap('{bad json')).toEqual({})
  expect(parseSeenMap('{"7":{"sha":"a","rounds":1},"junk":3}')).toEqual({
    '7': { rounds: 1, sha: 'a' },
  })
})
