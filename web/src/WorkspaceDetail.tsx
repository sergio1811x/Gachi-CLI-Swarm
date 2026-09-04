import { KanbanSquare, Users } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  type CommandPreset,
  configureAgentLaunch,
  isWorkspaceShellRun,
  listCommandPresets,
  type OrchestratorStartResult,
  pauseAgentRun,
  resetWorkerStatus,
  resumeAgentRun,
  type TerminalRunSummary,
  updateWorker,
} from './api.js'
import { useI18n } from './i18n.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { KanbanBoard } from './tasks/KanbanBoard.js'
import { TerminalBottomPanel } from './terminal/TerminalBottomPanel.js'
import { useTerminalPanelTabs } from './terminal/useTerminalPanelTabs.js'
import { findRunByAgentId, orchestratorAgentId } from './terminal/useTerminalRuns.js'
import { useWorkspaceShellLauncher } from './terminal/useWorkspaceShellLauncher.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import type { EditWorkerInput } from './worker/EditWorkerDialog.js'
import type { OrchestratorConfigInput } from './worker/OrchestratorConfigDialog.js'
import { OrchestratorConfigDialog } from './worker/OrchestratorConfigDialog.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import type { WorkerActions } from './worker/useWorkerActions.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkersPane } from './worker/WorkersPane.js'

const AddWorkerDialog = lazy(() =>
  import('./worker/AddWorkerDialog.js').then((module) => ({ default: module.AddWorkerDialog }))
)
const WorkerModal = lazy(() =>
  import('./worker/WorkerModal.js').then((module) => ({ default: module.WorkerModal }))
)

type WorkspaceDetailProps = {
  onCreateWorker: WorkerActions['createWorker']
  onDeleteWorker: (workerId: string) => Promise<void>
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onStopWorker: WorkerActions['stopWorkerRun']
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed?: (workspaceId: string, runId: string) => void
  onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  welcomeDisabledReason?: string
  orchestratorAutostartError: string | null
  orchestratorAutostartRunId: string | null
  /** Bumped by the sidebar's Terminal trigger to open a shell for this workspace from outside the pane. */
  shellTerminalTrigger?: number
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  onCreateWorker,
  onDeleteWorker,
  onDeleteWorkspace,
  onStartWorker,
  onStopWorker,
  onOrchestratorResult,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  welcomeDisabledReason,
  orchestratorAutostartError,
  orchestratorAutostartRunId,
  shellTerminalTrigger,
  terminalRuns,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const { t } = useI18n()
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [kanbanTaskId, setKanbanTaskId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const [terminalPanelHidden, setTerminalPanelHidden] = useState(false)
  const [orchestratorConfigOpen, setOrchestratorConfigOpen] = useState(false)
  const [orchestratorConfigSaving, setOrchestratorConfigSaving] = useState(false)
  const [orchestratorConfigPresets, setOrchestratorConfigPresets] = useState<CommandPreset[]>([])
  const [orchestratorConfigPresetError, setOrchestratorConfigPresetError] = useState<string | null>(
    null
  )
  const [workerCommandPresets, setWorkerCommandPresets] = useState<CommandPreset[]>([])
  const [workerCommandPresetError, setWorkerCommandPresetError] = useState<string | null>(null)
  const [rightPaneMode, setRightPaneMode] = useState<'workers' | 'kanban'>('workers')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  useEffect(() => {
    let cancelled = false
    listCommandPresets()
      .then((presets) => {
        if (!cancelled) setWorkerCommandPresets(presets)
      })
      .catch(() => {
        if (!cancelled) setWorkerCommandPresetError(tRef.current('workspace.preset.loadFailed'))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const toast = useToast()
  const composer = useWorkerComposer({
    createWorker: onCreateWorker,
    open: composerOpen,
    workers,
  })
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    terminalRuns,
    autostartError: orchestratorAutostartError,
    suppressAutostartRunId: orchestratorAutostartRunId,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })
  const split = usePaneSplit()
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker])
  const panelTabs = useTerminalPanelTabs({
    workspaceId: workspace?.id ?? '',
    workers,
    terminalRuns,
  })
  const shellPanelTabs = panelTabs.tabs.filter((tab) => tab.kind === 'shell')
  const shellRuns = workspace
    ? terminalRuns.filter((run) => isWorkspaceShellRun(run, workspace.id))
    : []
  const { closeShellTab, openShell, shellError, shellStarting, startNewShell } =
    useWorkspaceShellLauncher({
      onCloseFailed: (message) =>
        toast.show({ kind: 'error', message: t('shellTerminal.closeFailed', { message }) }),
      onShellRunClosed,
      onShellRunStarted,
      panelTabs,
      shellRuns,
      workspaceId: workspace?.id ?? null,
    })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // Start failures no longer have a modal banner to display them — surface
  // via toast to keep parity with delete-error feedback.
  useEffect(() => {
    if (startWorkerError) toast.show({ kind: 'error', message: startWorkerError })
  }, [startWorkerError, toast])

  // Shell-start failures no longer have a dialog banner — surface via toast.
  useEffect(() => {
    if (shellError) toast.show({ kind: 'error', message: shellError })
  }, [shellError, toast])

  // The sidebar's Terminal button lives outside this pane, so it opens a shell
  // by bumping shellTerminalTrigger — skip the initial mount so a stale/zero
  // trigger value doesn't auto-open a terminal for a freshly selected workspace.
  // openShell is read via a ref (not a dep) because useWorkspaceShellLauncher
  // doesn't memoize it — depending on it directly re-fired this effect (and
  // reopened the shell) on every unrelated re-render, e.g. terminal-run polling.
  const shellTriggerMounted = useRef(false)
  const openShellRef = useRef(openShell)
  useEffect(() => {
    openShellRef.current = openShell
  }, [openShell])
  useEffect(() => {
    if (!shellTriggerMounted.current) {
      shellTriggerMounted.current = true
      return
    }
    if (shellTerminalTrigger === undefined) return
    setTerminalPanelHidden(false)
    openShellRef.current()
  }, [shellTerminalTrigger])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setActiveWorkerId(null)
    setKanbanTaskId(null)
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStartingWorkerId(null)
    setTerminalPanelHidden(false)
  }, [workspace?.id])

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = async (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    try {
      const { error } = await onStartWorker(worker.id)
      if (error) {
        setStartWorkerError(error)
        throw new Error(error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStartWorkerError(message)
      throw error
    } finally {
      setStartingWorkerId(null)
    }
  }

  const handleStopWorker = async (worker: TeamListItem) => {
    const run = findRunByAgentId(terminalRuns, worker.id)
    if (!run) return
    const { error } = await onStopWorker(run.run_id)
    if (error) {
      toast.show({ kind: 'error', message: error })
      throw new Error(error)
    }
  }

  const handlePauseWorker = (worker: TeamListItem) => {
    const run = findRunByAgentId(terminalRuns, worker.id)
    if (!run) return
    // Toggle: a paused worker resumes, an active one pauses.
    const action = worker.paused ? resumeAgentRun(run.run_id) : pauseAgentRun(run.run_id)
    const toastMessage = worker.paused
      ? t('worker.resumedToast', { name: worker.name })
      : t('worker.pausedToast', { name: worker.name })
    void action
      .then(() => toast.show({ kind: 'success', message: toastMessage }))
      .catch((err) => {
        toast.show({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }

  const handleResetWorker = (worker: TeamListItem) => {
    void resetWorkerStatus(workspace.id, worker.id)
      .then(() => {
        toast.show({ kind: 'success', message: t('worker.resetToast', { name: worker.name }) })
      })
      .catch((err) => {
        toast.show({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }

  const handleEditWorker = async (
    worker: TeamListItem,
    input: EditWorkerInput
  ): Promise<{ error: string | null }> => {
    try {
      const startupClean = input.startupCommand.trim()
      const cliChanged =
        input.commandPresetId !== (worker.commandPresetId ?? '') || startupClean.length > 0
      if (cliChanged) {
        await configureAgentLaunch(workspace.id, worker.id, {
          command_preset_id: input.commandPresetId || null,
          ...(startupClean ? { startup_command: startupClean } : {}),
        })
      }
      await updateWorker(workspace.id, worker.id, {
        ...(input.name !== worker.name ? { name: input.name } : {}),
        ...(input.description !== worker.description ? { description: input.description } : {}),
      })
      toast.show({ kind: 'success', message: t('worker.editSuccess', { name: input.name }) })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: t('worker.editFailed', { message }) })
      return { error: message }
    }
  }

  const openOrchestratorConfig = () => {
    setOrchestratorConfigPresetError(null)
    setOrchestratorConfigPresets([])
    listCommandPresets()
      .then((presets) => setOrchestratorConfigPresets(presets))
      .catch(() => setOrchestratorConfigPresetError(t('workspace.preset.loadFailed')))
    setOrchestratorConfigOpen(true)
  }

  const saveOrchestratorConfig = (input: OrchestratorConfigInput) => {
    setOrchestratorConfigSaving(true)
    void configureAgentLaunch(workspace.id, orchestratorAgentId(workspace.id), input)
      .then(() => {
        setOrchestratorConfigOpen(false)
        if (orchestrator.state.kind === 'running') {
          orchestrator.restart()
          toast.show({ kind: 'success', message: t('orchestrator.config.restarting') })
        } else {
          toast.show({ kind: 'success', message: t('orchestrator.config.startToApply') })
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({
          kind: 'error',
          message: t('orchestrator.config.saveFailed', { message }),
        })
      })
      .finally(() => setOrchestratorConfigSaving(false))
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`
  const startNewShellFromPanel = () => {
    setTerminalPanelHidden(false)
    startNewShell()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      <div ref={split.containerRef} className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-[480px] shrink-0 flex-col"
          style={{ width: orchWidth }}
          data-testid="orchestrator-pane-shell"
        >
          <OrchestratorPane
            state={orchestrator.state}
            onConfigure={openOrchestratorConfig}
            onStop={orchestrator.stop}
            onRemoveWorkspace={() => {
              void onDeleteWorkspace(workspace).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                toast.show({
                  kind: 'error',
                  message: t('workspace.deleteFailed', { message }),
                })
              })
            }}
            onStart={orchestrator.start}
            onRestart={orchestrator.restart}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't host pointer/keyboard handlers and the visible accent line; aria role="separator" is the canonical resize-handle role */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workerPane.resize')}
          aria-valuenow={Math.round(split.orchPct * 100)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex={0}
          className="pane-splitter"
          style={{ left: `calc(${orchWidth} - 4px)` }}
          data-dragging={split.dragging || undefined}
          data-testid="pane-splitter"
          onPointerDown={split.beginDrag}
          onKeyDown={split.onKeyDown}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Header mode switcher */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-1 shrink-0">
            <div className="flex items-center gap-1 bg-bg p-0.5 rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setRightPaneMode('workers')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-all font-medium ${
                  rightPaneMode === 'workers'
                    ? 'bg-card text-pri shadow-xs'
                    : 'text-sec hover:text-pri'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>{t('workspace.tabWorkers')}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-border text-sec">
                  {workers.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRightPaneMode('kanban')}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-all font-medium ${
                  rightPaneMode === 'kanban'
                    ? 'bg-card text-pri shadow-xs'
                    : 'text-sec hover:text-pri'
                }`}
              >
                <KanbanSquare className="w-3.5 h-3.5 text-accent" />
                <span>{t('workspace.tabKanban')}</span>
              </button>
            </div>
          </div>

          <div className={rightPaneMode === 'kanban' ? 'block flex-1 min-h-0' : 'hidden'}>
            <KanbanBoard
              workspaceId={workspace.id}
              workers={workers}
              openTaskId={kanbanTaskId}
              onTaskOpened={() => setKanbanTaskId(null)}
              onOpenWorker={(workerId) => setActiveWorkerId(workerId)}
            />
          </div>

          <div
            className={
              rightPaneMode === 'workers'
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'hidden'
            }
          >
            <WorkersPane
              commandPresetError={workerCommandPresetError}
              commandPresets={workerCommandPresets}
              onAddWorkerClick={() => setComposerOpen(true)}
              onDeleteWorker={handleDeleteWorker}
              onEditWorker={handleEditWorker}
              onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
              onStartWorker={handleStartWorker}
              onStopWorker={handleStopWorker}
              onPauseWorker={handlePauseWorker}
              onResetWorker={handleResetWorker}
              startingWorkerId={startingWorkerId}
              terminalRuns={terminalRuns}
              workers={workers}
              workspaceId={workspace.id}
            />
          </div>
          {terminalPanelHidden ? null : (
            <TerminalBottomPanel
              tabs={shellPanelTabs}
              activeId={panelTabs.activeId}
              scopeKey={workspace.id}
              onSelect={panelTabs.setActive}
              onClose={(tabId) => {
                if (tabId.startsWith('shell:')) {
                  closeShellTab(tabId.slice('shell:'.length))
                }
                panelTabs.closeTab(tabId)
              }}
              onClosePanel={() => setTerminalPanelHidden(true)}
              onNewShell={startNewShellFromPanel}
              newShellPending={shellStarting}
              onStartWorker={(workerId) => {
                const worker = workers.find((w) => w.id === workerId)
                if (worker) handleStartWorker(worker)
              }}
              startingWorkerId={startingWorkerId}
            />
          )}
        </div>
      </div>
      {activeWorker ? (
        <Suspense fallback={null}>
          <WorkerModal
            commandPresets={workerCommandPresets}
            onClose={() => setActiveWorkerId(null)}
            onStart={handleStartWorker}
            onStop={handleStopWorker}
            runId={activeWorkerRun?.run_id ?? null}
            startError={startWorkerError}
            starting={startingWorkerId === activeWorker.id}
            worker={activeWorker}
            workspaceId={workspace.id}
          />
        </Suspense>
      ) : null}
      {composerOpen ? (
        <Suspense fallback={null}>
          <AddWorkerDialog
            commandPresets={composer.commandPresets}
            commandPresetId={composer.commandPresetId}
            creating={composer.creating}
            customTemplates={composer.customTemplates}
            onApplyMarketplaceImport={composer.applyMarketplaceImport}
            onClose={() => setComposerOpen(false)}
            onDeleteTemplate={composer.deleteTemplate}
            onNameChange={composer.setWorkerName}
            onPresetChange={composer.setCommandPresetId}
            onRandomName={composer.randomizeWorkerName}
            onRoleDescriptionChange={composer.setRoleDescription}
            onRoleDescriptionReset={composer.resetRoleDescription}
            onRoleChange={composer.setWorkerRole}
            onSaveAsTemplate={composer.saveAsTemplate}
            onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
            onStartupCommandChange={composer.setStartupCommand}
            onTemplateChange={composer.selectTemplate}
            roleDescription={composer.roleDescription}
            roleDescriptionDefault={composer.roleDescriptionDefault}
            selectedTemplateId={composer.selectedTemplateId}
            startupCommand={composer.startupCommand}
            templateBusy={composer.templateBusy}
            workerName={composer.workerName}
            workerRole={composer.workerRole}
          />
        </Suspense>
      ) : null}
      {orchestratorConfigOpen ? (
        <OrchestratorConfigDialog
          commandPresetError={orchestratorConfigPresetError}
          commandPresets={orchestratorConfigPresets}
          onCancel={() => setOrchestratorConfigOpen(false)}
          onSave={saveOrchestratorConfig}
          saving={orchestratorConfigSaving}
        />
      ) : null}
    </div>
  )
}
