import { Plus } from 'lucide-react'
import { useRef } from 'react'
import type { TeamListItem } from '../../../../src/shared/types.js'
import type { TaskRecordItem } from '../../api.js'
import type { ColumnDef } from './kanban-model.js'
import { TaskCard } from './TaskCard.js'

export interface KanbanCardActions {
  onOpen: (taskId: string) => void
  onOpenReport: (taskId: string) => void
  onDelete: (task: TaskRecordItem) => void
  onDispatch: (taskId: string, workerId: string | undefined) => void
  onAccept: (taskId: string) => void
  /** Rework keeps the task in review and re-dispatches it to its worker. */
  onRework: (taskId: string, workerId: string | undefined) => void
}

interface KanbanColumnProps {
  column: ColumnDef
  tasks: TaskRecordItem[]
  workers: readonly TeamListItem[]
  query: string
  showSkeleton: boolean
  isDropTarget: boolean
  draggingTaskId: string | null
  /** The single card that should play the status-change pulse animation. */
  pulse: { taskId: string; color: string } | null
  enteringIds: ReadonlySet<string>
  exitingIds: ReadonlySet<string>
  dispatchingId: string | null
  refreshKey: number
  actions: KanbanCardActions
  onOpenWorkerTerminal: ((workerId: string) => void) | undefined
  onDragStartCard: (taskId: string, e: React.DragEvent<HTMLDivElement>) => void
  onDragEndCard: () => void
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void
  onDrop: (e: React.DragEvent<HTMLElement>) => void
  onCreate: () => void
}

export const KanbanColumn = ({
  column,
  tasks,
  workers,
  query,
  showSkeleton,
  isDropTarget,
  draggingTaskId,
  pulse,
  enteringIds,
  exitingIds,
  dispatchingId,
  refreshKey,
  actions,
  onOpenWorkerTerminal,
  onDragStartCard,
  onDragEndCard,
  onDragOver,
  onDragLeave,
  onDrop,
  onCreate,
}: KanbanColumnProps) => {
  const listRef = useRef<HTMLDivElement | null>(null)
  const Icon = column.icon

  return (
    <section
      className={`kb-col ${isDropTarget ? 'kb-col--drop' : ''}`}
      data-count={tasks.length}
      aria-label={`${column.title} (${tasks.length})`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // Ignore leave events that merely moved into our own children.
        if (
          listRef.current &&
          e.relatedTarget instanceof Node &&
          listRef.current.contains(e.relatedTarget)
        ) {
          return
        }
        onDragLeave(e)
      }}
      onDrop={onDrop}
    >
      <header className="kb-col-head">
        <Icon className="kb-col-icon" style={{ color: column.accent }} />
        <span className="kb-col-title">{column.title}</span>
        <span className="kb-col-caption">{column.caption}</span>
        <span className={`kb-col-count kb-col-count--${column.id}`}>{tasks.length}</span>
      </header>

      {showSkeleton ? (
        <div className="kb-col-list" ref={listRef}>
          <div className="kb-skel" />
          <div className="kb-skel" />
          <div className="kb-skel" />
        </div>
      ) : tasks.length === 0 ? (
        <button
          type="button"
          className="kb-col-empty"
          title="Создать задачу"
          aria-label={`Создать задачу в колонке ${column.title}`}
          onClick={onCreate}
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      ) : (
        <div ref={listRef} className="kb-col-list">
          <div
            key={refreshKey > 0 ? refreshKey : undefined}
            className={refreshKey > 0 ? 'kb-fade-in' : undefined}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                worker={workers.find((w) => w.id === task.assignedAgentId)}
                query={query}
                dispatching={dispatchingId === task.id}
                dragging={draggingTaskId === task.id}
                entering={enteringIds.has(task.id)}
                exiting={exitingIds.has(task.id)}
                pulseColor={pulse?.taskId === task.id ? pulse.color : null}
                onOpen={() => actions.onOpen(task.id)}
                onOpenReport={() => actions.onOpenReport(task.id)}
                onDelete={() => actions.onDelete(task)}
                onDispatch={() => actions.onDispatch(task.id, task.assignedAgentId)}
                onAccept={() => actions.onAccept(task.id)}
                onRework={() => actions.onRework(task.id, task.assignedAgentId)}
                onOpenWorkerTerminal={
                  task.assignedAgentId && onOpenWorkerTerminal
                    ? () => onOpenWorkerTerminal(task.assignedAgentId as string)
                    : undefined
                }
                onDragStart={(e) => onDragStartCard(task.id, e)}
                onDragEnd={() => onDragEndCard()}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
