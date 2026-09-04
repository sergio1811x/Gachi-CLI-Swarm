import { describe, expect, test, vi } from 'vitest'

import type { WebSocket } from 'ws'

import { createTerminalOutputFlow, FLOW_CONTROL } from '../../src/server/terminal-flow-control.js'

interface MockWs extends WebSocket {
  sent: string[]
}

const makeMockWs = () => {
  const ws = {
    sent: [] as string[],
    bufferedAmount: 0,
    readyState: 1,
    OPEN: 1,
    send(chunk: string) {
      ws.sent.push(chunk)
    },
  }
  return ws as unknown as MockWs
}

describe('terminal output flow drop-and-resync', () => {
  test('drops pending chunks and signals onDropped once the pending buffer overflows', () => {
    const ws = makeMockWs()
    const onBackpressureChange = vi.fn()
    const onDropped = vi.fn()
    const flow = createTerminalOutputFlow(ws, { onBackpressureChange, onDropped })

    const bigChunk = 'x'.repeat(FLOW_CONTROL.LOW_LATENCY_THRESHOLD_BYTES + 1)
    flow.enqueue(bigChunk)
    flow.enqueue(bigChunk)

    const dropCount = FLOW_CONTROL.DROP_HIGH_WATER / bigChunk.length + 1
    for (let index = 0; index < dropCount; index += 1) {
      flow.enqueue(bigChunk)
    }

    expect(onDropped).toHaveBeenCalled()
    expect(ws.sent).toHaveLength(0)
  })

  test('does not signal onDropped when the pending buffer stays under the cap', () => {
    const ws = makeMockWs()
    const onBackpressureChange = vi.fn()
    const onDropped = vi.fn()
    const flow = createTerminalOutputFlow(ws, { onBackpressureChange, onDropped })

    const bigChunk = 'y'.repeat(FLOW_CONTROL.LOW_LATENCY_THRESHOLD_BYTES + 1)
    for (let index = 0; index < 3; index += 1) {
      flow.enqueue(bigChunk)
    }

    expect(onDropped).not.toHaveBeenCalled()
  })

  test('stops enqueueing after close', () => {
    const ws = makeMockWs()
    const onBackpressureChange = vi.fn()
    const onDropped = vi.fn()
    const flow = createTerminalOutputFlow(ws, { onBackpressureChange, onDropped })

    flow.close()
    flow.enqueue('abc')

    expect(ws.sent).toHaveLength(0)
    expect(onDropped).not.toHaveBeenCalled()
  })
})
