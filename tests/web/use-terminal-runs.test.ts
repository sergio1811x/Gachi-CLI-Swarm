// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TerminalRunSummary } from '../../web/src/api.js'
import { useTerminalRuns } from '../../web/src/terminal/useTerminalRuns.js'

const run = (status: string): TerminalRunSummary => ({
  agent_id: 'agent-1',
  agent_name: 'Alice',
  run_id: 'run-1',
  status,
  terminal_input_profile: 'default',
})

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useTerminalRuns', () => {
  test('keeps the same array reference when polling returns unchanged runs', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(json([run('running')]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTerminalRuns('ws-1'))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current).toHaveLength(1)
    const firstRuns = result.current

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current).toBe(firstRuns)
  })

  test('updates when a polled run changes status', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json([run('running')]))
      .mockResolvedValueOnce(json([run('stopped')]))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTerminalRuns('ws-1'))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0]?.status).toBe('running')
    const firstRuns = result.current

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(result.current).not.toBe(firstRuns)
    expect(result.current[0]?.status).toBe('stopped')
  })

  test('does not overlap slow requests and backs off failed refreshes', async () => {
    vi.useFakeTimers()
    let resolveFirstFetch: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(json([run('running')]))
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useTerminalRuns('ws-1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json([run('running')]))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
