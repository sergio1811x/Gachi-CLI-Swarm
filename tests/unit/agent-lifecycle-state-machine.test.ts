import { describe, expect, test } from 'vitest'

import {
  assertAgentLifecycleTransition,
  canTransitionAgentLifecycle,
} from '../../src/server/agent-lifecycle.js'

describe('agent lifecycle state machine', () => {
  test('allows the normal start and stop path', () => {
    expect(canTransitionAgentLifecycle('created', 'starting')).toBe(true)
    expect(canTransitionAgentLifecycle('starting', 'ready')).toBe(true)
    expect(canTransitionAgentLifecycle('ready', 'working')).toBe(true)
    expect(canTransitionAgentLifecycle('working', 'stopping')).toBe(true)
    expect(canTransitionAgentLifecycle('stopping', 'stopped')).toBe(true)
  })

  test('rejects transitions that skip lifecycle boundaries', () => {
    expect(() => assertAgentLifecycleTransition('created', 'working')).toThrow(
      'Invalid agent lifecycle transition: created -> working'
    )
    expect(() => assertAgentLifecycleTransition('stopped', 'ready')).toThrow(
      'Invalid agent lifecycle transition: stopped -> ready'
    )
  })

  test('allows a failed agent to restart', () => {
    expect(canTransitionAgentLifecycle('starting', 'failed')).toBe(true)
    expect(canTransitionAgentLifecycle('failed', 'starting')).toBe(true)
  })
})
