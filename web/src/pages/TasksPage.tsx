import { AlertCircle, CheckCircle, Clock, Plus, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { TaskStatus, TeamListItem } from '../../../src/shared/types.js'
import { createTask, listTasks, type TaskRecordItem, updateTask } from '../api.js'

interface TasksPageProps {
  workspaceId: string
  workers?: TeamListItem[]
}

const statusColors: Record<TaskStatus, string> = {
  backlog: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  ready: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  assigned: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  running: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  review: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  failed: 'bg-red-500/10 text-red-500 border-red-500/20',
  done: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  canceled: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
}

const statusIcons: Record<TaskStatus, typeof CheckCircle> = {
  backlog: Clock,
  ready: Clock,
  assigned: RefreshCw,
  running: RefreshCw,
  review: AlertCircle,
  failed: AlertCircle,
  done: CheckCircle,
  canceled: XCircle,
}

export const TasksPage = ({ workspaceId, workers = [] }: TasksPageProps) => {
  const [tasks, setTasks] = useState<TaskRecordItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [filterStatus, setFilterStatus] = useState<string>('all')

  const fetchTasks = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const data = await listTasks(workspaceId)
      setTasks(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить задачи')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void fetchTasks()
  }, [fetchTasks])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return

    try {
      await createTask(workspaceId, {
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        assigned_worker_id: selectedWorkerId || undefined,
      })
      setNewTitle('')
      setNewDescription('')
      setSelectedWorkerId('')
      setShowCreateModal(false)
      await fetchTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка при создании задачи')
    }
  }

  const handleStatusChange = async (taskId: string, status: TaskStatus) => {
    try {
      await updateTask(workspaceId, taskId, { status })
      await fetchTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка при обновлении задачи')
    }
  }

  const handleAssignWorker = async (taskId: string, workerId: string) => {
    try {
      await updateTask(workspaceId, taskId, {
        assigned_worker_id: workerId || null,
        status: workerId ? 'assigned' : 'backlog',
      })
      await fetchTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка при назначении воркера')
    }
  }

  const filteredTasks = tasks.filter((t) => {
    if (filterStatus === 'all') return true
    return t.status === filterStatus
  })

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-border">
        <div>
          <h1 className="text-xl font-bold text-pri">Задачи воркеров</h1>
          <p className="text-sm text-sec">Журнал задач и отслеживание выполнения агентами</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void fetchTasks()}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-hover text-sec transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Обновить
          </button>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded bg-accent text-accent-fg hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            Создать задачу
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Фильтр статусов */}
      <div className="flex items-center gap-2 mb-4">
        {[
          'all',
          'backlog',
          'ready',
          'assigned',
          'running',
          'review',
          'failed',
          'done',
          'canceled',
        ].map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setFilterStatus(st)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filterStatus === st
                ? 'bg-accent/15 border-accent text-pri font-medium'
                : 'border-border text-sec hover:bg-hover'
            }`}
          >
            {st === 'all' && `Все (${tasks.length})`}
            {st === 'backlog' && `Бэклог (${tasks.filter((t) => t.status === 'backlog').length})`}
            {st === 'ready' && `Готовые (${tasks.filter((t) => t.status === 'ready').length})`}
            {st === 'assigned' &&
              `Назначенные (${tasks.filter((t) => t.status === 'assigned').length})`}
            {st === 'running' && `В работе (${tasks.filter((t) => t.status === 'running').length})`}
            {st === 'review' && `Проверка (${tasks.filter((t) => t.status === 'review').length})`}
            {st === 'failed' && `Ошибки (${tasks.filter((t) => t.status === 'failed').length})`}
            {st === 'done' && `Завершённые (${tasks.filter((t) => t.status === 'done').length})`}
            {st === 'canceled' &&
              `Отменённые (${tasks.filter((t) => t.status === 'canceled').length})`}
          </button>
        ))}
      </div>

      {/* Список задач */}
      {filteredTasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed border-border rounded-lg">
          <Clock className="w-8 h-8 text-sec/40 mb-3" />
          <p className="text-sm font-medium text-sec">Задач пока нет</p>
          <p className="text-xs text-sec/60 mt-1">Создайте новую задачу для назначения воркерам</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredTasks.map((task) => {
            const StatusIcon = statusIcons[task.status] || Clock

            return (
              <div
                key={task.id}
                className="p-4 rounded-lg border border-border bg-card/40 hover:bg-card/70 transition-colors flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${
                          statusColors[task.status]
                        }`}
                      >
                        <StatusIcon className="w-3 h-3" />
                        {task.status}
                      </span>
                      <h3 className="text-sm font-semibold text-pri truncate">{task.title}</h3>
                    </div>
                    {task.description && (
                      <p className="text-xs text-sec whitespace-pre-wrap mt-1">
                        {task.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Выбор воркера */}
                    <select
                      value={task.assignedAgentId ?? ''}
                      onChange={(e) => void handleAssignWorker(task.id, e.target.value)}
                      className="text-xs bg-bg border border-border rounded px-2 py-1 text-pri focus:outline-none focus:border-accent"
                    >
                      <option value="">Не назначен</option>
                      {workers.map((w) => (
                        <option key={w.id} value={w.id}>
                          @{w.name} ({w.role})
                        </option>
                      ))}
                    </select>

                    {/* Смена статуса */}
                    <select
                      value={task.status}
                      onChange={(e) =>
                        void handleStatusChange(task.id, e.target.value as TaskStatus)
                      }
                      className="text-xs bg-bg border border-border rounded px-2 py-1 text-pri focus:outline-none focus:border-accent"
                    >
                      <option value="open">open</option>
                      <option value="in_progress">in_progress</option>
                      <option value="done">done</option>
                      <option value="canceled">canceled</option>
                    </select>
                  </div>
                </div>

                {/* Журнал логов */}
                {task.logs.length > 0 && (
                  <div className="mt-2 p-2.5 rounded bg-bg/70 border border-border/60 text-[11px] font-mono text-sec space-y-1 max-h-32 overflow-y-auto">
                    <div className="text-[10px] uppercase font-bold text-sec/70 tracking-wider">
                      Журнал действий:
                    </div>
                    {task.logs.map((log) => (
                      <div key={log} className="truncate">
                        {log}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Модальное окно создания задачи */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-bg border border-border rounded-xl p-6 max-w-md w-full shadow-2xl">
            <h2 className="text-base font-bold text-pri mb-4">Создать новую задачу</h2>
            <form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
              <div>
                <label
                  htmlFor="task-title-input"
                  className="block text-xs font-medium text-sec mb-1"
                >
                  Название задачи <span className="text-red-400">*</span>
                </label>
                <input
                  id="task-title-input"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Реализовать компонент..."
                  className="w-full text-xs bg-card border border-border rounded px-3 py-2 text-pri focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label
                  htmlFor="task-desc-input"
                  className="block text-xs font-medium text-sec mb-1"
                >
                  Описание задачи
                </label>
                <textarea
                  id="task-desc-input"
                  rows={3}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Подробности задачи..."
                  className="w-full text-xs bg-card border border-border rounded px-3 py-2 text-pri focus:outline-none focus:border-accent resize-none"
                />
              </div>

              <div>
                <label
                  htmlFor="task-worker-select"
                  className="block text-xs font-medium text-sec mb-1"
                >
                  Назначить воркера (опционально)
                </label>
                <select
                  id="task-worker-select"
                  value={selectedWorkerId}
                  onChange={(e) => setSelectedWorkerId(e.target.value)}
                  className="w-full text-xs bg-card border border-border rounded px-3 py-2 text-pri focus:outline-none focus:border-accent"
                >
                  <option value="">Не назначать сразу</option>
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      @{w.name} ({w.role})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 text-xs text-sec hover:bg-hover rounded border border-border transition-colors"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="px-3 py-1.5 text-xs bg-accent text-accent-fg hover:opacity-90 rounded font-medium disabled:opacity-50 transition-opacity"
                >
                  Создать
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
export default TasksPage
