import { AlertCircle, Check, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskStatus, TeamListItem } from '../../../src/shared/types.js'
import {
  addCommentToTask,
  approvePlan,
  createTask,
  deleteTask,
  discardPlan,
  dispatchTaskToWorker,
  getTask,
  listTasks,
  type TaskRecordItem,
  updateTask,
} from '../api.js'
import { useTasksEvents } from './useTasksEvents.js'
import './kanban/kanban.css'
import { CreateTaskModal } from './kanban/CreateTaskModal.js'
import type { KanbanCardActions } from './kanban/KanbanColumn.js'
import { KanbanColumn } from './kanban/KanbanColumn.js'
import { KanbanToolbar } from './kanban/KanbanToolbar.js'
import {
  COLUMN_BY_ID,
  COLUMNS,
  canTransition,
  matchesQuery,
  STATUS_LABELS,
  statusCounts,
} from './kanban/kanban-model.js'
import type { TaskModalTab } from './kanban/TaskDetailModal.js'
import { TaskDetailModal } from './kanban/TaskDetailModal.js'
import { ToastStack, useToasts } from './kanban/useToasts.js'
import { FILTER_UNASSIGNED } from './kanban/WorkerMultiSelect.js'

interface KanbanBoardProps {
  workspaceId: string
  workers?: readonly TeamListItem[]
  onOpenWorker?: (workerId: string) => void
  openTaskId?: string | null
  /** Вызывается сразу после принятия openTaskId, чтобы родитель обнулил его */
  onTaskOpened?: () => void
}

const EXIT_ANIM_MS = 180
const UNDO_WINDOW_MS = 5000
const SKELETON_MIN_MS = 300

const useDebouncedValue = <T,>(value: T, delay: number): T => {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export const KanbanBoard = ({
  workspaceId,
  workers = [],
  onOpenWorker,
  openTaskId,
  onTaskOpened,
}: KanbanBoardProps) => {
  const [tasks, setTasks] = useState<TaskRecordItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Toolbar state
  const [searchInput, setSearchInput] = useState('')
  const searchQuery = useDebouncedValue(searchInput, 300)
  const [selectedWorkers, setSelectedWorkers] = useState<ReadonlySet<string>>(new Set())
  /** Category filter: empty set = all statuses. */
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<TaskStatus>>(new Set())

  // Card mutations
  const [dispatchingId, setDispatchingId] = useState<string | null>(null)
  const [mutatingId, setMutatingId] = useState<string | null>(null)

  // Detail / create modals
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [modalTab, setModalTab] = useState<TaskModalTab>('desc')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Bulk operations
  const [clearing, setClearing] = useState(false)
  const [deletingBulk, setDeletingBulk] = useState(false)

  // Drag & drop
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null)

  // Micro-interactions
  const [pulse, setPulse] = useState<{ taskId: string; color: string } | null>(null)
  const pulseTimerRef = useRef<number | undefined>(undefined)
  const [recentIds, setRecentIds] = useState<ReadonlySet<string>>(new Set())
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(new Set())
  /** Tasks awaiting the undo-window delete; kept out of the rendered lists. */
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set())
  const pendingDeleteRef = useRef(new Map<string, { timer: number }>())
  const undoToastRef = useRef(new Map<string, number>())
  const [refreshTick, setRefreshTick] = useState(0)
  const [showSkeleton, setShowSkeleton] = useState(false)

  const { toasts, show, dismiss } = useToasts()

  // AbortController для отмены предыдущего fetchTasks при новом вызове
  const fetchAbortRef = useRef<AbortController | null>(null)

  const fetchTasks = useCallback(async () => {
    if (!workspaceId) return
    // Отменяем предыдущий in-flight запрос чтобы предотвратить stale data
    fetchAbortRef.current?.abort()
    const controller = new AbortController()
    fetchAbortRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const data = await listTasks(workspaceId)
      if (controller.signal.aborted) return
      setTasks((prev) => {
        const prevMap = new Map(prev.map((t) => [t.id, t]))
        return data
          .filter((t) => !pendingDeleteRef.current.has(t.id))
          .map((newTask) => {
            const oldTask = prevMap.get(newTask.id)
            // Защита: не откатывать задачу старым ответом если локально уже новее
            if (oldTask && (oldTask.updatedAt ?? 0) > (newTask.updatedAt ?? 0)) {
              return oldTask
            }
            return newTask
          })
      })
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Не удалось загрузить задачи')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [workspaceId])

  // Push-first updates (audit M-5): the tasks WebSocket triggers refreshes via
  // useTasksEvents; polling remains only as a slow safety net while the socket
  // is unhealthy, plus an immediate refresh when the tab becomes visible.
  const eventsHealthy = useTasksEvents(workspaceId, fetchTasks)

  useEffect(() => {
    void fetchTasks()
    return () => {
      fetchAbortRef.current?.abort()
    }
  }, [fetchTasks])

  useEffect(() => {
    const interval = setInterval(
      () => {
        if (!eventsHealthy) void fetchTasks()
      },
      eventsHealthy ? 30_000 : 4_000
    )
    return () => clearInterval(interval)
  }, [eventsHealthy, fetchTasks])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchTasks()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [fetchTasks])

  // Full record for the open modal (comments/logs/result are stripped in the
  // store listing) — merged back into the local cache.
  useEffect(() => {
    if (!selectedTaskId || !workspaceId) return
    let cancelled = false
    void getTask(workspaceId, selectedTaskId)
      .then((task) => {
        if (!cancelled)
          setTasks((current) =>
            current.map((item) => (item.id === task.id ? { ...item, ...task } : item))
          )
      })
      .catch((err) =>
        show(err instanceof Error ? err.message : 'Не удалось загрузить задачу', 'error')
      )
    return () => {
      cancelled = true
    }
  }, [selectedTaskId, workspaceId, show])

  useEffect(() => {
    if (!openTaskId) return
    setSelectedTaskId(openTaskId)
    setModalTab('desc')
    // Сразу сообщаем родителю, что ID принят — иначе при следующем
    // переключении на канбан openTaskId снова откроет ту же задачу
    onTaskOpened?.()
  }, [openTaskId, onTaskOpened])

  // Close modals on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedTaskId(null)
        setShowCreateModal(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const pending = pendingDeleteRef.current
    return () => {
      for (const { timer } of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const workerNameById = useMemo(() => new Map(workers.map((w) => [w.id, w.name])), [workers])

  const visibleTasks = useMemo(() => tasks.filter((t) => !hiddenIds.has(t.id)), [tasks, hiddenIds])

  const filteredTasks = useMemo(
    () =>
      visibleTasks.filter((t) => {
        if (selectedStatuses.size > 0 && !selectedStatuses.has(t.status)) return false
        if (selectedWorkers.size > 0) {
          if (t.assignedAgentId) {
            if (!selectedWorkers.has(t.assignedAgentId)) return false
          } else if (!selectedWorkers.has(FILTER_UNASSIGNED)) {
            return false
          }
        }
        return matchesQuery(t, workerNameById, searchQuery)
      }),
    [visibleTasks, selectedStatuses, selectedWorkers, workerNameById, searchQuery]
  )

  const boardStatusCounts = useMemo(() => statusCounts(visibleTasks), [visibleTasks])
  const hasActiveFilters =
    selectedStatuses.size > 0 || selectedWorkers.size > 0 || searchQuery.trim().length > 0

  const finishedCount = useMemo(
    () => visibleTasks.filter((t) => t.status === 'done' || t.status === 'canceled').length,
    [visibleTasks]
  )
  const activeCount = visibleTasks.length - finishedCount

  const selectedTask = useMemo(
    () => visibleTasks.find((t) => t.id === selectedTaskId) ?? null,
    [visibleTasks, selectedTaskId]
  )

  const flashPulse = (taskId: string, status: TaskStatus) => {
    window.clearTimeout(pulseTimerRef.current)
    setPulse({ taskId, color: COLUMN_BY_ID.get(status)?.accent ?? '#3b82f6' })
    pulseTimerRef.current = window.setTimeout(() => setPulse(null), 1000)
  }

  const markRecent = (taskId: string) => {
    setRecentIds((cur) => new Set(cur).add(taskId))
    window.setTimeout(() => {
      setRecentIds((cur) => {
        const next = new Set(cur)
        next.delete(taskId)
        return next
      })
    }, 700)
  }

  // ---------- Mutations ----------

  const handleMoveStatus = async (taskId: string, nextStatus: TaskStatus) => {
    const current = tasks.find((t) => t.id === taskId)
    if (!current || current.status === nextStatus) return
    if (!canTransition(current.status, nextStatus)) {
      const hint =
        current.status === 'running' && nextStatus === 'done'
          ? ' — сначала через «На проверке»'
          : ''
      show(
        `Недопустимый переход: ${STATUS_LABELS[current.status]} → ${STATUS_LABELS[nextStatus]}${hint}`,
        'error'
      )
      return
    }
    setMutatingId(taskId)
    try {
      const updated = await updateTask(workspaceId, taskId, { status: nextStatus })
      setTasks((cur) => cur.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)))
      flashPulse(taskId, nextStatus)
      show('Статус обновлён', 'success')
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при смене статуса', 'error')
    } finally {
      setMutatingId(null)
    }
  }

  const handleAssign = async (taskId: string, workerId: string) => {
    if (mutatingId === taskId) return
    setMutatingId(taskId)
    try {
      await updateTask(workspaceId, taskId, {
        assigned_worker_id: workerId || null,
        status: workerId ? 'assigned' : 'backlog',
      })
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при назначении', 'error')
    } finally {
      setMutatingId(null)
    }
  }

  const handleDispatch = async (taskId: string, workerId?: string) => {
    setDispatchingId(taskId)
    try {
      await dispatchTaskToWorker(workspaceId, taskId, workerId)
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при запуске задачи воркеру', 'error')
    } finally {
      setDispatchingId(null)
    }
  }

  const handleRework = async (taskId: string, workerId?: string, feedback?: string) => {
    try {
      if (feedback) {
        const updated = await addCommentToTask(
          workspaceId,
          taskId,
          'Orchestrator',
          `[НА ДОРАБОТКУ] ${feedback}`,
          'orchestrator'
        )
        // Оптимистичное обновление — применяем ответ API сразу без полного fetchTasks
        if (updated) {
          setTasks((cur) => cur.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)))
        }
      }
      // Не меняем статус вручную — review→assigned запрещён state machine.
      // dispatchTaskToWorker сам обрабатывает review: шлёт промпт в PTY воркера
      // без смены статуса (задача остаётся в review до следующего team report).
      if (workerId) {
        await dispatchTaskToWorker(workspaceId, taskId, workerId)
      }
      show('Задача отправлена на доработку', 'success')
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при возврате на доработку', 'error')
    }
  }

  const handleAddComment = async (
    author: string,
    message: string,
    anchor?: { path: string; line: number }
  ) => {
    if (!selectedTask) return
    try {
      const updated = await addCommentToTask(
        workspaceId,
        selectedTask.id,
        author,
        message,
        'user',
        anchor
      )
      // Оптимистичное обновление из ответа API — не ждём fetchTasks
      if (updated) {
        setTasks((cur) => cur.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)))
      } else {
        await fetchTasks()
      }
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при добавлении комментария', 'error')
    }
  }

  // ---------- Delete with undo (spec section 7) ----------

  const removeFromHidden = (taskId: string) => {
    setHiddenIds((cur) => {
      const next = new Set(cur)
      next.delete(taskId)
      return next
    })
  }

  const cancelDelete = (taskId: string) => {
    const pending = pendingDeleteRef.current.get(taskId)
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingDeleteRef.current.delete(taskId)
    const toastId = undoToastRef.current.get(taskId)
    if (toastId !== undefined) {
      dismiss(toastId)
      undoToastRef.current.delete(taskId)
    }
    setExitingIds((cur) => {
      const next = new Set(cur)
      next.delete(taskId)
      return next
    })
    removeFromHidden(taskId)
  }

  const finalizeDelete = async (taskId: string) => {
    pendingDeleteRef.current.delete(taskId)
    const toastId = undoToastRef.current.get(taskId)
    undoToastRef.current.delete(taskId)
    if (toastId !== undefined) dismiss(toastId)
    try {
      await deleteTask(workspaceId, taskId)
      removeFromHidden(taskId)
    } catch (err) {
      // Restore the card if the hard delete failed.
      removeFromHidden(taskId)
      show(err instanceof Error ? err.message : 'Ошибка при удалении задачи', 'error')
    }
  }

  const requestDelete = (task: TaskRecordItem) => {
    if (pendingDeleteRef.current.has(task.id)) return
    setExitingIds((cur) => new Set(cur).add(task.id))
    window.setTimeout(() => {
      setExitingIds((cur) => {
        const next = new Set(cur)
        next.delete(task.id)
        return next
      })
      setHiddenIds((cur) => new Set(cur).add(task.id))
    }, EXIT_ANIM_MS)
    const timer = window.setTimeout(() => void finalizeDelete(task.id), UNDO_WINDOW_MS)
    pendingDeleteRef.current.set(task.id, { timer })
    if (selectedTaskId === task.id) setSelectedTaskId(null)
    const toastId = show('Задача удалена', 'info', {
      duration: UNDO_WINDOW_MS,
      action: { label: 'Отменить', run: () => cancelDelete(task.id) },
    })
    undoToastRef.current.set(task.id, toastId)
  }

  const purgePendingFor = (ids: ReadonlySet<string>) => {
    for (const id of ids) cancelDelete(id)
  }

  const handleClearFinished = async () => {
    const toDelete = visibleTasks.filter((t) => t.status === 'done' || t.status === 'canceled')
    if (toDelete.length === 0) return
    setClearing(true)
    const idSet = new Set(toDelete.map((t) => t.id))
    try {
      await Promise.all(toDelete.map((t) => deleteTask(workspaceId, t.id)))
      purgePendingFor(idSet)
      if (selectedTaskId && idSet.has(selectedTaskId)) setSelectedTaskId(null)
      show(`Удалено задач: ${toDelete.length}`, 'success')
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при очистке задач', 'error')
    } finally {
      setClearing(false)
    }
  }

  const handleBulkDeleteFiltered = async () => {
    const toDelete = filteredTasks
    if (toDelete.length === 0) return
    setDeletingBulk(true)
    const idSet = new Set(toDelete.map((t) => t.id))
    try {
      await Promise.all(toDelete.map((t) => deleteTask(workspaceId, t.id)))
      purgePendingFor(idSet)
      if (selectedTaskId && idSet.has(selectedTaskId)) setSelectedTaskId(null)
      show(`Удалено задач: ${toDelete.length}`, 'success')
      await fetchTasks()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Ошибка при массовом удалении задач', 'error')
    } finally {
      setDeletingBulk(false)
    }
  }

  // ---------- Refresh with skeleton (spec section 7) ----------

  const handleRefresh = async () => {
    setShowSkeleton(true)
    try {
      await Promise.all([fetchTasks(), new Promise((r) => setTimeout(r, SKELETON_MIN_MS))])
    } finally {
      setShowSkeleton(false)
      setRefreshTick((tick) => tick + 1)
    }
  }

  // ---------- Create ----------

  const handleCreate = async (input: { title: string; description: string; workerId: string }) => {
    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const created = await createTask(workspaceId, {
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.workerId ? { assigned_worker_id: input.workerId } : {}),
      })
      markRecent(created.id)
      setShowCreateModal(false)
      show('Задача создана', 'success')
      await fetchTasks()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка при создании задачи'
      setCreateError(message)
      throw err instanceof Error ? err : new Error(message)
    } finally {
      setCreateSubmitting(false)
    }
  }

  // ---------- Drag & drop ----------

  const handleDragStartCard = (taskId: string, e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/plain', taskId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTaskId(taskId)
  }

  const handleDragEndCard = () => {
    setDraggingTaskId(null)
    setDragOverColumn(null)
  }

  // ---------- Render helpers ----------

  const columnTasks = (columnId: TaskStatus) => filteredTasks.filter((t) => t.status === columnId)

  // Active draft plan (ROADMAP R2): newest backlog group awaiting approval.
  const activePlanDraft = useMemo(() => {
    const drafts = tasks.filter((t) => t.status === 'backlog' && t.planGroupId)
    if (drafts.length === 0) return null
    const latestGroup = drafts.reduce(
      (best, t) => ((t.plannedAt ?? 0) >= (best?.plannedAt ?? -1) ? t : best),
      undefined as TaskRecordItem | undefined
    )
    const groupId = latestGroup?.planGroupId
    if (!groupId) return null
    return {
      groupId,
      count: drafts.filter((t) => t.planGroupId === groupId).length,
      title: latestGroup.title.replace(/^(Architecture|Backend|Frontend|Tests|Review): /, ''),
    }
  }, [tasks])

  const [planBusy, setPlanBusy] = useState(false)
  const handleApprovePlan = async () => {
    if (!activePlanDraft || planBusy) return
    setPlanBusy(true)
    try {
      await approvePlan(workspaceId, activePlanDraft.groupId)
      await fetchTasks()
    } finally {
      setPlanBusy(false)
    }
  }
  const handleDiscardPlan = async () => {
    if (!activePlanDraft || planBusy) return
    setPlanBusy(true)
    try {
      await discardPlan(workspaceId, activePlanDraft.groupId)
      await fetchTasks()
    } finally {
      setPlanBusy(false)
    }
  }

  const actions: KanbanCardActions = {
    onOpen: (taskId) => {
      setSelectedTaskId(taskId)
      setModalTab('desc')
    },
    onOpenReport: (taskId) => {
      setSelectedTaskId(taskId)
      setModalTab('report')
    },
    onDelete: requestDelete,
    onDispatch: (taskId, workerId) => void handleDispatch(taskId, workerId),
    onAccept: (taskId) => void handleMoveStatus(taskId, 'done'),
    onRework: (taskId, workerId) => void handleRework(taskId, workerId),
  }

  const skeletonActive = showSkeleton || (loading && tasks.length === 0)

  return (
    <div className="kanban select-none">
      <KanbanToolbar
        activeCount={activeCount}
        workerCount={workers.length}
        search={searchInput}
        onSearchChange={setSearchInput}
        resultCount={hasActiveFilters ? filteredTasks.length : null}
        workers={workers}
        selectedWorkers={selectedWorkers}
        onSelectedWorkersChange={setSelectedWorkers}
        statusCounts={boardStatusCounts}
        selectedStatuses={selectedStatuses}
        onSelectedStatusesChange={setSelectedStatuses}
        filteredCount={filteredTasks.length}
        finishedCount={finishedCount}
        loading={loading}
        deletingBulk={deletingBulk}
        clearing={clearing}
        onRefresh={() => void handleRefresh()}
        onCreate={() => setShowCreateModal(true)}
        onBulkDelete={() => void handleBulkDeleteFiltered()}
        onClearFinished={() => void handleClearFinished()}
      />

      {error && (
        <div
          className="flex items-center gap-2 m-4 p-3 rounded text-xs"
          style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#ef4444',
          }}
        >
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Flat compact columns (spec v2: no phase group headers) */}
      {activePlanDraft ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs"
          style={{ background: 'var(--bg-1)', borderColor: 'rgba(99,102,241,0.4)' }}
          data-testid="plan-draft-banner"
        >
          <AlertCircle size={13} className="text-accent" aria-hidden />
          <span className="font-semibold text-pri">План на утверждение:</span>
          <span className="truncate text-sec">{activePlanDraft.title}</span>
          <span className="text-ter">· {activePlanDraft.count} задач в backlog</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              className="workers-btn workers-btn--primary"
              data-testid="plan-approve-btn"
              disabled={planBusy}
              onClick={() => void handleApprovePlan()}
            >
              <Check size={12} aria-hidden /> Утвердить план
            </button>
            <button
              type="button"
              className="workers-btn"
              data-testid="plan-discard-btn"
              disabled={planBusy}
              onClick={() => void handleDiscardPlan()}
            >
              <Trash2 size={12} aria-hidden /> Отбросить
            </button>
          </div>
        </div>
      ) : null}
      <div className="kb-board-scroll scroll-y">
        <div className="kb-board">
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              tasks={columnTasks(column.id)}
              workers={workers}
              query={searchQuery}
              showSkeleton={skeletonActive}
              isDropTarget={dragOverColumn === column.id && draggingTaskId !== null}
              draggingTaskId={draggingTaskId}
              pulse={pulse}
              enteringIds={recentIds}
              exitingIds={exitingIds}
              dispatchingId={dispatchingId}
              refreshKey={refreshTick}
              actions={actions}
              onOpenWorkerTerminal={onOpenWorker}
              onDragStartCard={handleDragStartCard}
              onDragEndCard={handleDragEndCard}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverColumn((cur) => (cur === column.id ? cur : column.id))
              }}
              onDragLeave={() => {
                setDragOverColumn((cur) => (cur === column.id ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                const taskId = e.dataTransfer.getData('text/plain')
                setDraggingTaskId(null)
                setDragOverColumn(null)
                if (!taskId) return
                void handleMoveStatus(taskId, column.id)
              }}
              onCreate={() => setShowCreateModal(true)}
            />
          ))}
        </div>
      </div>

      {selectedTask && (
        <TaskDetailModal
          key={`${selectedTask.id}:${modalTab}`}
          workspaceId={workspaceId}
          task={selectedTask}
          workers={workers.map((w) => ({ id: w.id, name: w.name, role: String(w.role) }))}
          dispatching={dispatchingId === selectedTask.id}
          initialTab={modalTab}
          onClose={() => setSelectedTaskId(null)}
          onMoveStatus={(taskId, status) => void handleMoveStatus(taskId, status)}
          onAssign={(taskId, workerId) => void handleAssign(taskId, workerId)}
          onDispatch={(taskId, workerId) => void handleDispatch(taskId, workerId)}
          onRework={(taskId, workerId, feedback) => void handleRework(taskId, workerId, feedback)}
          onAddComment={handleAddComment}
          onDelete={requestDelete}
        />
      )}

      {showCreateModal && (
        <CreateTaskModal
          workers={workers.map((w) => ({ id: w.id, name: w.name, role: String(w.role) }))}
          submitting={createSubmitting}
          error={createError}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreate}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

export default KanbanBoard
