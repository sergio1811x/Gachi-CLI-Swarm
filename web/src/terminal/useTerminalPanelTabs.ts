import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { isWorkspaceShellRun } from '../api.js'
import { findRunByAgentId } from './useTerminalRuns.js'

export type TerminalTab =
  | { id: string; kind: 'worker'; workerId: string; runId: string | null; label: string }
  | { id: string; kind: 'shell'; runId: string; label: string }

const tabsKey = (workspaceId: string) => `gachi.terminal-panel.tabs.${workspaceId}`
const activeKey = (workspaceId: string) => `gachi.terminal-panel.active.${workspaceId}`

const workerTabId = (workerId: string) => `worker:${workerId}`
const shellTabId = (runId: string) => `shell:${runId}`

const readStoredIds = (key: string): string[] => {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

const readStoredActive = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

const writeStored = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignored
  }
}

type Params = {
  workspaceId: string
  workers: TeamListItem[]
  terminalRuns: TerminalRunSummary[]
}

/**
 * Owns the bottom-panel tab list + active tab per workspace.
 *
 * The stored state is just an ordered list of tab ids (e.g. `worker:abc` /
 * `shell:run-x`) — display data is re-derived each render from `workers` /
 * `terminalRuns` so a deleted worker or a stopped shell automatically drops
 * its tab. Persistence is per-workspace; switching workspaces swaps the
 * loaded list without touching localStorage for the others.
 */
export const useTerminalPanelTabs = ({ workspaceId, workers, terminalRuns }: Params) => {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => readStoredIds(tabsKey(workspaceId)))
  const [activeId, setActiveIdRaw] = useState<string | null>(() => {
    const stored = readStoredActive(activeKey(workspaceId))
    return stored.length > 0 ? stored : null
  })
  // Latest-orderedIds ref so callbacks can compute next state synchronously
  // (avoids nested setState-in-updater patterns flagged by the reviewer).
  const orderedIdsRef = useRef(orderedIds)
  orderedIdsRef.current = orderedIds
  // Reload from localStorage when switching workspaces.
  const lastWorkspaceRef = useRef<string>(workspaceId)

  useEffect(() => {
    if (lastWorkspaceRef.current === workspaceId) return
    lastWorkspaceRef.current = workspaceId
    setOrderedIds(readStoredIds(tabsKey(workspaceId)))
    const stored = readStoredActive(activeKey(workspaceId))
    setActiveIdRaw(stored.length > 0 ? stored : null)
  }, [workspaceId])

  // The reviewer flagged a silent data-loss bug: on workspace switch the
  // poll-driven workers/runs arrive a tick AFTER the stored ids reload, so
  // `tabs` derives to [] for one render, the gc effect filters orderedIds
  // to [], and the persistence effect writes [] back to localStorage. We
  // gate BOTH the gc and the persistence on `dataLoaded` — true once we
  // observe a non-empty snapshot for this workspaceId, or once the user
  // explicitly opens a tab.
  const dataLoadedRef = useRef(false)
  // Reset on workspace switch. workers/terminalRuns are deliberately excluded
  // from the deps because we want this effect to "zero out" the gate exactly
  // when the workspace id flips — the next effect below promotes the gate
  // back to true once data arrives for the new workspace.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace-switch reset is intentional
  useEffect(() => {
    dataLoadedRef.current = workers.length > 0 || terminalRuns.length > 0
  }, [workspaceId])
  // Promote the gate to true as soon as workers/runs deliver any data for
  // the current workspace. This effect (not a render-time ref mutation)
  // avoids the StrictMode double-render anti-pattern flagged by review.
  useEffect(() => {
    if (workers.length > 0 || terminalRuns.length > 0) dataLoadedRef.current = true
  }, [workers, terminalRuns])

  useEffect(() => {
    if (!dataLoadedRef.current) return
    writeStored(tabsKey(workspaceId), JSON.stringify(orderedIds))
  }, [orderedIds, workspaceId])

  useEffect(() => {
    if (!dataLoadedRef.current) return
    writeStored(activeKey(workspaceId), activeId ?? '')
  }, [activeId, workspaceId])

  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w] as const)), [workers])
  const shellRunById = useMemo(() => {
    const map = new Map<string, TerminalRunSummary>()
    for (const run of terminalRuns) {
      if (isWorkspaceShellRun(run, workspaceId)) map.set(run.run_id, run)
    }
    return map
  }, [terminalRuns, workspaceId])

  const tabs = useMemo<TerminalTab[]>(() => {
    const out: TerminalTab[] = []
    for (const id of orderedIds) {
      if (id.startsWith('worker:')) {
        const workerId = id.slice('worker:'.length)
        const worker = workerById.get(workerId)
        if (!worker) continue
        const run = findRunByAgentId(terminalRuns, worker.id)
        out.push({
          id,
          kind: 'worker',
          workerId,
          runId: run?.run_id ?? null,
          label: worker.name,
        })
      } else if (id.startsWith('shell:')) {
        const runId = id.slice('shell:'.length)
        const run = shellRunById.get(runId)
        if (!run) continue
        out.push({ id, kind: 'shell', runId, label: run.agent_name })
      }
    }
    return out
  }, [orderedIds, workerById, shellRunById, terminalRuns])

  // GC ids whose referent is gone — only after we've observed at least one
  // populated snapshot for this workspace. Empty workers/runs is treated as
  // "still loading", not "everything was deleted".
  //
  // Survivors are computed inside the setOrderedIds updater from the latest
  // workerById/shellRunById, not from a `tabs` closure. The closure form
  // races with the workspace-switch setOrderedIds: when both fire in the
  // same cycle, the updater would see the new orderedIds but a stale
  // `surviving` set built from the previous tabs render, and would filter
  // everything out.
  useEffect(() => {
    if (!dataLoadedRef.current) return
    setOrderedIds((current) => {
      const next = current.filter((id) => {
        if (id.startsWith('worker:')) return workerById.has(id.slice('worker:'.length))
        if (id.startsWith('shell:')) return shellRunById.has(id.slice('shell:'.length))
        return false
      })
      return next.length === current.length ? current : next
    })
  }, [workerById, shellRunById])

  // Reactivate something if active points to a dead tab.
  useEffect(() => {
    if (!dataLoadedRef.current) return
    if (activeId && tabs.some((tab) => tab.id === activeId)) return
    setActiveIdRaw(tabs[0]?.id ?? null)
  }, [activeId, tabs])

  const openWorkerTab = useCallback((workerId: string) => {
    // User action also counts as "data loaded" — they explicitly want a tab.
    dataLoadedRef.current = true
    const id = workerTabId(workerId)
    setOrderedIds((current) => (current.includes(id) ? current : [...current, id]))
    setActiveIdRaw(id)
  }, [])

  const openShellTab = useCallback((runId: string) => {
    dataLoadedRef.current = true
    const id = shellTabId(runId)
    setOrderedIds((current) => (current.includes(id) ? current : [...current, id]))
    setActiveIdRaw(id)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    const before = orderedIdsRef.current
    const next = before.filter((id) => id !== tabId)
    if (next.length === before.length) return
    setOrderedIds(next)
    setActiveIdRaw((activeNow) => {
      if (activeNow !== tabId) return activeNow
      const idx = before.indexOf(tabId)
      return next[idx] ?? next[idx - 1] ?? next[0] ?? null
    })
  }, [])

  const setActive = useCallback((tabId: string) => setActiveIdRaw(tabId), [])

  return { tabs, activeId, openWorkerTab, openShellTab, closeTab, setActive }
}
