// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { TerminalRunSummary } from '../../web/src/api.js'
import {
  type TerminalTab,
  useTerminalPanelTabs,
} from '../../web/src/terminal/useTerminalPanelTabs.js'

const WORKSPACE_ID = 'ws-1'
const TABS_KEY = `gachi.terminal-panel.tabs.${WORKSPACE_ID}`
const ACTIVE_KEY = `gachi.terminal-panel.active.${WORKSPACE_ID}`

const buildRun = (overrides: Partial<TerminalRunSummary> = {}): TerminalRunSummary => ({
  agent_id: 'worker-a',
  agent_name: 'Alice',
  run_id: 'run-a',
  status: 'running',
  ...overrides,
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('useTerminalPanelTabs', () => {
  test('starts with no tabs and no active id', () => {
    const { result } = renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers: [], terminalRuns: [] })
    )
    expect(result.current.tabs).toEqual([])
    expect(result.current.activeId).toBeNull()
  })

  test('openWorkerTab adds, persists, and activates the worker tab', () => {
    const workers = [
      {
        id: 'worker-a',
        name: 'Alice',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
    ]
    const { result } = renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers, terminalRuns: [] })
    )
    act(() => result.current.openWorkerTab('worker-a'))
    expect(result.current.tabs.map((t) => t.id)).toEqual(['worker:worker-a'])
    expect(result.current.activeId).toBe('worker:worker-a')
    expect(JSON.parse(window.localStorage.getItem(TABS_KEY) ?? '[]')).toEqual(['worker:worker-a'])
    expect(window.localStorage.getItem(ACTIVE_KEY)).toBe('worker:worker-a')
  })

  test('openShellTab adds, persists, and activates the shell tab', () => {
    const run = buildRun({
      agent_id: `${WORKSPACE_ID}:shell`,
      run_id: 'run-shell',
      agent_name: 'shell',
    })
    const { result } = renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers: [], terminalRuns: [run] })
    )
    act(() => result.current.openShellTab('run-shell'))
    expect(result.current.tabs.map((t) => t.id)).toEqual(['shell:run-shell'])
    expect(result.current.activeId).toBe('shell:run-shell')
  })

  test('closeTab removes and reactivates a neighbor', () => {
    const workers = [
      {
        id: 'worker-a',
        name: 'Alice',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
      {
        id: 'worker-b',
        name: 'Bob',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
    ]
    const { result } = renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers, terminalRuns: [] })
    )
    act(() => result.current.openWorkerTab('worker-a'))
    act(() => result.current.openWorkerTab('worker-b'))
    expect(result.current.activeId).toBe('worker:worker-b')
    act(() => result.current.closeTab('worker:worker-b'))
    expect(result.current.tabs.map((t) => t.id)).toEqual(['worker:worker-a'])
    expect(result.current.activeId).toBe('worker:worker-a')
  })

  test('opening an already-open tab just reactivates it (no duplicate)', () => {
    const workers = [
      {
        id: 'worker-a',
        name: 'Alice',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
      {
        id: 'worker-b',
        name: 'Bob',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
    ]
    const { result } = renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers, terminalRuns: [] })
    )
    act(() => result.current.openWorkerTab('worker-a'))
    act(() => result.current.openWorkerTab('worker-b'))
    act(() => result.current.openWorkerTab('worker-a'))
    expect(result.current.tabs.map((t) => t.id)).toEqual(['worker:worker-a', 'worker:worker-b'])
    expect(result.current.activeId).toBe('worker:worker-a')
  })

  test('worker tab disappears when worker is removed from workers prop', () => {
    const workers = [
      {
        id: 'worker-a',
        name: 'Alice',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
    ]
    const { rerender, result } = renderHook(
      ({ ws }: { ws: typeof workers }) =>
        useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers: ws, terminalRuns: [] }),
      { initialProps: { ws: workers } }
    )
    act(() => result.current.openWorkerTab('worker-a'))
    expect(result.current.tabs).toHaveLength(1)
    rerender({ ws: [] })
    expect(result.current.tabs).toEqual([])
    expect(result.current.activeId).toBeNull()
  })

  test('switching workspaceId loads that workspace’s persisted tab list', () => {
    window.localStorage.setItem('gachi.terminal-panel.tabs.ws-2', JSON.stringify(['worker:zzz']))
    window.localStorage.setItem('gachi.terminal-panel.active.ws-2', 'worker:zzz')
    const workers = [
      {
        id: 'zzz',
        name: 'Zed',
        role: 'coder' as const,
        status: 'idle' as const,
        pendingTaskCount: 0,
      },
    ]
    const { rerender, result } = renderHook(
      ({ wsId }: { wsId: string }) =>
        useTerminalPanelTabs({ workspaceId: wsId, workers, terminalRuns: [] }),
      { initialProps: { wsId: WORKSPACE_ID } }
    )
    expect(result.current.tabs).toEqual([])
    rerender({ wsId: 'ws-2' })
    expect(result.current.tabs.map((t: TerminalTab) => t.id)).toEqual(['worker:zzz'])
    expect(result.current.activeId).toBe('worker:zzz')
  })

  test('cold load with empty workers/runs preserves stored tab ids (no gc wipe)', () => {
    // Repro: workspace switch leaves `workers`/`terminalRuns` momentarily
    // empty (poll latency). The gc effect must NOT fire — otherwise stored
    // ids get filtered to [] and the persistence effect overwrites
    // localStorage with [], silently destroying the user's tab list.
    window.localStorage.setItem(TABS_KEY, JSON.stringify(['worker:a', 'shell:run-x']))
    window.localStorage.setItem(ACTIVE_KEY, 'shell:run-x')
    renderHook(() =>
      useTerminalPanelTabs({ workspaceId: WORKSPACE_ID, workers: [], terminalRuns: [] })
    )
    // Tabs derive to [] because workers/runs are empty, but localStorage
    // must not be rewritten to [].
    expect(window.localStorage.getItem(TABS_KEY)).toBe(JSON.stringify(['worker:a', 'shell:run-x']))
    expect(window.localStorage.getItem(ACTIVE_KEY)).toBe('shell:run-x')
  })
})
