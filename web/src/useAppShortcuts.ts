import { useMemo } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { useGlobalShortcuts } from './useGlobalShortcuts.js'

type UseAppShortcutsOptions = {
  bootstrapError: string | null
  onSelectWorkspace: (workspaceId: string) => void
  onTriggerAddDialog: () => void
  workspaces: WorkspaceSummary[] | null
}

export const useAppShortcuts = ({
  bootstrapError,
  onSelectWorkspace,
  onTriggerAddDialog,
  workspaces,
}: UseAppShortcutsOptions) => {
  const shortcuts = useMemo(() => {
    const indexShortcuts = (workspaces ?? []).slice(0, 9).map((ws, idx) => ({
      key: String(idx + 1),
      mod: true,
      handler: () => onSelectWorkspace(ws.id),
    }))

    return [
      {
        key: 'n',
        mod: true,
        shift: true,
        handler: () => {
          if (!bootstrapError) onTriggerAddDialog()
        },
      },
      ...indexShortcuts,
    ]
  }, [bootstrapError, onSelectWorkspace, onTriggerAddDialog, workspaces])

  useGlobalShortcuts(shortcuts)
}
