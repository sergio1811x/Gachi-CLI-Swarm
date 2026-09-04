import { Save, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { TaskStatus, TeamListItem } from '../../../src/shared/types.js'
import {
  addCommentToTask,
  type CommandPreset,
  createTeamTemplate,
  deleteTask,
  dispatchTaskToWorker,
  getTask,
  type TaskRecordItem,
  type TerminalRunSummary,
  updateTask,
} from '../api.js'
import { useI18n } from '../i18n.js'
import { canTransition, STATUS_LABELS } from '../tasks/kanban/kanban-model.js'
import { TaskDetailModal } from '../tasks/kanban/TaskDetailModal.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { useToast } from '../ui/useToast.js'
import { EditWorkerDialog, type EditWorkerInput } from './EditWorkerDialog.js'
import { SaveTeamTemplateDialog } from './SaveTeamTemplateDialog.js'
import { SwarmDashboard } from './SwarmDashboard.js'
import { TeamTimeline } from './TeamTimeline.js'
import { WorkerCard, type WorkerCardActionKind } from './WorkerCard.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

type WorkersPaneProps = {
  commandPresetError: string | null
  commandPresets: CommandPreset[]
  onAddWorkerClick: () => void
  onDeleteWorker: (worker: TeamListItem) => void
  onEditWorker: (worker: TeamListItem, input: EditWorkerInput) => Promise<{ error: string | null }>
  onOpenWorker: (worker: TeamListItem) => void
  onStartWorker: (worker: TeamListItem) => void
  onStopWorker: (worker: TeamListItem) => void
  onPauseWorker?: ((worker: TeamListItem) => void) | undefined
  onResetWorker?: ((worker: TeamListItem) => void) | undefined
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  /** Owning workspace id — required to open task details in place. */
  workspaceId?: string | undefined
}

const SECTION_ORDER: WorkerStatusKind[] = ['working', 'waiting_decision', 'idle', 'stopped']
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'waiting_decision') return 'common.waiting_decision'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

const summarizeWorkers = (workers: TeamListItem[]) => {
  const buckets: Record<WorkerStatusKind, TeamListItem[]> = {
    idle: [],
    working: [],
    waiting_decision: [],
    stopped: [],
  }
  for (const worker of workers) buckets[presentWorkerStatus(worker).kind].push(worker)
  // ТЗ v2 §2 — пустые группы не рендерятся вообще.
  return {
    sections: SECTION_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
      kind,
      workers: buckets[kind],
    })),
    summary: {
      idle: buckets.idle.length,
      stopped: buckets.stopped.length,
      waiting_decision: buckets.waiting_decision.length,
      working: buckets.working.length,
    },
  }
}

export const WorkersPane = ({
  commandPresetError,
  commandPresets,
  onAddWorkerClick,
  onDeleteWorker,
  onEditWorker,
  onOpenWorker,
  onStartWorker,
  onStopWorker,
  onPauseWorker,
  onResetWorker,
  startingWorkerId,
  terminalRuns,
  workers,
  workspaceId,
}: WorkersPaneProps) => {
  const { t } = useI18n()
  const { sections, summary } = useMemo(() => summarizeWorkers(workers), [workers])
  const runIdsByAgentId = useMemo(
    () => new Map(terminalRuns.map((run) => [run.agent_id, run.run_id] as const)),
    [terminalRuns]
  )
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [editTarget, setEditTarget] = useState<TeamListItem | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [saveTemplateError, setSaveTemplateError] = useState<string | null>(null)

  // Task detail opened from a worker card — stays on the team pane instead
  // of jumping to the kanban tab.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [openTask, setOpenTask] = useState<TaskRecordItem | null>(null)
  const [taskDispatching, setTaskDispatching] = useState(false)
  const [taskPendingDelete, setTaskPendingDelete] = useState(false)
  const toast = useToast()

  const handleOpenTask = (taskId: string) => {
    if (!workspaceId) return
    setOpenTaskId(taskId)
    getTask(workspaceId, taskId)
      .then(setOpenTask)
      .catch((err: unknown) => {
        setOpenTaskId(null)
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : 'Failed to load task',
        })
      })
  }

  const closeTaskModal = () => {
    setOpenTaskId(null)
    setOpenTask(null)
  }

  const reloadOpenTask = (taskId: string) => {
    if (!workspaceId) return
    getTask(workspaceId, taskId)
      .then(setOpenTask)
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.refreshFailed'),
        })
      )
  }

  const handleTaskStatus = (taskId: string, next: TaskStatus) => {
    if (!workspaceId || !openTask || openTask.status === next) return
    if (!canTransition(openTask.status, next)) {
      toast.show({
        kind: 'warning',
        message: t('task.transitionInvalid', {
          from: STATUS_LABELS[openTask.status],
          to: STATUS_LABELS[next],
        }),
      })
      return
    }
    updateTask(workspaceId, taskId, { status: next })
      .then(() => reloadOpenTask(taskId))
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.statusChangeFailed'),
        })
      )
  }

  const handleTaskAssign = (taskId: string, workerId: string) => {
    if (!workspaceId) return
    updateTask(workspaceId, taskId, {
      assigned_worker_id: workerId || null,
      status: workerId ? 'assigned' : 'backlog',
    })
      .then(() => reloadOpenTask(taskId))
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.assignFailed'),
        })
      )
  }

  const handleTaskDispatch = (taskId: string, workerId?: string) => {
    if (!workspaceId) return
    setTaskDispatching(true)
    dispatchTaskToWorker(workspaceId, taskId, workerId)
      .then(() => reloadOpenTask(taskId))
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.dispatchFailed'),
        })
      )
      .finally(() => setTaskDispatching(false))
  }

  const handleTaskRework = (taskId: string, workerId?: string, feedback?: string) => {
    if (!workspaceId) return
    const prepare = feedback
      ? addCommentToTask(
          workspaceId,
          taskId,
          'Orchestrator',
          `${t('task.reworkPrefix')} ${feedback}`,
          'orchestrator'
        )
      : Promise.resolve(null)
    prepare
      .then(() => (workerId ? dispatchTaskToWorker(workspaceId, taskId, workerId) : undefined))
      .then(() => {
        toast.show({ kind: 'success', message: t('task.reworkSent') })
        reloadOpenTask(taskId)
      })
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.reworkFailed'),
        })
      )
  }

  const handleTaskComment = (
    author: string,
    message: string,
    anchor?: { path: string; line: number }
  ): Promise<void> => {
    if (!workspaceId || !openTaskId) return Promise.resolve()
    return addCommentToTask(workspaceId, openTaskId, author, message, 'user', anchor)
      .then((updated) => {
        if (updated) setOpenTask(updated)
        else reloadOpenTask(openTaskId)
      })
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.commentFailed'),
        })
      )
      .then(() => {})
  }

  const confirmDeleteTask = () => {
    if (!workspaceId || !openTaskId) return
    deleteTask(workspaceId, openTaskId)
      .then(() => {
        toast.show({ kind: 'success', message: t('task.deletedToast') })
        closeTaskModal()
      })
      .catch((err: unknown) =>
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : t('task.deleteFailed'),
        })
      )
  }

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
      return
    }
    if (kind === 'stop') {
      onStopWorker(worker)
      return
    }
    if (kind === 'pause') {
      onPauseWorker?.(worker)
      return
    }
    if (kind === 'reset') {
      onResetWorker?.(worker)
      return
    }
    if (kind === 'rename') {
      setEditTarget(worker)
      return
    }
    if (kind === 'delete') {
      setPendingDelete(worker)
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    onDeleteWorker(pendingDelete)
    setPendingDelete(null)
  }

  const submitEdit = (worker: TeamListItem, input: EditWorkerInput) => {
    setEditBusy(true)
    void onEditWorker(worker, input).finally(() => {
      setEditBusy(false)
      setEditTarget(null)
    })
  }

  const handleSaveTemplate = (name: string) => {
    setSavingTemplate(true)
    setSaveTemplateError(null)
    void createTeamTemplate(
      name,
      workers.map((worker) => ({
        name: worker.name,
        role: worker.role,
        description: worker.description ?? '',
        commandPresetId: worker.commandPresetId ?? null,
      }))
    )
      .then(() => {
        setSaveTemplateOpen(false)
        toast.show({ kind: 'success', message: t('teamTemplate.saveSuccess', { name }) })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setSaveTemplateError(t('teamTemplate.saveFailed', { message }))
      })
      .finally(() => setSavingTemplate(false))
  }

  const summaryLine = [
    {
      count: summary.working,
      dotClass: 'status-dot status-dot--working',
      key: 'common.running' as const,
    },
    {
      count: summary.waiting_decision,
      dotClass: 'status-dot status-dot--waiting',
      key: 'common.waiting_decision' as const,
    },
    { count: summary.idle, dotClass: 'status-dot status-dot--idle', key: 'common.idle' as const },
    {
      count: summary.stopped,
      dotClass: 'status-dot status-dot--stopped',
      key: 'common.stopped' as const,
    },
  ].filter((item) => item.count > 0)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      {workspaceId ? <SwarmDashboard workspaceId={workspaceId} /> : null}
      <div
        className="flex shrink-0 flex-col px-4 pt-3 pb-2.5"
        style={{
          boxShadow: 'inset 0 -1px 0 var(--border)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold leading-tight text-pri">
            {t('worker.teamMembers')}
          </h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onAddWorkerClick}
            className="workers-btn workers-btn--primary"
            data-testid="add-worker-trigger"
          >
            <UserPlus size={12} aria-hidden /> {t('addWorker.create')}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-ter">
          <span className="text-sec">{t('worker.workersCount', { count: workers.length })}</span>
          {summaryLine.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1.5">
              <span className={item.dotClass} aria-hidden />
              <span>{item.count}</span> {t(item.key)}
            </span>
          ))}
        </div>
        <div
          className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2"
          style={{ borderColor: 'var(--border)' }}
        >
          {workers.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSaveTemplateError(null)
                setSaveTemplateOpen(true)
              }}
              className="workers-btn"
              aria-label={t('teamTemplate.saveAria')}
              title={t('teamTemplate.saveAria')}
              data-testid="save-team-template-trigger"
            >
              <Save size={14} aria-hidden /> {t('teamTemplate.save')}
            </button>
          ) : null}
        </div>
      </div>

      <TeamTimeline workers={workers} onOpenWorker={onOpenWorker} />

      <div
        className="workers-pane-body scroll-y min-h-0 flex-1 px-4 pb-10 pt-1"
        style={{ minHeight: 0, overflowY: 'auto' }}
      >
        {workers.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={32} />}
            title={t('worker.emptyTitle')}
            description={t('worker.emptyDesc')}
            action={
              <button
                type="button"
                onClick={onAddWorkerClick}
                className="workers-btn workers-btn--primary"
                data-testid="add-worker-empty"
              >
                <UserPlus size={14} aria-hidden /> {t('worker.emptyAdd')}
              </button>
            }
          />
        ) : (
          <div data-testid="worker-grid">
            {sections.map((section) => (
              <section key={section.kind} className="workers-section">
                <div className="workers-section__header">
                  <span
                    className={`workers-section__dot workers-section__dot--${section.kind}`}
                    aria-hidden
                  />
                  <span
                    className={`workers-section__title ${
                      section.kind === 'waiting_decision' ? 'text-amber-400' : ''
                    }`}
                  >
                    {t(statusKey(section.kind))}
                  </span>
                  <span
                    className={`workers-section__count ${
                      section.kind === 'waiting_decision' ? 'text-amber-300' : ''
                    }`}
                  >
                    {section.workers.length}
                  </span>
                </div>
                <div className="workers-section__divider" aria-hidden />
                <ul
                  aria-label={`${t(statusKey(section.kind))} team members`}
                  className="worker-card-grid"
                >
                  {section.workers.map((worker) => (
                    <li key={`${section.kind}:${worker.id}`} className="min-w-0">
                      <WorkerCard
                        hasRun={runIdsByAgentId.has(worker.id)}
                        isPending={startingWorkerId === worker.id}
                        onAction={handleAction}
                        onClick={onOpenWorker}
                        onOpenTask={handleOpenTask}
                        worker={worker}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <Confirm
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={pendingDelete ? t('worker.deleteConfirm', { name: pendingDelete.name }) : ''}
        description={
          pendingDelete ? t('worker.deleteDescription', { name: pendingDelete.name }) : ''
        }
        confirmLabel={t('worker.deleteMember')}
        confirmKind="danger"
        onConfirm={confirmDelete}
      />
      <EditWorkerDialog
        worker={editTarget}
        busy={editBusy}
        commandPresetError={commandPresetError}
        commandPresets={commandPresets}
        onClose={() => setEditTarget(null)}
        onSubmit={(input) => {
          if (editTarget) submitEdit(editTarget, input)
        }}
      />
      <SaveTeamTemplateDialog
        open={saveTemplateOpen}
        memberCount={workers.length}
        saving={savingTemplate}
        error={saveTemplateError}
        onClose={() => setSaveTemplateOpen(false)}
        onSave={handleSaveTemplate}
      />

      {openTask && workspaceId ? (
        <TaskDetailModal
          workspaceId={workspaceId}
          task={openTask}
          workers={workers.map((w) => ({ id: w.id, name: w.name, role: String(w.role) }))}
          dispatching={taskDispatching}
          onClose={closeTaskModal}
          onMoveStatus={handleTaskStatus}
          onAssign={handleTaskAssign}
          onDispatch={handleTaskDispatch}
          onRework={handleTaskRework}
          onAddComment={handleTaskComment}
          onDelete={() => setTaskPendingDelete(true)}
        />
      ) : null}

      <Confirm
        open={taskPendingDelete}
        onOpenChange={(open) => {
          if (!open) setTaskPendingDelete(false)
        }}
        title={t('task.deleteConfirmTitle')}
        description={t('task.deleteConfirmDesc')}
        confirmLabel={t('common.delete')}
        confirmKind="danger"
        onConfirm={confirmDeleteTask}
      />
    </div>
  )
}
