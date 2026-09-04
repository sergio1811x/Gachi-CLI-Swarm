import { describe, expect, test } from 'vitest'
import type { AgentStatus, TeamListItem } from '../../src/shared/types.js'
import { agentStatuses } from '../../src/shared/types.js'

describe('shared types contract', () => {
  test('shared types module exports runtime contract markers', () => {
    expect(agentStatuses).toEqual(['idle', 'working', 'waiting_decision', 'stopped'])
  })

  test('team list item status includes the review-waiting state', () => {
    const item: TeamListItem = {
      id: 'alice',
      name: 'Alice',
      role: 'coder',
      status: 'waiting_decision' satisfies AgentStatus,
      pendingTaskCount: 1,
    }

    expect(item.status).toBe('waiting_decision')
    expect(item.pendingTaskCount).toBe(1)
  })
})
