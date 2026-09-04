import {
  getDefaultOpenTargetIdForPlatform,
  isOpenTargetId,
  isOpenTargetSupported,
  OPEN_TARGET_IDS_BY_PLATFORM,
  type OpenTargetId,
  type OpenTargetPlatform,
} from '../../../src/shared/open-targets.js'
import cursorIcon from '../assets/open-targets/cursor.svg'
import finderIcon from '../assets/open-targets/finder.png'
import ghosttyIcon from '../assets/open-targets/ghostty.png'
import terminalIcon from '../assets/open-targets/terminal.svg'
import vscodeIcon from '../assets/open-targets/vscode.svg'
import vscodeInsidersIcon from '../assets/open-targets/vscode-insiders.svg'
import zedIcon from '../assets/open-targets/zed.png'

export type { OpenTargetId, OpenTargetPlatform }
export { getDefaultOpenTargetIdForPlatform, isOpenTargetSupported, OPEN_TARGET_IDS_BY_PLATFORM }

export interface OpenTargetOption {
  id: OpenTargetId
  /**
   * i18n key for the display label. Translation lives in `i18n.tsx` so that
   * "Finder" → "File Explorer" / "File Manager" stays consistent with the UI
   * language toggle rather than being keyed off the OS platform.
   */
  labelKey:
    | 'openWorkspace.target.vscode'
    | 'openWorkspace.target.vscodeInsiders'
    | 'openWorkspace.target.cursor'
    | 'openWorkspace.target.finder.mac'
    | 'openWorkspace.target.finder.windows'
    | 'openWorkspace.target.finder.linux'
    | 'openWorkspace.target.terminal'
    | 'openWorkspace.target.ghostty'
    | 'openWorkspace.target.zed'
  iconSrc: string
  /**
   * Optional per-icon visual scale relative to the default render size.
   * Defaults to 1. Use sparingly — only when the brand mark has so much built-in
   * padding that it visibly reads smaller than its row neighbors.
   */
  iconScale?: number
}

const FINDER_LABEL_KEY_BY_PLATFORM: Record<OpenTargetPlatform, OpenTargetOption['labelKey']> = {
  mac: 'openWorkspace.target.finder.mac',
  windows: 'openWorkspace.target.finder.windows',
  linux: 'openWorkspace.target.finder.linux',
  other: 'openWorkspace.target.finder.linux',
}

const TARGET_DATA: Record<OpenTargetId, Omit<OpenTargetOption, 'id'>> = {
  vscode: { labelKey: 'openWorkspace.target.vscode', iconSrc: vscodeIcon },
  'vscode-insiders': {
    labelKey: 'openWorkspace.target.vscodeInsiders',
    iconSrc: vscodeInsidersIcon,
  },
  cursor: { labelKey: 'openWorkspace.target.cursor', iconSrc: cursorIcon },
  // The actual labelKey is resolved per platform in getOpenTargetOption.
  finder: { labelKey: 'openWorkspace.target.finder.mac', iconSrc: finderIcon },
  terminal: { labelKey: 'openWorkspace.target.terminal', iconSrc: terminalIcon },
  // Ghostty's brand mark is rendered inside a generous safe-zone, so at the
  // dropdown render size it reads smaller than its neighbors. Bump the visual
  // scale ~20% to balance the row.
  ghostty: { labelKey: 'openWorkspace.target.ghostty', iconSrc: ghosttyIcon, iconScale: 1.2 },
  zed: { labelKey: 'openWorkspace.target.zed', iconSrc: zedIcon },
}

const resolveLabelKey = (
  targetId: OpenTargetId,
  platform: OpenTargetPlatform
): OpenTargetOption['labelKey'] =>
  targetId === 'finder' ? FINDER_LABEL_KEY_BY_PLATFORM[platform] : TARGET_DATA[targetId].labelKey

export const getOpenTargetOption = (
  targetId: OpenTargetId,
  platform: OpenTargetPlatform
): OpenTargetOption => {
  const supportedId = isOpenTargetSupported(targetId, platform)
    ? targetId
    : getDefaultOpenTargetIdForPlatform(platform)
  const data = TARGET_DATA[supportedId]
  return {
    id: supportedId,
    iconSrc: data.iconSrc,
    labelKey: resolveLabelKey(supportedId, platform),
    ...(data.iconScale !== undefined ? { iconScale: data.iconScale } : {}),
  }
}

export const getOpenTargetOptions = (platform: OpenTargetPlatform): readonly OpenTargetOption[] =>
  OPEN_TARGET_IDS_BY_PLATFORM[platform].map((targetId) => {
    const data = TARGET_DATA[targetId]
    return {
      id: targetId,
      iconSrc: data.iconSrc,
      labelKey: resolveLabelKey(targetId, platform),
      ...(data.iconScale !== undefined ? { iconScale: data.iconScale } : {}),
    }
  })

/**
 * Browser-side platform detection. Server already validates the requested
 * target against its own platform, so a misdetection here at worst shows an
 * impossible option in the dropdown — the server falls back gracefully.
 */
export const resolveOpenTargetPlatform = (): OpenTargetPlatform => {
  if (typeof navigator === 'undefined') return 'other'
  const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (source.includes('mac') || source.includes('darwin')) return 'mac'
  if (source.includes('win')) return 'windows'
  if (source.includes('linux') || source.includes('x11')) return 'linux'
  return 'other'
}

export const PREFERRED_OPEN_TARGET_STORAGE_KEY = 'gachi.openTarget.preferred'

const readPreferredOpenTargetRaw = (): string | null => {
  try {
    return window.localStorage.getItem(PREFERRED_OPEN_TARGET_STORAGE_KEY)
  } catch {
    return null
  }
}

export const loadPersistedOpenTargetId = (platform: OpenTargetPlatform): OpenTargetId => {
  const fallback = getDefaultOpenTargetIdForPlatform(platform)
  if (typeof window === 'undefined') return fallback
  const raw = readPreferredOpenTargetRaw()
  if (!raw) return fallback
  // Tolerate the historical `ghostie` typo that shipped in the kanban port we
  // forked from. Removed-target preferences (`intellij_idea`, `intellijidea`,
  // `iterm2`, `windsurf`) intentionally fall through `isOpenTargetId` and land
  // on the platform default rather than being silently remapped to a
  // surviving target — stale UI selections aren't worth a surprise launch.
  const normalized = raw === 'ghostie' ? 'ghostty' : raw
  if (isOpenTargetId(normalized) && isOpenTargetSupported(normalized, platform)) {
    return normalized
  }
  return fallback
}

export const persistOpenTargetId = (targetId: OpenTargetId): void => {
  try {
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, targetId)
  } catch {
    // Quota exceeded / private browsing — fall back to in-memory selection.
  }
}
