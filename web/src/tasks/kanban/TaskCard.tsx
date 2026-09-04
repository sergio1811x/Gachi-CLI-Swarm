import {
  Bot,
  Check,
  Clock,
  MessageSquare,
  Play,
  RotateCcw,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react'
import type { TeamListItem } from '../../../../src/shared/types.js'
import type { TaskRecordItem } from '../../api.js'
import { WorkerTip } from './Avatar.js'
import { Highlight } from './Highlight.js'
import type { CardPriority } from './kanban-model.js'
import { COLUMN_BY_ID, cardBorderColor, priorityBadge } from './kanban-model.js'

interface TaskCardProps {
  task: TaskRecordItem
  /** Resolved assignee for the tooltip / dispatch labels. */
  worker: TeamListItem | undefined
  query: string
  dispatching: boolean
  dragging: boolean
  entering: boolean
  exiting: boolean
  pulseColor: string | null
  onOpen: () => void
  onOpenReport: () => void
  onDelete: () => void
  onDispatch: () => void
  onAccept: () => void
  onRework: () => void
  onOpenWorkerTerminal: (() => void) | undefined
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: (e: React.DragEvent<HTMLDivElement>) => void
}

/**
 * Clicks bubbling from the card's own controls (buttons, selects) must not
 * open the detail modal, so the root handler ignores interactive targets
 * instead of wrapping every control in stopPropagation layers.
 *
 * Note: `[role="button"]` must NOT be part of this selector — the card root
 * itself carries role="button", and closest() would match it, swallowing
 * every card click.
 */
const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('button, select, a, input, textarea') !== null

/** Translucent tint + text color from a hex accent, for the status badge. */
const statusBadgeStyle = (accent: string): React.CSSProperties => ({
  color: accent,
  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
})

export const TaskCard = ({
  task,
  worker,
  query,
  dispatching,
  dragging,
  entering,
  exiting,
  pulseColor,
  onOpen,
  onOpenReport,
  onDelete,
  onDispatch,
  onAccept,
  onRework,
  onOpenWorkerTerminal,
  onDragStart,
  onDragEnd,
}: TaskCardProps) => {
  const column = COLUMN_BY_ID.get(task.status)
  const workerName = worker?.name
  const badge = priorityBadge(task.priority as CardPriority | undefined)
  const borderColor = cardBorderColor(
    task.priority as CardPriority | undefined,
    column?.accent ?? '#3b82f6'
  )

  const classes = [
    'kb-card',
    dragging ? 'kb-card--dragging' : '',
    entering ? 'kb-card--enter' : '',
    exiting ? 'kb-card--exit' : '',
    pulseColor ? 'kb-card--pulse' : '',
    column?.strike ? 'kb-card--strike' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <button> cannot legally contain the select inputs rendered inside a kanban card
    <div
      className={classes}
      style={{
        borderLeft: `2px solid ${borderColor}`,
        ...(pulseColor ? { ['--pulse-color' as string]: pulseColor } : {}),
      }}
      role="button"
      tabIndex={0}
      aria-label={task.title}
      draggable={!exiting}
      onClick={(e) => {
        if (isInteractiveTarget(e.target)) return
        onOpen()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="kb-card-top">
        <button
          type="button"
          className="kb-card-delete"
          title="Удалить задачу"
          aria-label="Удалить задачу"
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {(badge || task.supersededFrom || task.possibleDupOf) && (
        <div className="kb-chip-row">
          {badge && (
            <span className={`kb-chip ${badge === 'срочно' ? 'kb-chip--urgent' : 'kb-chip--low'}`}>
              {badge}
            </span>
          )}
          {(task.supersededFrom || task.possibleDupOf) && (
            <span
              className="kb-chip kb-chip--dup"
              title={
                task.supersededFrom
                  ? `Замещает задачу ${task.supersededFrom.slice(0, 8)}`
                  : `Возможный дубль ${task.possibleDupOf}`
              }
            >
              дубль{task.supersededFrom ? ` ⟸ ${task.supersededFrom.slice(0, 8)}` : ''}
            </span>
          )}
        </div>
      )}

      <h4 className="kb-card-title">
        <Highlight text={task.title} query={query} />
      </h4>

      {task.description && (
        <p className="kb-card-desc">
          <Highlight text={task.description} query={query} />
        </p>
      )}

      {/* Meta line: @worker · status · [report] · [actions] · counts */}
      <div className="kb-card-meta">
        {workerName ? (
          <span className="kb-card-user" title={workerName}>
            @{workerName}
          </span>
        ) : (
          <span>свободна</span>
        )}
        {column ? (
          <span className="kb-status-badge" style={statusBadgeStyle(column.accent)}>
            {column.caption}
          </span>
        ) : null}

        <span className="kb-meta-right">
          {task.result && (
            <button
              type="button"
              className="kb-link-act kb-link-act--yes"
              title="Открыть отчёт ИИ"
              onClick={onOpenReport}
            >
              <Bot />
              отчёт
            </button>
          )}
          {task.status === 'assigned' && task.assignedAgentId && (
            <button
              type="button"
              className="kb-link-act kb-link-act--blue"
              disabled={dispatching}
              title="Отправить задачу воркеру"
              onClick={onDispatch}
            >
              <Play />
              {dispatching ? 'Запуск…' : 'Запустить'}
            </button>
          )}
          {task.status === 'running' && task.assignedAgentId && (
            <button
              type="button"
              className="kb-link-act kb-link-act--amber"
              disabled={dispatching}
              title="Отправить задачу повторно в PTY терминал воркера"
              onClick={onDispatch}
            >
              <Zap />
              {dispatching ? 'Отправка…' : 'Триггер'}
            </button>
          )}
          {task.status === 'review' && (
            <>
              <button
                type="button"
                className="kb-link-act kb-link-act--yes"
                title="Принять задачу"
                onClick={onAccept}
              >
                <Check />
                Принять
              </button>
              <button
                type="button"
                className="kb-link-act kb-link-act--no"
                title="Вернуть воркеру на доработку"
                onClick={onRework}
              >
                <RotateCcw />
                Отклонить
              </button>
            </>
          )}
        </span>
      </div>

      {/* Mentions footer */}
      <div className="kb-card-footer">
        {task.assignedAgentId && workerName ? (
          onOpenWorkerTerminal ? (
            <WorkerTip worker={worker}>
              <button type="button" className="kb-mention" onClick={onOpenWorkerTerminal}>
                <Terminal size={11} />
                <span>↳ @{workerName}</span>
              </button>
            </WorkerTip>
          ) : (
            <span className="kb-mention" style={{ cursor: 'default' }}>
              ↳ @{workerName}
            </span>
          )
        ) : (
          <span>нет исполнителя</span>
        )}
        <span className="kb-card-counts">
          {(task.comments?.length ?? 0) > 0 && (
            <span>
              <MessageSquare size={10} />
              {task.comments?.length}
            </span>
          )}
          {task.logs.length > 0 && (
            <span>
              <Clock size={10} />
              {task.logs.length}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export default TaskCard
