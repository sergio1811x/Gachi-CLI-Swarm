import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { OrchestratorStartResult, TerminalRunSummary } from './api.js'
import { WorkspaceDetail } from './WorkspaceDetail.js'
import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels.js'
import type { WorkerActions } from './worker/useWorkerActions.js'

type AppWorkspaceContentProps = {
  activeId: string | undefined
  activeWorkspace: WorkspaceSummary | undefined
  bootstrapError: string | null
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onRequestAddWorkspace: () => void
  onShellRunClosed: (workspaceId: string, runId: string) => void
  onShellRunStarted: (workspaceId: string, run: TerminalRunSummary) => void
  optimisticRunsByWorkspaceId: Record<string, TerminalRunSummary[]>
  orchestratorAutostartErrors: Record<string, string | null>
  orchestratorAutostartRunIds: Record<string, string | null>
  recordOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  shellTerminalTrigger?: number
  terminalRuns: TerminalRunSummary[]
  workerActions: WorkerActions
  workers: TeamListItem[]
}

export const AppWorkspaceContent = ({
  activeId,
  activeWorkspace,
  bootstrapError,
  onDeleteWorkspace,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  optimisticRunsByWorkspaceId,
  orchestratorAutostartErrors,
  orchestratorAutostartRunIds,
  recordOrchestratorResult,
  shellTerminalTrigger,
  terminalRuns,
  workerActions,
  workers,
}: AppWorkspaceContentProps) => {
  return (
    <>
      {activeId ? (
        <WorkspaceTerminalPanels
          key={`terminal-${activeId}`}
          optimisticRuns={optimisticRunsByWorkspaceId[activeId] ?? []}
          terminalRuns={terminalRuns}
          workspaceId={activeId}
        />
      ) : null}
      <WorkspaceDetail
        onCreateWorker={workerActions.createWorker}
        onDeleteWorker={workerActions.deleteWorker}
        onDeleteWorkspace={onDeleteWorkspace}
        onStartWorker={workerActions.startWorker}
        onStopWorker={workerActions.stopWorkerRun}
        onOrchestratorResult={recordOrchestratorResult}
        onRequestAddWorkspace={onRequestAddWorkspace}
        onShellRunClosed={onShellRunClosed}
        onShellRunStarted={onShellRunStarted}
        welcomeDisabledReason={bootstrapError ?? undefined}
        orchestratorAutostartError={
          activeId ? (orchestratorAutostartErrors[activeId] ?? null) : null
        }
        orchestratorAutostartRunId={
          activeId ? (orchestratorAutostartRunIds[activeId] ?? null) : null
        }
        shellTerminalTrigger={shellTerminalTrigger}
        terminalRuns={terminalRuns}
        workers={workers}
        workspace={activeWorkspace}
      />
    </>
  )
}
