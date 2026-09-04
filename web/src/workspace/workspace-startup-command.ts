const STORAGE_KEY = 'gachi.orchestrator.startup-command'

type StartupMap = Record<string, string>

/**
 * Remembers the last startup command used per orchestrator CLI preset and
 * prefills it the next time the same CLI is chosen when creating a workspace.
 * Stored in localStorage (browser-only), so the runtime never sees it.
 */
const readMap = (): StartupMap => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StartupMap
    }
    return {}
  } catch {
    return {}
  }
}

const writeMap = (map: StartupMap): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable (e.g. private mode) — persist nothing.
  }
}

export const getLastStartupCommand = (presetId: string): string => readMap()[presetId] ?? ''

export const setLastStartupCommand = (presetId: string, command: string): void => {
  const trimmed = command.trim()
  const map = readMap()
  if (trimmed) {
    map[presetId] = trimmed
  } else {
    delete map[presetId]
  }
  writeMap(map)
}
