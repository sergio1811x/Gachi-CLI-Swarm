import { useEffect, useRef } from 'react'

export type ShortcutAction = 'add-workspace'

const KNOWN_ACTIONS = new Set<ShortcutAction>(['add-workspace'])

const isShortcutAction = (value: string | null): value is ShortcutAction =>
  value !== null && (KNOWN_ACTIONS as Set<string>).has(value)

export interface UseShortcutActionOptions {
  onAddWorkspace: () => void
  /**
   * Gate so the action fires only after the app has bootstrapped (workspaces
   * loaded, providers in place). Toggling this from `false` to `true`
   * triggers the dispatch exactly once per session.
   */
  ready: boolean
}

/**
 * Consume a `?action=…` query param coming from a manifest shortcut. Only
 * known actions in the whitelist are honored — everything else (including
 * extra query params alongside) is silently ignored. After dispatch the
 * query string is cleared with `history.replaceState` so subsequent reloads
 * don't re-fire the action.
 */
export const useShortcutAction = ({ onAddWorkspace, ready }: UseShortcutActionOptions): void => {
  const handled = useRef(false)

  useEffect(() => {
    if (!ready || handled.current) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const action = params.get('action')
    if (!isShortcutAction(action)) return
    handled.current = true
    window.history.replaceState({}, '', window.location.pathname)
    if (action === 'add-workspace') onAddWorkspace()
  }, [ready, onAddWorkspace])
}
