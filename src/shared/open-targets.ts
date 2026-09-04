/**
 * Cross-cutting types for the "Open workspace in editor/app" feature.
 * Both the server (command construction in `src/server/open-target-commands.ts`)
 * and the web client (button + preference store in `web/src/workspace/open-targets.ts`)
 * pull the union and platform whitelist from here so they cannot drift.
 */

export type OpenTargetId =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'finder'
  | 'terminal'
  | 'ghostty'
  | 'zed'

export type OpenTargetPlatform = 'mac' | 'windows' | 'linux' | 'other'

// Note: there is no `cursor-insiders` here. Cursor stopped shipping a separate
// Nightly bundle / `cursor-nightly` binary in March 2024; the pre-release
// channel is now an in-app toggle on the regular Cursor.app.
//
// IntelliJ IDEA, Windsurf, and iTerm2 were intentionally dropped after 1.3.0:
// IntelliJ users typically launch from JetBrains Toolbox rather than a folder
// picker; Windsurf overlaps with Cursor/VS Code; iTerm2 overlaps with the
// built-in macOS Terminal entry.
export const OPEN_TARGET_IDS_BY_PLATFORM: Record<OpenTargetPlatform, readonly OpenTargetId[]> = {
  mac: ['vscode', 'vscode-insiders', 'cursor', 'finder', 'terminal', 'ghostty', 'zed'],
  windows: ['vscode', 'vscode-insiders', 'cursor', 'finder', 'zed'],
  linux: ['vscode', 'vscode-insiders', 'cursor', 'finder', 'zed'],
  other: ['vscode', 'vscode-insiders', 'finder'],
}

const ALL_TARGET_IDS = new Set<OpenTargetId>(OPEN_TARGET_IDS_BY_PLATFORM.mac)

export const isOpenTargetId = (value: unknown): value is OpenTargetId =>
  typeof value === 'string' && ALL_TARGET_IDS.has(value as OpenTargetId)

export const isOpenTargetSupported = (
  targetId: OpenTargetId,
  platform: OpenTargetPlatform
): boolean => OPEN_TARGET_IDS_BY_PLATFORM[platform].includes(targetId)

/**
 * The id the server will actually attempt to launch. If the user's saved
 * preference is unsupported on the current platform (e.g. they picked iTerm2
 * on a Mac, then opened it on Windows), fall back to the platform default
 * rather than erroring out — a stale preference shouldn't break the button.
 */
export const getEffectiveOpenTargetId = (
  targetId: OpenTargetId,
  platform: OpenTargetPlatform
): OpenTargetId =>
  isOpenTargetSupported(targetId, platform) ? targetId : getDefaultOpenTargetIdForPlatform(platform)

export const getDefaultOpenTargetIdForPlatform = (platform: OpenTargetPlatform): OpenTargetId => {
  // `finder` exists for every platform and never fails closed.
  if (platform === 'mac' || platform === 'windows' || platform === 'linux') return 'finder'
  return 'vscode'
}

export type OpenWorkspaceErrorCode =
  | 'invalid-path'
  | 'invalid-target'
  | 'app-not-installed'
  | 'command-not-in-path'
  | 'unknown'
