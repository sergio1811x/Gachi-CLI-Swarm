import { useEffect, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkers } from './api.js'

export const REFRESH_INTERVAL_MS = 2000
const MAX_REFRESH_INTERVAL_MS = 5000

const toRuntimeSocketUrl = (workspaceId: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/tasks/${workspaceId}`
}

const getRefreshDelay = (failureCount: number) =>
  Math.min(REFRESH_INTERVAL_MS * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)

const areWorkersEqual = (a: TeamListItem[], b: TeamListItem[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((worker, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      worker.id === other.id &&
      worker.lastPtyLine === other.lastPtyLine &&
      worker.lifecycleStatus === other.lifecycleStatus &&
      worker.name === other.name &&
      worker.pendingTaskCount === other.pendingTaskCount &&
      worker.role === other.role &&
      worker.status === other.status
    )
  })
}

const areWorkerMapsEqual = (
  a: Record<string, TeamListItem[]>,
  b: Record<string, TeamListItem[]>
): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return bKeys.every((workspaceId) => areWorkersEqual(a[workspaceId] ?? [], b[workspaceId] ?? []))
}

export const useWorkspaceWorkers = (workspaceIds: readonly string[]) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  useEffect(() => {
    if (!workspaceKey) {
      setWorkersByWorkspaceId({})
      return
    }
    let cancelled = false
    let inFlight = false
    let failureCount = 0
    let timeout: number | undefined
    // Reject stale WS events: each workspace tracks the highest entityVersion
    // already applied so out-of-order/duplicate frames never trigger a reload.
    const lastEntityVersionByWorkspaceId = new Map<string, number>()
    const ids = workspaceKey.split('\0')
    const scheduleNextLoad = () => {
      if (!cancelled) timeout = window.setTimeout(loadWorkers, getRefreshDelay(failureCount))
    }
    const loadWorkers = () => {
      if (inFlight) return
      inFlight = true
      void Promise.all(
        ids.map(async (workspaceId) => {
          try {
            return [workspaceId, await listWorkers(workspaceId)] as const
          } catch (error) {
            console.error('[gachi] swallowed:workspaceWorkers.list', error)
            return null
          }
        })
      )
        .then((results) => {
          if (cancelled) return
          failureCount = results.some(Boolean) ? 0 : Math.min(failureCount + 1, 4)
          setWorkersByWorkspaceId((current) => {
            const next: Record<string, TeamListItem[]> = {}
            for (const workspaceId of ids) next[workspaceId] = current[workspaceId] ?? []
            for (const result of results) {
              if (result) next[result[0]] = result[1]
            }
            return areWorkerMapsEqual(current, next) ? current : next
          })
        })
        .finally(() => {
          inFlight = false
          scheduleNextLoad()
        })
    }
    const sockets: WebSocket[] = []
    const openRuntimeSockets = () => {
      for (const workspaceId of ids) {
        if (cancelled) return
        // WebSocket is a non-critical enhancement (push lowers latency); some
        // embedded webviews lack the constructor entirely — poll then.
        let socket: WebSocket
        try {
          socket = new WebSocket(toRuntimeSocketUrl(workspaceId))
        } catch {
          continue
        }
        sockets.push(socket)
        socket.onmessage = (event) => {
          if (cancelled) return
          try {
            const payload = JSON.parse(event.data) as {
              entityVersion?: number
              type?: string
              updatedAt?: number
            }
            if (payload.type !== 'AGENT_STATUS_CHANGED') return
            const version = payload.entityVersion ?? payload.updatedAt ?? 0
            const lastSeen = lastEntityVersionByWorkspaceId.get(workspaceId) ?? 0
            if (version <= lastSeen) return
            lastEntityVersionByWorkspaceId.set(workspaceId, version)
            loadWorkers()
          } catch {
            // Malformed runtime event — ignore, the poller still catches up.
          }
        }
        socket.onerror = () => {
          socket.close()
        }
      }
    }
    loadWorkers()
    openRuntimeSockets()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      for (const socket of sockets) socket.close()
    }
  }, [workspaceKey])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
