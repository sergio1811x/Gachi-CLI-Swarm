import { describe, expect, test } from 'vitest'
import { createRuntimeEventBus } from '../../src/server/runtime-event-bus.js'

describe('runtime event bus', () => {
  test('stamps monotonic entityVersion and updatedAt on every emit', () => {
    const bus = createRuntimeEventBus()
    const received: number[] = []
    bus.subscribe((_workspaceId, event) => received.push(event.entityVersion))

    bus.emit('ws-1', { type: 'QUEUE_UPDATED', payload: { taskCount: 3 } })
    bus.emit('ws-1', { type: 'RUN_PROGRESS', payload: { agentId: 'a', line: 'x' } })
    bus.emit('ws-1', { type: 'AGENT_STATUS_CHANGED', payload: { agentId: 'a' } })

    expect(received).toEqual([1, 2, 3])
  })

  test('forwards the workspaceId and full envelope to subscribers', () => {
    const bus = createRuntimeEventBus()
    const seen: Array<{ ws: string; event: unknown }> = []
    bus.subscribe((ws, event) => seen.push({ ws, event }))

    bus.emit('ws-9', { type: 'TASK_STARTED', payload: { taskId: 't1', status: 'running' } })

    expect(seen).toHaveLength(1)
    expect(seen[0].ws).toBe('ws-9')
    const event = seen[0].event as {
      type: string
      payload: Record<string, unknown>
      entityVersion: number
      updatedAt: number
    }
    expect(event.type).toBe('TASK_STARTED')
    expect(event.payload).toEqual({ taskId: 't1', status: 'running' })
    expect(event.entityVersion).toBe(1)
    expect(typeof event.updatedAt).toBe('number')
  })

  test('unsubscribe stops delivery', () => {
    const bus = createRuntimeEventBus()
    let count = 0
    const unsubscribe = bus.subscribe(() => {
      count += 1
    })

    bus.emit('ws-1', { type: 'QUEUE_UPDATED', payload: { taskCount: 1 } })
    expect(count).toBe(1)

    unsubscribe()
    bus.emit('ws-1', { type: 'QUEUE_UPDATED', payload: { taskCount: 1 } })
    expect(count).toBe(1)
  })

  test('isolates subscribers from each other', () => {
    const bus = createRuntimeEventBus()
    const a: string[] = []
    const b: string[] = []
    bus.subscribe((_ws, e) => a.push(e.type))
    bus.subscribe((_ws, e) => b.push(e.type))

    bus.emit('ws-1', { type: 'AGENT_READY', payload: { agentId: 'a' } })

    expect(a).toEqual(['AGENT_READY'])
    expect(b).toEqual(['AGENT_READY'])
  })
})
