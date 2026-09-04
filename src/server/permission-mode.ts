/**
 * R10 safety defaults: per-workspace permission modes.
 *
 * - `allow-all` (historical default): prompt-autoresponder clears TUI
 *   dialogs automatically and OpenCode workers get an allow-all
 *   `opencode.json`. Maximum autonomy, zero prompts.
 * - `ask`: the runtime stops answering on behalf of workers — dialogs stay
 *   on screen for the human, and no blanket permissions file is written.
 *   Nothing else changes: dispatch, reporting, review all keep working.
 */

export type PermissionMode = 'allow-all' | 'ask'

export const PERMISSION_MODE_KEY_PREFIX = 'worker_permissions_'
export const DISPATCH_PAUSED_KEY_PREFIX = 'dispatch_paused_'
export const WORKER_AUTORESTART_KEY_PREFIX = 'worker_autorestart_'
export const PERMISSION_MODES: readonly PermissionMode[] = ['allow-all', 'ask']

/**
 * Global dispatch hold set by the memory watchdog (src/server/memory-watchdog.ts).
 * Kept separate from the per-workspace error-budget flag on purpose: the error
 * budget flag must only be cleared by a human, while the memory hold auto-clears
 * with hysteresis once the machine recovers.
 */
export const MEMORY_PAUSE_KEY = 'dispatch_paused_memory'

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

export const readPermissionMode = (
  settings: AppStateReader,
  workspaceId: string
): PermissionMode =>
  settings.getAppState(`${PERMISSION_MODE_KEY_PREFIX}${workspaceId}`)?.value === 'ask'
    ? 'ask'
    : 'allow-all'

export const writePermissionMode = (
  settings: {
    setAppState: (key: string, value: string) => void
  },
  workspaceId: string,
  mode: PermissionMode
): void => {
  settings.setAppState(`${PERMISSION_MODE_KEY_PREFIX}${workspaceId}`, mode)
}

/**
 * Single dispatch gate: the per-workspace error budget (human-resumed only)
 * OR the global memory hold (auto-resumed by the watchdog). Both share the
 * `isDispatchPaused` dispatcher dependency.
 */
export const isDispatchPausedForWorkspace = (
  settings: AppStateReader,
  workspaceId: string
): boolean =>
  settings.getAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`)?.value === '1' ||
  settings.getAppState(MEMORY_PAUSE_KEY)?.value === '1'

interface OpencodeLaunchShape {
  role?: string | undefined
  commandPresetId?: string | null | undefined
  command?: string | null | undefined
}

/**
 * Pure decision for "may the runtime pre-grant OpenCode permissions for this
 * launch?" — shared by the run starter and covered by unit tests.
 */
export const shouldGrantOpencodePermissions = (
  launch: OpencodeLaunchShape,
  mode: PermissionMode
): boolean =>
  mode !== 'ask' &&
  launch.role !== 'orchestrator' &&
  (launch.commandPresetId === 'opencode' || launch.command === 'opencode')
