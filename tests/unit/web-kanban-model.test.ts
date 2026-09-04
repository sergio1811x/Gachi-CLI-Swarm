import { describe, expect, test } from 'vitest'

import type { TaskStatus } from '../../src/shared/types.js'
import {
  COLUMN_BY_ID,
  COLUMNS,
  canTransition,
  cardBorderColor,
  findMatchRanges,
  matchesQuery,
  plural,
  priorityBadge,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  transitionsFrom,
} from '../../web/src/tasks/kanban/kanban-model.js'

describe('kanban status transitions (mirror of src/server/task-store.ts)', () => {
  test('every task status has a transition table entry', () => {
    for (const column of COLUMNS) {
      expect(STATUS_TRANSITIONS[column.id]).toBeDefined()
    }
    // Non-column statuses from the shared union stay covered too.
    expect(STATUS_TRANSITIONS.claimed).toBeDefined()
    expect(STATUS_TRANSITIONS.blocked).toBeDefined()
  })

  test('running may not transition directly to done (must pass through review)', () => {
    expect(canTransition('running', 'done')).toBe(false)
    expect(canTransition('running', 'review')).toBe(true)
    expect(canTransition('review', 'done')).toBe(true)
  })

  test('done is terminal', () => {
    expect(transitionsFrom('done')).toEqual([])
  })

  test('canceled can only be reopened to backlog', () => {
    expect(transitionsFrom('canceled')).toEqual(['backlog'])
    expect(canTransition('canceled', 'ready')).toBe(false)
  })

  test('backlog feeds the dispatch pipeline via ready/assigned', () => {
    expect(canTransition('backlog', 'ready')).toBe(true)
    expect(canTransition('backlog', 'assigned')).toBe(true)
    expect(canTransition('backlog', 'running')).toBe(false)
  })
})

describe('columns', () => {
  test('every column resolves through the lookup map with a caption', () => {
    for (const column of COLUMNS) {
      expect(COLUMN_BY_ID.get(column.id)).toBe(column)
      expect(column.caption.length).toBeGreaterThan(0)
    }
  })

  test('every status has a Russian label', () => {
    const statuses: TaskStatus[] = [
      'backlog',
      'ready',
      'claimed',
      'assigned',
      'running',
      'review',
      'blocked',
      'failed',
      'done',
      'canceled',
    ]
    for (const status of statuses) {
      expect(STATUS_LABELS[status]).toBeTruthy()
    }
  })
})

describe('card priority indication', () => {
  test('urgent priorities override the column accent with red', () => {
    expect(cardBorderColor('high', '#fbbf24')).toBe('#ef4444')
    expect(cardBorderColor('critical', '#22c55e')).toBe('#ef4444')
  })

  test('low priority is green regardless of column', () => {
    expect(cardBorderColor('low', '#818cf8')).toBe('#22c55e')
  })

  test('normal or missing priority falls back to the column accent', () => {
    expect(cardBorderColor('normal', '#3b82f6')).toBe('#3b82f6')
    expect(cardBorderColor(undefined, '#3b82f6')).toBe('#3b82f6')
  })

  test('badges exist only for non-normal priorities', () => {
    expect(priorityBadge('high')).toBe('срочно')
    expect(priorityBadge('critical')).toBe('срочно')
    expect(priorityBadge('low')).toBe('низкий')
    expect(priorityBadge('normal')).toBeUndefined()
    expect(priorityBadge(undefined)).toBeUndefined()
  })
})

describe('board search', () => {
  const workerNames = new Map([
    ['worker-1', 'coder'],
    ['worker-2', 'reviewer'],
  ])

  const base = {
    description: '',
    assignedAgentId: undefined,
  }

  test('matches by title case-insensitively', () => {
    expect(matchesQuery({ ...base, id: 'a', title: 'Fix Login Bug' }, workerNames, 'login')).toBe(
      true
    )
    expect(matchesQuery({ ...base, id: 'a', title: 'Fix Login Bug' }, workerNames, 'logout')).toBe(
      false
    )
  })

  test('matches by description and by id prefix', () => {
    expect(matchesQuery({ ...base, id: 'abc-123', title: 'x' }, workerNames, 'abc')).toBe(true)
    expect(
      matchesQuery({ description: 'починить сборку', id: 'a', title: 'x' }, workerNames, 'сборку')
    ).toBe(true)
  })

  test('matches by assigned worker display name without @', () => {
    expect(
      matchesQuery(
        { ...base, id: 'a', title: 'x', assignedAgentId: 'worker-1' },
        workerNames,
        'coder'
      )
    ).toBe(true)
  })

  test('empty query matches everything', () => {
    expect(matchesQuery({ ...base, id: 'a', title: '' }, workerNames, '  ')).toBe(true)
  })
})

describe('findMatchRanges', () => {
  test('finds all case-insensitive occurrences', () => {
    expect(findMatchRanges('AbC abc ABC', 'abc')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ])
  })

  test('returns no ranges for empty query', () => {
    expect(findMatchRanges('anything', '')).toEqual([])
    expect(findMatchRanges('anything', '   ')).toEqual([])
  })
})

describe('plural helper', () => {
  test('russian plural forms', () => {
    const forms: [string, string, string] = ['задача', 'задачи', 'задач']
    expect(plural(1, forms)).toBe('задача')
    expect(plural(2, forms)).toBe('задачи')
    expect(plural(5, forms)).toBe('задач')
    expect(plural(11, forms)).toBe('задач')
    expect(plural(21, forms)).toBe('задача')
    expect(plural(22, forms)).toBe('задачи')
  })
})
