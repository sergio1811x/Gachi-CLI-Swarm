// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { REFRESH_INTERVAL_MS, useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceWorkers', () => {
  test('loads worker summaries for every local workspace id, not only the active workspace', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        a: [
          {
            id: 'wa',
            lastPtyLine: undefined,
            name: 'Alice',
            pendingTaskCount: 1,
            role: 'coder',
            status: 'working',
          },
        ],
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('prunes worker summaries when a workspace is removed from the local list', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      {
        initialProps: { workspaceIds: ['a', 'b'] },
      }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
      expect(result.current[0]).toHaveProperty('b')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('keeps the same workspace map reference when refreshed worker payloads are unchanged', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json([{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }])
      )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWorkspaceWorkers(['a']))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0]).toHaveProperty('a')
    const firstMap = result.current[0]

    // Poll cadence is REFRESH_INTERVAL_MS (WS push handles low-latency updates).
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_INTERVAL_MS)
      await flushPromises()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Identical payload → the hook returns the SAME map reference so React
    // skips re-rendering every consumer.
    expect(result.current[0]).toBe(firstMap)
  })

  test('backs off failed refreshes and does not overlap in-flight worker requests', async () => {
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
      .mockResolvedValue(
        json([{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }])
      )
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useWorkspaceWorkers(['a']))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // While the first request is in flight, timers must not stack a second one.
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 3)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json([]))
      await flushPromises()
    })

    // Success resets the backoff: the next poll lands exactly one interval
    // after the previous request settled. Pump enough microtask ticks for
    // the whole listWorkers → setState → .finally(schedule) chain to drain.
    const pump = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    }
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_INTERVAL_MS)
      await pump()
    })
    // This second call REJECTS (queued mockRejectedValueOnce): failure bumps
    // failureCount → the following backoff doubles to 2×interval.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2 - 1)
      await pump()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await pump()
    })
    // Third call succeeds (queued resolved value) → backoff resets to base
    // interval for the follow-up poll.
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      vi.advanceTimersByTime(REFRESH_INTERVAL_MS - 1)
      await pump()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await pump()
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
