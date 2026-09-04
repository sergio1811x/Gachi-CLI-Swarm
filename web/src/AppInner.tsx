import { useCallback, useMemo, useState } from 'react'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppOverlays } from './AppOverlays.js'
import { AppWorkspaceContent } from './AppWorkspaceContent.js'
import { renameWorkspace } from './api.js'
import { MainLayout } from './layout/MainLayout.js'
import { RuntimeOfflinePage } from './pwa/RuntimeOfflinePage.js'
import { UpdateAvailableToast } from './pwa/UpdateAvailableToast.js'
import { useShortcutAction } from './pwa/use-shortcut-action.js'
import { Sidebar } from './sidebar/Sidebar.js'
import { parseTaskMarkdown } from './tasks/task-markdown.js'
import { useTasksFile } from './tasks/useTasksFile.js'
import { useOptimisticTerminalRuns } from './terminal/useOptimisticTerminalRuns.js'
import { useTerminalRuns } from './terminal/useTerminalRuns.js'
import { AppBootLoader } from './ui/AppBootLoader.js'
import { useToast } from './ui/useToast.js'
import { useAppShortcuts } from './useAppShortcuts.js'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard.js'
import { useInitializeUiSession } from './useInitializeUiSession.js'
import { useWorkerHighlight } from './useWorkerHighlight.js'
import { useWorkspaceCreate } from './useWorkspaceCreate.js'
import { useWorkspaceDelete } from './useWorkspaceDelete.js'
import { useWorkspaceSelection } from './useWorkspaceSelection.js'
import { useWorkspaceWorkers } from './useWorkspaceWorkers.js'
import { useFirstRunWizard } from './wizard/useFirstRunWizard.js'
import { useWorkerActions } from './worker/useWorkerActions.js'

export const AppInner = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const { activeWorkspaceId, selectWorkspace, setActiveWorkspaceId } = useWorkspaceSelection()
  const localPollIds = !workspaces ? [] : workspaces.map(({ id }) => id)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useWorkspaceWorkers(localPollIds)
  const [addDialogTrigger, setAddDialogTrigger] = useState(0)
  const [shellTerminalTrigger, setShellTerminalTrigger] = useState(0)
  const [taskGraphOpen, setTaskGraphOpen] = useState(false)
  const toast = useToast()
  const { wizardOpen, closeWizard } = useFirstRunWizard(workspaces)
  const triggerAddDialog = useCallback(() => setAddDialogTrigger((v) => v + 1), [])
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const onBootstrapError = useCallback(
    (message: string) => {
      setBootstrapError(message)
      toast.show({ kind: 'error', message })
    },
    [toast]
  )
  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onBootstrapError)
  const wsCreate = useWorkspaceCreate({
    onWorkspaceCreated: (ws) => {
      setWorkspaces((c) => (c === null ? [ws] : [...c, ws]))
      selectWorkspace(ws.id)
      setWorkersByWorkspaceId((c) => ({ ...c, [ws.id]: [] }))
    },
    onError: (message) => toast.show({ kind: 'error', message }),
  })
  const activeId = activeWorkspaceId
  const activeWorkers = activeId ? (workersByWorkspaceId[activeId] ?? []) : []
  const terms = useOptimisticTerminalRuns(activeWorkspaceId, useTerminalRuns(activeWorkspaceId))
  // Always confirm on close. Browsers gate beforeunload on prior page
  // interaction so fresh tabs still close cleanly, but every closure that
  // does fire the prompt now goes through it — including PWA Cmd-W.
  useBeforeUnloadGuard(true)
  const tasksFile = useTasksFile(activeWorkspaceId ?? null)
  const openTaskCount = useMemo(
    () =>
      activeWorkspaceId
        ? parseTaskMarkdown(tasksFile.content).filter((task) => !task.checked).length
        : 0,
    [activeWorkspaceId, tasksFile.content]
  )
  const workerActions = useWorkerActions({
    activeWorkspaceId,
    onWorkerDeleted: terms.forgetOptimisticAgent,
    onWorkerRunStarted: terms.recordOptimisticRun,
    setWorkersByWorkspaceId,
  })
  const deleteWorkspace = useWorkspaceDelete({
    activeWorkspaceId,
    onActiveDeleted: () => setTaskGraphOpen(false),
    selectWorkspace,
    setWorkersByWorkspaceId,
    setWorkspaces,
    workspaces,
  })
  const renameWorkspaceHandler = useCallback(
    (workspaceId: string, name: string) =>
      renameWorkspace(workspaceId, name)
        .then((updated) => {
          setWorkspaces((c) => c?.map((ws) => (ws.id === workspaceId ? updated : ws)) ?? c)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          toast.show({ kind: 'error', message })
        }),
    [toast]
  )
  useAppShortcuts({
    bootstrapError,
    onSelectWorkspace: selectWorkspace,
    onTriggerAddDialog: triggerAddDialog,
    workspaces,
  })
  // PWA manifest shortcuts route through `?action=...` query params. Wait for
  // bootstrap to *settle* (success OR explicit error) so the dispatcher fires
  // even when the daemon is down, and a stuck-on-loading state would make the
  // shortcut a dead URL.
  useShortcutAction({
    onAddWorkspace: triggerAddDialog,
    ready: workspaces !== null || bootstrapError !== null,
  })
  const handleSelectOwner = useWorkerHighlight()
  // Only escalate to the full-screen offline page when bootstrap explicitly
  // failed AND we have no cached workspace data to fall back on. Mid-session
  // API failures keep the existing toast-based handling.
  const runtimeOffline = bootstrapError !== null && workspaces === null
  const booting = workspaces === null && bootstrapError === null
  return (
    <>
      {booting ? <AppBootLoader /> : null}
      <MainLayout
        hideTopbarActions={!activeWorkspaceId}
        onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
        openTaskCount={openTaskCount}
        taskGraphOpen={taskGraphOpen}
        sidebar={
          <Sidebar
            activeWorkspaceId={activeWorkspaceId}
            createDisabledReason={bootstrapError ?? undefined}
            onCreateClick={triggerAddDialog}
            onDeleteWorkspace={deleteWorkspace}
            onOpenShellTerminal={() => setShellTerminalTrigger((v) => v + 1)}
            onRenameWorkspace={renameWorkspaceHandler}
            onSelectWorkspace={selectWorkspace}
            workersByWorkspaceId={workersByWorkspaceId}
            workspaces={workspaces}
          />
        }
      >
        {runtimeOffline ? (
          <RuntimeOfflinePage />
        ) : (
          <AppWorkspaceContent
            activeId={activeId}
            activeWorkspace={
              activeWorkspaceId ? workspaces?.find((w) => w.id === activeWorkspaceId) : undefined
            }
            bootstrapError={bootstrapError}
            onDeleteWorkspace={deleteWorkspace}
            onRequestAddWorkspace={triggerAddDialog}
            onShellRunClosed={terms.forgetOptimisticRun}
            onShellRunStarted={(workspaceId, run) =>
              terms.recordOptimisticRun({
                agentId: run.agent_id,
                agentName: run.agent_name,
                runId: run.run_id,
                status: run.status,
                terminalInputProfile: run.terminal_input_profile ?? 'default',
                workspaceId,
              })
            }
            optimisticRunsByWorkspaceId={terms.optimisticRunsByWorkspaceId}
            orchestratorAutostartErrors={wsCreate.orchestratorAutostartErrors}
            orchestratorAutostartRunIds={wsCreate.orchestratorAutostartRunIds}
            recordOrchestratorResult={wsCreate.recordOrchestratorResult}
            shellTerminalTrigger={shellTerminalTrigger}
            terminalRuns={terms.terminalRuns}
            workerActions={workerActions}
            workers={activeWorkers}
          />
        )}
        <AppOverlays
          addDialogTrigger={addDialogTrigger}
          wizardOpen={wizardOpen}
          onAddWorkspace={triggerAddDialog}
          onCloseTaskGraph={() => setTaskGraphOpen(false)}
          onCloseWizard={closeWizard}
          onCreateWorkspace={wsCreate.createNewWorkspace}
          taskGraphOpen={taskGraphOpen}
          tasksFile={tasksFile}
          workspacePath={
            activeWorkspaceId
              ? (workspaces?.find((w) => w.id === activeWorkspaceId)?.path ?? null)
              : null
          }
          workers={activeWorkers}
          onSelectOwner={handleSelectOwner}
        />
      </MainLayout>
      <UpdateAvailableToast terminalRuns={terms.terminalRuns} />
    </>
  )
}
