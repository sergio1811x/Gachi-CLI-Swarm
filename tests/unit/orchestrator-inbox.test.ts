import { describe, expect, test, vi } from 'vitest'

import { createOrchestratorInbox } from '../../src/server/orchestrator-inbox.js'

describe('orchestrator inbox', () => {
  test('flush delivers queued payloads in order and empties the queue', () => {
    const inbox = createOrchestratorInbox()
    inbox.submit('ws', 'first')
    inbox.submit('ws', 'second')

    const written: string[] = []
    const delivered = inbox.flush('ws', (payload) => {
      written.push(payload)
      return true
    })

    expect(delivered).toBe(2)
    expect(written).toEqual(['first', 'second'])
    expect(inbox.pendingCount('ws')).toBe(0)
  })

  test('flush keeps undelivered payloads queued in order for a later retry', () => {
    const inbox = createOrchestratorInbox()
    inbox.submit('ws', 'first')
    inbox.submit('ws', 'second')

    // The orchestrator PTY is unwritable right now.
    expect(inbox.flush('ws', () => false)).toBe(0)
    expect(inbox.pendingCount('ws')).toBe(2)

    // A later flush delivers everything that accumulated.
    const delivered = inbox.flush('ws', () => true)
    expect(delivered).toBe(2)
    expect(inbox.pendingCount('ws')).toBe(0)
  })

  test('a throwing writer is treated as not-delivered', () => {
    const inbox = createOrchestratorInbox()
    inbox.submit('ws', 'payload')

    const throwingWriter = () => {
      throw new Error('EPIPE')
    }
    expect(inbox.flush('ws', throwingWriter)).toBe(0)
    expect(inbox.pendingCount('ws')).toBe(1)

    expect(inbox.flush('ws', () => true)).toBe(1)
  })

  test('the queue is bounded: oldest payloads are dropped when capacity is exceeded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const inbox = createOrchestratorInbox({ capacity: 3 })
      for (const payload of ['a', 'b', 'c', 'd']) inbox.submit('ws', payload)

      expect(inbox.pendingCount('ws')).toBe(3)
      const order: string[] = []
      inbox.flush('ws', (payload) => {
        order.push(payload)
        return true
      })
      expect(order).toEqual(['b', 'c', 'd'])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('workspaces have independent queues and flushing an empty queue is a no-op', () => {
    const inbox = createOrchestratorInbox()
    inbox.submit('ws-1', 'payload-1')
    inbox.submit('ws-2', 'payload-2')
    inbox.flush('ws-1', () => true)

    expect(inbox.pendingCount('ws-1')).toBe(0)
    expect(inbox.pendingCount('ws-2')).toBe(1)
    expect(inbox.flush('ws-1', () => true)).toBe(0)
  })
})
