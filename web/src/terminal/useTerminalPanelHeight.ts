import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useState } from 'react'

const HEIGHT_KEY = 'gachi.terminal-panel.height'
const COLLAPSED_KEY = 'gachi.terminal-panel.collapsed'

export const TERMINAL_PANEL_MIN_HEIGHT = 160
const DEFAULT_RATIO = 0.35
const BOTTOM_SAFE_AREA = 160

const clampHeight = (value: number): number => {
  const viewport = typeof window !== 'undefined' ? window.innerHeight : 800
  const maxHeight = Math.max(TERMINAL_PANEL_MIN_HEIGHT, viewport - BOTTOM_SAFE_AREA)
  return Math.min(Math.max(value, TERMINAL_PANEL_MIN_HEIGHT), maxHeight)
}

const computeDefaultHeight = (): number => {
  const viewport = typeof window !== 'undefined' ? window.innerHeight : 800
  return clampHeight(Math.floor(viewport * DEFAULT_RATIO))
}

const readStoredHeight = (): number => {
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY)
    if (!raw) return computeDefaultHeight()
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clampHeight(parsed) : computeDefaultHeight()
  } catch {
    return computeDefaultHeight()
  }
}

const readStoredCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Drives the horizontal splitter on top of the bottom terminal panel inside
 * the right column. Height is persisted globally so layout sticks across
 * reloads regardless of workspace. Collapsed is a global preference for the
 * panel itself, not per-workspace.
 */
export const useTerminalPanelHeight = () => {
  const [height, setHeightRaw] = useState<number>(() => readStoredHeight())
  const [collapsed, setCollapsedRaw] = useState<boolean>(() => readStoredCollapsed())
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(Math.round(height)))
    } catch {
      // quota / private browsing — silently keep in-memory value
    }
  }, [height])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // ignored
    }
  }, [collapsed])

  useEffect(() => {
    const handleResize = () => setHeightRaw((h) => clampHeight(h))
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const setHeight = useCallback((next: number) => setHeightRaw(clampHeight(next)), [])
  const setCollapsed = useCallback((next: boolean) => setCollapsedRaw(next), [])

  const beginDrag = useCallback(
    (startEvent: ReactPointerEvent<HTMLDivElement>) => {
      startEvent.preventDefault()
      const startY = startEvent.clientY
      let startHeight = height
      setHeightRaw((current) => {
        startHeight = current
        return current
      })
      setDragging(true)

      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'ns-resize'
      document.body.style.userSelect = 'none'

      const handleMove = (ev: PointerEvent) => {
        // Dragging UP grows the panel; deltaY is negative when moving up.
        const delta = ev.clientY - startY
        setHeightRaw(clampHeight(startHeight - delta))
      }
      const handleUp = () => {
        setDragging(false)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        document.removeEventListener('pointercancel', handleUp)
      }
      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
      document.addEventListener('pointercancel', handleUp)
    },
    [height]
  )

  return { height, collapsed, dragging, setHeight, setCollapsed, beginDrag }
}
