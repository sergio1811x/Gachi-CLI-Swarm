// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TerminalRunSummary } from '../../web/src/api.js'
import {
  mergeTerminalRuns,
  useOptimisticTerminalRuns,
} from '../../web/src/terminal/useOptimisticTerminalRuns.js'

const terminalRun = (runId: string, agentId: string, agentName = 'Shell'): TerminalRunSummary => ({
  agent_id: agentId,
  agent_name: agentName,
  run_id: runId,
  status: 'running',
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mergeTerminalRuns', () => {
  test('keeps an optimistic workspace shell run when another shell already exists', () => {
    const actual = [terminalRun('shell-run-1', 'ws-1:shell', 'Shell')]
    const optimistic = [terminalRun('shell-run-2', 'ws-1:shell', 'Shell')]

    expect(mergeTerminalRuns(actual, optimistic, 'ws-1')).toEqual([...actual, ...optimistic])
  })

  test('deduplicates optimistic worker runs by agent id', () => {
    const actual = [terminalRun('worker-run-1', 'worker-1', 'Alice')]
    const optimistic = [terminalRun('worker-run-2', 'worker-1', 'Alice')]

    expect(mergeTerminalRuns(actual, optimistic, 'ws-1')).toEqual(actual)
  })
})

describe('useOptimisticTerminalRuns', () => {
  test('records multiple optimistic workspace shell runs with the same shell agent id', () => {
    const { result } = renderHook(() => useOptimisticTerminalRuns('ws-1', []))

    act(() => {
      result.current.recordOptimisticRun({
        agentId: 'ws-1:shell',
        agentName: 'Shell',
        runId: 'shell-run-1',
        status: 'running',
        workspaceId: 'ws-1',
      })
      result.current.recordOptimisticRun({
        agentId: 'ws-1:shell',
        agentName: 'Shell',
        runId: 'shell-run-2',
        status: 'running',
        workspaceId: 'ws-1',
      })
    })

    expect(result.current.optimisticRunsByWorkspaceId['ws-1']?.map((run) => run.run_id)).toEqual([
      'shell-run-1',
      'shell-run-2',
    ])
    expect(result.current.terminalRuns.map((run) => run.run_id)).toEqual([
      'shell-run-1',
      'shell-run-2',
    ])
  })

  test('forgets an optimistic workspace shell run by run id', () => {
    const { result } = renderHook(() => useOptimisticTerminalRuns('ws-1', []))

    act(() => {
      result.current.recordOptimisticRun({
        agentId: 'ws-1:shell',
        agentName: 'Shell',
        runId: 'shell-run-1',
        workspaceId: 'ws-1',
      })
      result.current.forgetOptimisticRun('ws-1', 'shell-run-1')
    })

    expect(result.current.optimisticRunsByWorkspaceId['ws-1']).toEqual([])
    expect(result.current.terminalRuns).toEqual([])
  })

  test('expires an optimistic workspace shell run that polling never confirms', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOptimisticTerminalRuns('ws-1', []))

    act(() => {
      result.current.recordOptimisticRun({
        agentId: 'ws-1:shell',
        agentName: 'Shell',
        runId: 'fast-exit-shell-run',
        workspaceId: 'ws-1',
      })
    })
    expect(result.current.terminalRuns.map((run) => run.run_id)).toEqual(['fast-exit-shell-run'])

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(result.current.optimisticRunsByWorkspaceId['ws-1']).toEqual([])
    expect(result.current.terminalRuns).toEqual([])
  })

  test('drops an optimistic shell run once polling observes the real run', async () => {
    const shell = terminalRun('shell-run-1', 'ws-1:shell', 'Shell')
    const { rerender, result } = renderHook(
      ({ actualRuns }) => useOptimisticTerminalRuns('ws-1', actualRuns),
      { initialProps: { actualRuns: [] as TerminalRunSummary[] } }
    )

    act(() => {
      result.current.recordOptimisticRun({
        agentId: shell.agent_id,
        agentName: shell.agent_name,
        runId: shell.run_id,
        status: shell.status,
        workspaceId: 'ws-1',
      })
    })
    expect(result.current.optimisticRunsByWorkspaceId['ws-1']?.map((run) => run.run_id)).toEqual([
      shell.run_id,
    ])

    rerender({ actualRuns: [shell] })
    await waitFor(() => {
      expect(result.current.optimisticRunsByWorkspaceId['ws-1']).toEqual([])
    })
    expect(result.current.terminalRuns).toEqual([shell])

    rerender({ actualRuns: [] })
    await waitFor(() => {
      expect(result.current.terminalRuns).toEqual([])
    })
  })
})
