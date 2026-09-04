import { useEffect, useRef, useState } from 'react'

/**
 * Live task-board events (audit M-5): the tasks WebSocket already pushes
 * QUEUE_UPDATED / RUN_PROGRESS / task transitions with entityVersion, so the
 * kanban board can treat push as the primary refresh path and keep polling
 * only as a slow reconnect safety net.
 *
 * Returns whether the socket is currently healthy so callers can lengthen
 * their fallback interval while push is delivering updates.
 */
export const useTasksEvents = (
  workspaceId: string | null | undefined,
  onEvent: () => void
): boolean => {
  const [healthy, setHealthy] = useState(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!workspaceId) {
      setHealthy(false)
      return
    }
    let cancelled = false
    let socket: WebSocket | null = null
    let retryCount = 0
    let reconnectTimer: number | undefined
    let debounceTimer: number | undefined

    const scheduleReconnect = () => {
      if (cancelled) return
      retryCount = Math.min(retryCount + 1, 5)
      reconnectTimer = window.setTimeout(connect, 1000 * 2 ** retryCount)
    }

    const connect = () => {
      if (cancelled) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/tasks/${workspaceId}`)
      socket.onopen = () => {
        retryCount = 0
        setHealthy(true)
      }
      socket.onmessage = () => {
        // Coalesce bursts of frames into one debounced refresh.
        if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
        debounceTimer = window.setTimeout(() => onEventRef.current(), 250)
      }
      socket.onclose = () => {
        setHealthy(false)
        scheduleReconnect()
      }
      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
      socket?.close()
    }
  }, [workspaceId])

  return healthy
}
