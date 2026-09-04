import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  GitCompare,
  MessageSquare,
  Paperclip,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Trash2,
  User,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { TaskStatus } from '../../../../src/shared/types.js'
import {
  getTaskDiff,
  type TaskCommentItem,
  type TaskDiffResult,
  type TaskRecordItem,
} from '../../api.js'
import { COLUMN_BY_ID, canTransition, STATUS_LABELS, transitionsFrom } from './kanban-model.js'
import { TaskDescriptionBody } from './task-description.js'

export type TaskModalTab = 'desc' | 'report' | 'diff' | 'comments' | 'logs'

interface WorkerRef {
  id: string
  name: string
  role: string
}

interface TaskDetailModalProps {
  workspaceId: string
  task: TaskRecordItem
  workers: readonly WorkerRef[]
  dispatching: boolean
  initialTab?: TaskModalTab
  onClose: () => void
  onMoveStatus: (taskId: string, status: TaskStatus) => void
  onAssign: (taskId: string, workerId: string) => void
  onDispatch: (taskId: string, workerId: string | undefined) => void
  /** Rework: posts the feedback as an orchestrator comment and re-dispatches. */
  onRework: (taskId: string, workerId: string | undefined, feedback: string) => void
  onAddComment: (
    author: string,
    message: string,
    anchor?: { path: string; line: number }
  ) => Promise<void>
  /** Board's undo-window delete; omit to hide the destructive action. */
  onDelete?: (task: TaskRecordItem) => void
}

/** Status accent — mirrors the column accents in kanban-model.ts. */
const STATUS_ACCENTS: Record<TaskStatus, string> = {
  backlog: '#6b7280',
  ready: '#3b82f6',
  claimed: '#38bdf8',
  assigned: '#60a5fa',
  running: '#fbbf24',
  review: '#818cf8',
  blocked: '#f97316',
  failed: '#ef4444',
  done: '#22c55e',
  canceled: '#6b7280',
}

const statusAccent = (status: TaskStatus): string =>
  STATUS_ACCENTS[status] ?? COLUMN_BY_ID.get(status)?.accent ?? '#6b7280'

const statusBadgeStyle = (status: TaskStatus): React.CSSProperties => {
  const accent = statusAccent(status)
  return {
    color: accent,
    background: `${accent}1a`,
    border: `1px solid ${accent}4d`,
    transition: 'background-color 200ms ease, border-color 200ms ease',
  }
}

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * Kanban task detail modal (spec §1–§9): two-column layout — content tabs on
 * the left, meta/actions sidebar (280px) on the right, quick status bar in
 * the footer. Mutations are delegated to the board handlers (which own the
 * state machine guards and toast feedback); the modal only shapes the UX.
 */
export const TaskDetailModal = ({
  workspaceId,
  task,
  workers,
  dispatching,
  initialTab = 'desc',
  onClose,
  onMoveStatus,
  onAssign,
  onDispatch,
  onRework,
  onAddComment,
  onDelete,
}: TaskDetailModalProps) => {
  const [tab, setTab] = useState<TaskModalTab>(initialTab)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [commentInput, setCommentInput] = useState('')
  const [commentAuthor, setCommentAuthor] = useState('User')
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkFeedback, setReworkFeedback] = useState('')
  const [reassignOpen, setReassignOpen] = useState(false)

  // Review diff: fetched lazily when the Diff tab opens.
  const [taskDiff, setTaskDiff] = useState<TaskDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    if (workspaceId && tab === 'diff' && !taskDiff && !diffLoading) {
      let cancelled = false
      setDiffLoading(true)
      setDiffError(null)
      void getTaskDiff(workspaceId, task.id)
        .then((result) => {
          if (!cancelled) setTaskDiff(result)
        })
        .catch((err) => {
          if (!cancelled)
            setDiffError(err instanceof Error ? err.message : 'Не удалось загрузить diff')
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
  }, [tab, workspaceId, task.id, taskDiff, diffLoading])

  const handleCopy = (text: string, fieldId: string) => {
    if (!text) return
    void navigator.clipboard.writeText(text)
    setCopiedField(fieldId)
    setTimeout(() => {
      setCopiedField((cur) => (cur === fieldId ? null : cur))
    }, 2000)
  }

  const assignedWorker = workers.find((w) => w.id === task.assignedAgentId)
  const comments = task.comments ?? []
  const hasResult = Boolean(task.result)

  const tabs: {
    id: TaskModalTab
    label: string
    icon: typeof FileText
    count?: number
    hasData: boolean
    title?: string
  }[] = [
    { id: 'desc', label: 'Задание', icon: FileText, hasData: Boolean(task.description) },
    {
      id: 'report',
      label: 'Отчёт ИИ',
      icon: Bot,
      hasData: hasResult,
      title: 'Отчёт сгенерирован ИИ на основе выполнения задачи',
    },
    {
      id: 'comments',
      label: 'Комментарии',
      icon: MessageSquare,
      count: comments.length,
      hasData: comments.length > 0,
    },
    {
      id: 'logs',
      label: 'Логи',
      icon: ScrollText,
      count: task.logs.length,
      hasData: task.logs.length > 0,
    },
    {
      id: 'diff',
      label: 'Diff',
      icon: GitCompare,
      hasData: Boolean(taskDiff),
      title: 'Изменения в воркспейсе относительно HEAD',
    },
  ]

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; the dialog card inside is the interactive surface
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape-to-close is handled globally by KanbanBoard's keydown listener
    <div
      className="kb-modal-overlay fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation keeps backdrop clicks from closing the dialog; keyboard users close via Escape or the Close button */}
      <div
        className="kb-modal flex max-h-[85vh] w-[900px] max-w-full flex-col overflow-hidden rounded-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="kb-modal__header relative shrink-0 py-4 pl-6 pr-16">
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="kb-modal__close absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-sec transition-colors hover:text-pri"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider"
              style={statusBadgeStyle(task.status)}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: statusAccent(task.status) }}
              />
              {STATUS_LABELS[task.status]}
            </span>
            {(task.supersededFrom || task.possibleDupOf) && (
              <span
                title={
                  task.supersededFrom
                    ? `Замещает задачу ${task.supersededFrom.slice(0, 8)}`
                    : `Возможный дубль ${task.possibleDupOf}`
                }
                className="kb-chip kb-chip--dup"
              >
                ⧉ dup{task.supersededFrom ? ` ⟸ ${task.supersededFrom.slice(0, 8)}` : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => handleCopy(task.id, 'taskId')}
              className="mono flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-ter transition-colors hover:text-pri"
              style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}
              title="Скопировать ID задачи"
            >
              <span>#{task.id.slice(0, 8)}</span>
              {copiedField === 'taskId' ? (
                <Check className="h-3 w-3 text-status-green" />
              ) : (
                <Copy className="h-3 w-3 opacity-60" />
              )}
            </button>
          </div>

          <h3 className="font-display line-clamp-3 max-w-[85%] text-xl font-semibold leading-tight text-pri select-text">
            {task.title}
          </h3>
        </div>

        {/* ── Body: content column + sidebar ─────────────────────── */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Tabs */}
            <div
              className="kb-modal__tabs flex shrink-0 items-center gap-6 px-6 text-sm"
              role="tablist"
            >
              {tabs.map(({ id, label, icon: Icon, count, hasData, title }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  title={title}
                  onClick={() => setTab(id)}
                  className={`kb-modal__tab -mb-px flex items-center gap-1.5 pb-2.5 pt-3 transition-colors ${
                    tab === id
                      ? 'is-active font-semibold text-pri'
                      : hasData
                        ? 'text-sec hover:text-pri'
                        : 'text-extra-light hover:text-sec'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                  {count !== undefined && <span>({count})</span>}
                  {hasData && id !== 'desc' && (
                    <span
                      aria-hidden
                      className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: 'var(--status-green)' }}
                    />
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="kb-modal__body scroll-y min-h-0 flex-1 overflow-y-auto p-6 select-text">
              <div key={tab} className="kb-fade-in">
                {tab === 'desc' && (
                  <DescriptionTab task={task} copiedField={copiedField} onCopy={handleCopy} />
                )}
                {tab === 'report' && (
                  <ReportTab task={task} copiedField={copiedField} onCopy={handleCopy} />
                )}
                {tab === 'comments' && (
                  <CommentsTab
                    comments={comments}
                    author={commentAuthor}
                    input={commentInput}
                    onAuthorChange={setCommentAuthor}
                    onInputChange={setCommentInput}
                    onSubmit={(message) => {
                      void onAddComment(commentAuthor || 'User', message).then(() =>
                        setCommentInput('')
                      )
                    }}
                  />
                )}
                {tab === 'logs' && (
                  <LogsTab logs={task.logs} copiedField={copiedField} onCopy={handleCopy} />
                )}
                {tab === 'diff' && (
                  <DiffTab
                    diff={taskDiff}
                    loading={diffLoading}
                    error={diffError}
                    copiedField={copiedField}
                    onCopy={handleCopy}
                    comments={comments}
                    author={commentAuthor}
                    onAddComment={onAddComment}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ── Sidebar ──────────────────────────────────────────── */}
          <aside className="kb-modal__sidebar scroll-y hidden w-[280px] shrink-0 flex-col gap-6 overflow-y-auto p-5 md:flex">
            {/* Info */}
            <section className="flex flex-col gap-3">
              <SidebarTitle>Информация</SidebarTitle>

              <SidebarField label="Статус">
                <StatusSelect task={task} onChange={(s) => onMoveStatus(task.id, s)} />
              </SidebarField>

              <SidebarField label="Исполнитель">
                <div className="relative">
                  <select
                    value={task.assignedAgentId ?? ''}
                    onChange={(e) => onAssign(task.id, e.target.value)}
                    className="kb-modal__select w-full cursor-pointer appearance-none rounded-lg py-2 pl-8 pr-7 text-[13px] text-pri focus:outline-none"
                  >
                    <option value="">Свободна</option>
                    {workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        @{w.name}
                      </option>
                    ))}
                  </select>
                  <User
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ter"
                  />
                  <ChevronDown
                    aria-hidden
                    className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ter"
                  />
                </div>
              </SidebarField>

              <SidebarField label="Создано">
                <div className="text-[13px] text-pri">{formatDate(task.createdAt)}</div>
              </SidebarField>

              <SidebarField label="Обновлено">
                <div className="text-[13px] text-pri">{formatDate(task.updatedAt)}</div>
              </SidebarField>

              <SidebarField label="ID задачи">
                <button
                  type="button"
                  onClick={() => handleCopy(task.id, 'sidebarId')}
                  className="mono flex items-center gap-1.5 text-xs text-sec transition-colors hover:text-pri"
                  title="Скопировать ID"
                >
                  {task.id}
                  {copiedField === 'sidebarId' ? (
                    <Check className="h-3 w-3 text-status-green" />
                  ) : (
                    <Copy className="h-3 w-3 opacity-60" />
                  )}
                </button>
              </SidebarField>
            </section>

            {/* Actions */}
            <section className="flex flex-col gap-2">
              <SidebarTitle>Действия</SidebarTitle>

              {task.status === 'assigned' && (
                <ActionButton
                  variant="primary"
                  onClick={() => onDispatch(task.id, task.assignedAgentId)}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>
                    {dispatching ? 'Запуск...' : `Запустить @${assignedWorker?.name ?? 'воркера'}`}
                  </span>
                </ActionButton>
              )}

              {task.status === 'running' && (
                <ActionButton
                  variant="secondary"
                  onClick={() => onDispatch(task.id, task.assignedAgentId)}
                  title="Принудительно отправить задачу повторно в PTY терминал воркера"
                >
                  <Zap className="h-3.5 w-3.5" style={{ color: 'var(--status-gold)' }} />
                  <span>{dispatching ? 'Отправка...' : 'Триггернуть бота'}</span>
                </ActionButton>
              )}

              {task.status === 'review' && (
                <>
                  <ActionButton variant="secondary" onClick={() => onMoveStatus(task.id, 'done')}>
                    <CheckCircle2
                      className="h-3.5 w-3.5"
                      style={{ color: 'var(--status-green)' }}
                    />
                    <span>Принять результат</span>
                  </ActionButton>
                  <ActionButton
                    variant="secondary"
                    active={reworkOpen}
                    onClick={() => setReworkOpen((cur) => !cur)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Вернуть на доработку</span>
                  </ActionButton>
                  {reworkOpen && (
                    <div
                      className="flex flex-col gap-2 rounded-lg p-2.5"
                      style={{ background: 'var(--bg-2)' }}
                    >
                      <textarea
                        rows={3}
                        value={reworkFeedback}
                        onChange={(e) => setReworkFeedback(e.target.value)}
                        placeholder="Что именно доработать? (необязательно)"
                        className="input resize-none text-xs"
                        style={{ background: 'var(--bg-0)' }}
                      />
                      <ActionButton
                        variant="primary"
                        onClick={() => {
                          onRework(task.id, task.assignedAgentId, reworkFeedback.trim())
                          setReworkOpen(false)
                          setReworkFeedback('')
                        }}
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>Отправить воркеру</span>
                      </ActionButton>
                    </div>
                  )}
                </>
              )}

              <ActionButton
                variant="secondary"
                active={reassignOpen}
                onClick={() => setReassignOpen((cur) => !cur)}
              >
                <User className="h-3.5 w-3.5" />
                <span>Переназначить</span>
              </ActionButton>
              {reassignOpen && (
                <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-2)' }}>
                  <select
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return
                      setReassignOpen(false)
                      onAssign(task.id, e.target.value)
                    }}
                    className="kb-modal__select w-full cursor-pointer rounded-lg px-2 py-2 text-xs text-pri focus:outline-none"
                    style={{ background: 'var(--bg-0)' }}
                  >
                    <option value="">Выберите воркера…</option>
                    {workers
                      .filter((w) => w.id !== task.assignedAgentId)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          @{w.name} ({w.role})
                        </option>
                      ))}
                  </select>
                  <p className="mt-1.5 px-0.5 text-[11px] leading-snug text-ter">
                    Новый ИИ получит полный контекст: описание, артефакты, логи и комментарии.
                  </p>
                </div>
              )}

              {onDelete && (
                <ActionButton variant="danger" onClick={() => onDelete(task)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Удалить задачу</span>
                </ActionButton>
              )}
            </section>
          </aside>
        </div>

        {/* ── Footer status bar (spec §6) ──────────────────────── */}
        <div className="kb-modal__footer flex h-14 shrink-0 items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-medium text-sec">Статус:</span>
            <div className="w-[180px]">
              <StatusSelect task={task} compact onChange={(s) => onMoveStatus(task.id, s)} />
            </div>
          </div>

          <button type="button" onClick={onClose} className="kb-btn" style={{ width: 100 }}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Building blocks ──────────────────────────────────────────── */

/**
 * Status selector limited to legal transitions of the server state machine
 * (kanban-model.ts mirrors src/server/task-store.ts).
 */
const StatusSelect = ({
  task,
  onChange,
  compact,
}: {
  task: TaskRecordItem
  onChange: (status: TaskStatus) => void
  compact?: boolean
}) => {
  const options = useMemo(
    () =>
      [task.status, ...transitionsFrom(task.status).filter((s) => s !== task.status)].filter(
        (s, idx, arr) => arr.indexOf(s) === idx
      ),
    [task.status]
  )
  return (
    <div className="relative">
      <select
        value={task.status}
        onChange={(e) => {
          const next = e.target.value as TaskStatus
          if (canTransition(task.status, next)) onChange(next)
        }}
        className={`kb-modal__select w-full cursor-pointer appearance-none rounded-lg ${
          compact ? 'py-1.5 pl-8 pr-7 text-xs' : 'py-2 pl-8 pr-7 text-[13px]'
        } font-medium text-pri focus:outline-none`}
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
        style={{ background: statusAccent(task.status), transition: 'background 200ms ease' }}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ter"
      />
    </div>
  )
}

const SidebarTitle = ({ children }: { children: string }) => (
  <h4
    className="font-display mb-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ter"
    style={{ borderBottom: '1px solid var(--border)' }}
  >
    {children}
  </h4>
)

const SidebarField = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[11px] font-medium uppercase tracking-wide text-ter">{label}</span>
    {children}
  </div>
)

type ActionButtonVariant = 'primary' | 'secondary' | 'danger'

const ActionButton = ({
  variant,
  children,
  onClick,
  active,
  title,
}: {
  variant: ActionButtonVariant
  children: ReactNode
  onClick: () => void
  active?: boolean
  title?: string
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`kb-modal__action flex h-9 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-colors ${
      variant === 'danger'
        ? 'text-status-red hover:bg-red-500/10'
        : variant === 'primary'
          ? 'text-white hover:opacity-90'
          : active
            ? 'text-pri'
            : 'text-sec hover:text-pri'
    }`}
    style={
      variant === 'danger'
        ? {
            border: '1px solid color-mix(in oklab, var(--status-red) 30%, transparent)',
            background: 'transparent',
          }
        : variant === 'primary'
          ? { background: 'var(--accent, #6366f1)' }
          : {
              background: 'var(--bg-2)',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
            }
    }
  >
    {children}
  </button>
)

/* ── Tab panels ───────────────────────────────────────────────── */

const SectionHeader = ({ title, action }: { title: string; action?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <span className="text-xs font-semibold uppercase tracking-wider text-sec">{title}</span>
    {action}
  </div>
)

const GhostCopyButton = ({
  label,
  copied,
  onClick,
}: {
  label: string
  copied: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-1.5 px-1 py-1 text-xs text-ter transition-colors hover:text-pri"
  >
    {copied ? (
      <>
        <Check className="h-3.5 w-3.5 text-status-green" />
        <span className="font-medium text-status-green">Скопировано</span>
      </>
    ) : (
      <>
        <Copy className="h-3.5 w-3.5" />
        <span>{label}</span>
      </>
    )}
  </button>
)

const DescriptionTab = ({
  task,
  copiedField,
  onCopy,
}: {
  task: TaskRecordItem
  copiedField: string | null
  onCopy: (text: string, fieldId: string) => void
}) => (
  <div>
    <SectionHeader
      title="Описание задачи"
      action={
        task.description ? (
          <GhostCopyButton
            label="Копировать"
            copied={copiedField === 'desc'}
            onClick={() => onCopy(task.description, 'desc')}
          />
        ) : undefined
      }
    />
    {task.description ? (
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
      >
        <TaskDescriptionBody description={task.description} />
      </div>
    ) : (
      <EmptyHint>Описание не указано.</EmptyHint>
    )}
  </div>
)

const ReportTab = ({
  task,
  copiedField,
  onCopy,
}: {
  task: TaskRecordItem
  copiedField: string | null
  onCopy: (text: string, fieldId: string) => void
}) => (
  <div className="space-y-4">
    <SectionHeader
      title="Финальный результат от ИИ-агента"
      action={
        task.result ? (
          <GhostCopyButton
            label="Копировать отчёт"
            copied={copiedField === 'report'}
            onClick={() => onCopy(task.result ?? '', 'report')}
          />
        ) : undefined
      }
    />
    {task.result ? (
      <div
        className="mono whitespace-pre-wrap rounded-xl p-4 text-xs leading-relaxed"
        style={{
          background: 'color-mix(in oklab, var(--status-green) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--status-green) 20%, transparent)',
          color: 'color-mix(in oklab, var(--status-green) 75%, white)',
        }}
      >
        {task.result}
      </div>
    ) : (
      <EmptyHint>Воркер ещё не предоставил финальный отчёт (team report).</EmptyHint>
    )}

    {task.artifacts && task.artifacts.length > 0 && (
      <div>
        <SectionHeader title={`Артефакты (${task.artifacts.length})`} />
        <div className="space-y-2">
          {task.artifacts.map((art) => (
            <div
              key={art}
              className="mono flex items-center justify-between gap-2 rounded-lg p-3 text-xs text-pri"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
            >
              <div className="flex min-w-0 items-center gap-2 select-text">
                <Paperclip className="h-4 w-4 shrink-0 text-accent" />
                <span className="truncate">{art}</span>
              </div>
              <button
                type="button"
                onClick={() => onCopy(art, `art-${art}`)}
                className="shrink-0 rounded p-1 text-ter transition-colors hover:text-pri"
                title="Скопировать путь"
              >
                {copiedField === `art-${art}` ? (
                  <Check className="h-3.5 w-3.5 text-status-green" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
)

const CommentsTab = ({
  comments,
  author,
  input,
  onAuthorChange,
  onInputChange,
  onSubmit,
}: {
  comments: NonNullable<TaskRecordItem['comments']>
  author: string
  input: string
  onAuthorChange: (value: string) => void
  onInputChange: (value: string) => void
  onSubmit: (message: string) => void
}) => (
  <div className="flex flex-col space-y-4">
    <div className="scroll-y max-h-72 space-y-3 overflow-y-auto pr-1">
      {comments.length === 0 ? (
        <EmptyHint>Комментариев пока нет. Напишите замечание или уточнение для агента.</EmptyHint>
      ) : (
        comments.map((c) => (
          <div
            key={c.id}
            className="space-y-1.5 rounded-xl p-3.5"
            style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center justify-between text-xs text-sec">
              <span className="flex items-center gap-1.5 font-bold text-pri">
                <span>@{c.author}</span>
                {c.authorRole && <span className="font-normal text-sec">({c.authorRole})</span>}
              </span>
              <span>{new Date(c.timestamp).toLocaleTimeString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-pri">{c.message}</p>
          </div>
        ))
      )}
    </div>

    <form
      onSubmit={(e) => {
        e.preventDefault()
        const message = input.trim()
        if (!message) return
        onSubmit(message)
      }}
      className="flex gap-2 pt-3"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <input
        type="text"
        aria-label="Автор комментария"
        value={author}
        onChange={(e) => onAuthorChange(e.target.value)}
        className="input w-24 shrink-0"
      />
      <input
        type="text"
        placeholder="Оставить комментарий к задаче..."
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        className="input flex-1"
      />
      <button
        type="submit"
        disabled={!input.trim()}
        className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        style={{ background: 'var(--accent, #6366f1)' }}
      >
        <Send className="h-3.5 w-3.5" />
        <span>Отправить</span>
      </button>
    </form>
  </div>
)

const LogsTab = ({
  logs,
  copiedField,
  onCopy,
}: {
  logs: string[]
  copiedField: string | null
  onCopy: (text: string, fieldId: string) => void
}) => (
  <div className="space-y-3">
    <SectionHeader
      title="Журнал действий и стриминг прогресса"
      action={
        logs.length > 0 ? (
          <GhostCopyButton
            label="Копировать все"
            copied={copiedField === 'allLogs'}
            onClick={() => onCopy(logs.join('\n'), 'allLogs')}
          />
        ) : undefined
      }
    />
    {logs.length === 0 ? (
      <EmptyHint>Логов пока нет.</EmptyHint>
    ) : (
      <div
        className="mono scroll-y max-h-80 space-y-2 overflow-y-auto rounded-xl p-4 text-xs text-sec"
        style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
      >
        {/* Content + occurrence suffix: log lines can repeat verbatim. */}
        {(() => {
          const seen = new Map<string, number>()
          return logs.map((log) => {
            const n = (seen.get(log) ?? 0) + 1
            seen.set(log, n)
            return (
              <div key={n > 1 ? `${n}:${log}` : log} className="break-words whitespace-pre-wrap">
                {log}
              </div>
            )
          })
        })()}
      </div>
    )}
  </div>
)

interface ParsedDiffLine {
  text: string
  /** Repo-relative file path from the surrounding `diff --git` header. */
  path: string | null
  /** 1-based line in the NEW file version; null for context headers/hunks. */
  line: number | null
}

/** Parse a unified diff into per-line {path, line} anchors for inline comments. */
const parseDiffLines = (diffText: string): ParsedDiffLine[] => {
  let currentPath: string | null = null
  let nextLine = 0
  return diffText.split('\n').map((text) => {
    const gitMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(text)
    if (gitMatch) {
      currentPath = gitMatch[2] ?? null
      return { text, path: currentPath, line: null }
    }
    if (text.startsWith('--- ') || text.startsWith('+++ ')) {
      return { text, path: currentPath, line: null }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      nextLine = Number.parseInt(hunk[1] ?? '0', 10)
      return { text, path: currentPath, line: null }
    }
    if (text.startsWith('+')) {
      const line = nextLine
      nextLine += 1
      return { text, path: currentPath, line }
    }
    if (text.startsWith('-') || text.startsWith('\\')) {
      return { text, path: currentPath, line: null }
    }
    // Context lines advance both versions.
    if (currentPath !== null && !text.startsWith('diff ')) nextLine += 1
    return { text, path: currentPath, line: currentPath !== null ? nextLine : null }
  })
}

const DiffTab = ({
  diff,
  loading,
  error,
  copiedField,
  onCopy,
  comments,
  author,
  onAddComment,
}: {
  diff: TaskDiffResult | null
  loading: boolean
  error: string | null
  copiedField: string | null
  onCopy: (text: string, fieldId: string) => void
  comments: TaskCommentItem[]
  author: string
  onAddComment: (
    author: string,
    message: string,
    anchor?: { path: string; line: number }
  ) => Promise<void>
}) => {
  // Inline review state: which diff line is being commented on + draft text.
  const [activeAnchor, setActiveAnchor] = useState<{ path: string; line: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  if (loading) {
    return (
      <EmptyHint>
        <RefreshCw className="mr-1 inline h-4 w-4 animate-spin" /> Читаю git diff…
      </EmptyHint>
    )
  }
  if (error) {
    return (
      <div
        className="rounded-xl p-4 text-xs"
        style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.25)',
          color: '#ef4444',
        }}
      >
        {error}
      </div>
    )
  }
  if (!diff) return null
  if (!diff.ok) {
    return (
      <div
        className="rounded-xl p-4 text-xs"
        style={{
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.25)',
          color: '#fbbf24',
        }}
      >
        Git diff недоступен: {diff.error}
      </div>
    )
  }

  const anchoredComments = new Map<string, TaskCommentItem[]>()
  for (const c of comments) {
    if (!c.path || !c.line) continue
    const key = `${c.path}:${c.line}`
    const list = anchoredComments.get(key)
    if (list) list.push(c)
    else anchoredComments.set(key, [c])
  }

  const submitInline = () => {
    const message = draft.trim()
    if (!message || !activeAnchor || posting) return
    setPosting(true)
    void onAddComment(author || 'User', message, activeAnchor)
      .then(() => {
        setDraft('')
        setActiveAnchor(null)
      })
      .finally(() => setPosting(false))
  }

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Изменения в воркспейсе (git diff HEAD)"
        action={
          diff.diff ? (
            <GhostCopyButton
              label="Копировать diff"
              copied={copiedField === 'taskDiff'}
              onClick={() => onCopy(diff.diff, 'taskDiff')}
            />
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-sec">
        {diff.branch && (
          <span
            className="rounded-full px-2 py-0.5 font-semibold text-pri"
            style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
          >
            ветка: {diff.branch}
          </span>
        )}
        <span
          className="rounded-full px-2 py-0.5 font-semibold"
          style={
            diff.clean
              ? { color: 'color-mix(in oklab, var(--status-green) 70%, white)' }
              : { color: '#fbbf24' }
          }
        >
          {diff.clean ? 'изменений нет' : 'есть изменения'}
        </span>
        {diff.truncated && <span style={{ color: '#fbbf24' }}>diff обрезан (слишком большой)</span>}
      </div>

      {diff.diff ? (
        <pre
          className="mono scroll-y max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-xl p-4 text-[11px] leading-relaxed"
          style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
        >
          {(() => {
            const parsed = parseDiffLines(diff.diff)
            const rows: ReactNode[] = []
            const seen = new Map<string, number>()
            parsed.forEach((entry) => {
              const n = (seen.get(entry.text) ?? 0) + 1
              seen.set(entry.text, n)
              const rowKey = `${n}:${entry.text}`
              const color =
                entry.text.startsWith('+') && !entry.text.startsWith('+++')
                  ? '#4ade80'
                  : entry.text.startsWith('-') && !entry.text.startsWith('---')
                    ? '#f87171'
                    : entry.text.startsWith('@@')
                      ? '#c084fc'
                      : entry.text.startsWith('diff ')
                        ? '#60a5fa'
                        : undefined
              const anchorKey = entry.path && entry.line ? `${entry.path}:${entry.line}` : null
              const lineComments = anchorKey ? anchoredComments.get(anchorKey) : undefined
              const toggleAnchor =
                entry.path && entry.line ? { path: entry.path, line: entry.line } : null
              const isActive =
                toggleAnchor !== null &&
                activeAnchor?.path === toggleAnchor.path &&
                activeAnchor?.line === toggleAnchor.line
              if (toggleAnchor && !lineComments?.length) {
                rows.push(
                  <button
                    key={`l${rowKey}`}
                    type="button"
                    style={color ? { color } : undefined}
                    onClick={() => {
                      setActiveAnchor(isActive ? null : toggleAnchor)
                      setDraft('')
                    }}
                    className={`-mx-1 block w-full cursor-pointer rounded px-1 text-left hover:bg-white/5${
                      isActive ? ' bg-white/10' : ''
                    }`}
                  >
                    <span className="mr-2 select-none text-[10px] text-ter opacity-50">
                      {entry.line}
                    </span>
                    {entry.text || ' '}
                  </button>
                )
              } else {
                rows.push(
                  <div
                    key={`l${rowKey}`}
                    style={color ? { color } : undefined}
                    className="-mx-1 px-1"
                  >
                    {entry.text || ' '}
                  </div>
                )
              }
              if (lineComments) {
                for (const c of lineComments) {
                  rows.push(
                    <div
                      key={`c${c.id}`}
                      className="-mx-1 my-0.5 rounded px-1 py-0.5 text-[11px]"
                      style={{
                        background: 'rgba(129,140,248,0.08)',
                        borderLeft: '2px solid #818cf8',
                      }}
                    >
                      <span className="font-semibold text-pri">{c.author}</span>
                      <span className="ml-1.5 text-sec">{c.message}</span>
                    </div>
                  )
                }
              }
              if (isActive && activeAnchor) {
                rows.push(
                  <div key={`f${rowKey}`} className="-mx-1 my-1 flex items-center gap-1.5">
                    <input
                      value={draft}
                      placeholder={`Комментарий к ${activeAnchor.path}:${activeAnchor.line}…`}
                      disabled={posting}
                      onChange={(e) => setDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitInline()
                        if (e.key === 'Escape') {
                          setActiveAnchor(null)
                          setDraft('')
                        }
                      }}
                      className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[11px] text-pri focus:outline-none"
                      style={{
                        background: 'var(--bg-1)',
                        border: '1px solid rgba(129,140,248,0.5)',
                      }}
                    />
                    <button
                      type="button"
                      disabled={!draft.trim() || posting}
                      onClick={submitInline}
                      className="icon-btn rounded-lg px-2 py-1 text-[11px]"
                    >
                      {posting ? '…' : 'Оставить'}
                    </button>
                  </div>
                )
              }
            })
            return rows
          })()}
        </pre>
      ) : (
        <EmptyHint>Отслеживаемые файлы не менялись.</EmptyHint>
      )}

      {diff.untrackedFiles.length > 0 && (
        <div>
          <span className="mb-1.5 block text-xs font-semibold text-sec">
            Неслежуемые файлы ({diff.untrackedFiles.length}):
          </span>
          <div className="space-y-1.5">
            {diff.untrackedFiles.map((file) => (
              <div
                key={file}
                className="mono flex items-center gap-2 rounded-lg p-2 text-xs text-pri"
                style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate">{file}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="pt-1 text-[11px] text-ter">
        Кликните по строке diff, чтобы привязать замечание к файлу и строке — оно уйдёт воркеру с
        координатой. Общие правки — во вкладке «Комментарии», отправка на доработку — в «Действиях»
        справа.
      </p>
    </div>
  )
}

const EmptyHint = ({ children }: { children: ReactNode }) => (
  <div
    className="flex items-center justify-center gap-2 rounded-xl p-8 text-center text-sm text-sec opacity-70"
    style={{ border: '1px dashed var(--border)' }}
  >
    <span>{children}</span>
  </div>
)
