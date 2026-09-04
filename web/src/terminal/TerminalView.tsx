import '@xterm/xterm/css/xterm.css'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useTerminalRun } from './useTerminalRun.js'
import type { TerminalWheelInputProfile } from './wheelFallback.js'

const STATUS_KEYS: Record<string, TranslationKey> = {
  connecting: 'terminal.statusConnecting',
  running: 'terminal.statusRunning',
  stopped: 'common.stopped',
}

interface TerminalViewProps {
  inputProfile?: TerminalWheelInputProfile
  runId: string
  title: string
}

const TERMINAL_PARKING_LOT_ID = 'gachi-terminal-parking-lot'
const PARKED_TERMINAL_DISPOSE_DELAY_MS = 500

const candidateIds = (runId: string): string[] => [
  `worker-pty-${runId}`,
  `orch-pty-${runId}`,
  `shell-pty-${runId}`,
]

const getLastElementById = (id: string): HTMLElement | null => {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[id]')).filter(
    (node) => node.id === id
  )
  return matches[matches.length - 1] ?? null
}

const getTerminalParkingLot = (): HTMLElement => {
  let node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (!node) {
    node = document.createElement('div')
    node.id = TERMINAL_PARKING_LOT_ID
    node.hidden = true
    node.style.display = 'none'
    const parent = document.body ?? document.documentElement
    parent.appendChild(node)
  }
  return node
}

const cleanupTerminalParkingLot = (): void => {
  const node = document.getElementById(TERMINAL_PARKING_LOT_ID)
  if (node && node.childElementCount === 0) node.remove()
}

const portalTargetSubscribers = new Set<() => void>()
let portalTargetObserver: MutationObserver | undefined
let portalTargetPollTimer: number | undefined

const notifyPortalTargetSubscribers = (): void => {
  for (const subscriber of portalTargetSubscribers) subscriber()
}

const stopPortalTargetWatcher = (): void => {
  portalTargetObserver?.disconnect()
  portalTargetObserver = undefined
  if (portalTargetPollTimer !== undefined) {
    window.clearInterval(portalTargetPollTimer)
    portalTargetPollTimer = undefined
  }
}

const ensurePortalTargetWatcher = (): void => {
  if (portalTargetObserver || portalTargetPollTimer !== undefined) return
  const root = document.body ?? document.documentElement
  if (typeof MutationObserver !== 'undefined' && root) {
    portalTargetObserver = new MutationObserver(notifyPortalTargetSubscribers)
    portalTargetObserver.observe(root, {
      attributeFilter: ['id'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    return
  }
  portalTargetPollTimer = window.setInterval(notifyPortalTargetSubscribers, 100)
}

const subscribePortalTargetChanges = (subscriber: () => void): (() => void) => {
  portalTargetSubscribers.add(subscriber)
  ensurePortalTargetWatcher()
  return () => {
    portalTargetSubscribers.delete(subscriber)
    if (portalTargetSubscribers.size === 0) stopPortalTargetWatcher()
  }
}

const scheduleVisibleTerminalResize = (): void => {
  const dispatch = () => window.dispatchEvent(new Event('resize'))
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(dispatch)
    return
  }
  window.setTimeout(dispatch, 0)
}

const usePortalTarget = (runId: string): HTMLElement | null => {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const ids = candidateIds(runId)
    const resolve = () => {
      for (const id of ids) {
        const node = getLastElementById(id)
        if (node) return node
      }
      return null
    }
    const refreshTarget = () => {
      const node = resolve()
      setTarget((current) => (current === node ? current : node))
    }
    refreshTarget()
    return subscribePortalTargetChanges(refreshTarget)
  }, [runId])
  return target
}

const useStablePortalHost = (runId: string, target: HTMLElement | null): HTMLElement | null => {
  const [activated, setActivated] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const hostRef = useRef<HTMLElement | null>(null)

  const clearDisposeTimer = useCallback(() => {
    if (disposeTimerRef.current === undefined) return
    window.clearTimeout(disposeTimerRef.current)
    disposeTimerRef.current = undefined
  }, [])

  useLayoutEffect(() => {
    const node = document.createElement('div')
    node.dataset.terminalHostRunId = runId
    node.dataset.terminalHostParked = 'false'
    node.className = 'h-full min-h-0 w-full min-w-0'
    hostRef.current = node
    setHost(node)
    return () => {
      clearDisposeTimer()
      node.remove()
      hostRef.current = null
      cleanupTerminalParkingLot()
    }
  }, [clearDisposeTimer, runId])

  useLayoutEffect(() => {
    if (target) {
      clearDisposeTimer()
      setActivated(true)
      return
    }
    if (!activated || disposeTimerRef.current !== undefined) return

    disposeTimerRef.current = window.setTimeout(() => {
      disposeTimerRef.current = undefined
      setActivated(false)
    }, PARKED_TERMINAL_DISPOSE_DELAY_MS)
    return clearDisposeTimer
  }, [activated, clearDisposeTimer, target])

  useLayoutEffect(() => {
    const node = hostRef.current
    if (!node) return
    if (!activated) {
      node.remove()
      node.dataset.terminalHostParked = 'false'
      cleanupTerminalParkingLot()
      return
    }

    const parent = target ?? getTerminalParkingLot()
    if (node.parentElement === parent) return

    const hadParent = node.parentElement !== null
    const activeElement = document.activeElement
    if (!target && activeElement instanceof HTMLElement && node.contains(activeElement)) {
      activeElement.blur()
    }
    node.dataset.terminalHostParked = target ? 'false' : 'true'
    parent.appendChild(node)
    cleanupTerminalParkingLot()

    if (target && hadParent) scheduleVisibleTerminalResize()
  }, [activated, target])

  return activated ? host : null
}

export const TerminalView = ({ inputProfile = 'default', runId, title }: TerminalViewProps) => {
  const portalTarget = usePortalTarget(runId)
  const host = useStablePortalHost(runId, portalTarget)

  if (!host) return null
  return createPortal(
    <TerminalPtyView inputProfile={inputProfile} runId={runId} title={title} />,
    host
  )
}

const TerminalPtyView = ({ inputProfile, runId, title: _title }: TerminalViewProps) => {
  const { t } = useI18n()
  const { containerRef, error, status } = useTerminalRun(runId, inputProfile)
  const statusKey = STATUS_KEYS[status]
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <p className="sr-only">{statusKey ? t(statusKey) : status}</p>
      {error ? (
        <p
          role="alert"
          className="mono shrink-0 break-words px-3 py-2 text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
            borderBottom: '1px solid color-mix(in oklab, var(--status-red) 30%, transparent)',
            color: 'var(--status-red)',
          }}
        >
          {error}
        </p>
      ) : null}
      <div
        data-testid={`terminal-${runId}`}
        ref={containerRef}
        className="bg-crust h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      />
    </div>
  )
}
