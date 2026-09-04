import { ClipboardList, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskStatus, TeamListItem } from '../../../../src/shared/types.js'
import { plural, STATUS_FILTER_CHIPS } from './kanban-model.js'
import { WorkerMultiSelect } from './WorkerMultiSelect.js'

interface KanbanToolbarProps {
  activeCount: number
  workerCount: number
  search: string
  onSearchChange: (value: string) => void
  /** null = поиск неактивен, число = показывать счётчик результатов */
  resultCount: number | null
  workers: readonly TeamListItem[]
  selectedWorkers: ReadonlySet<string>
  onSelectedWorkersChange: (next: Set<string>) => void
  /** Card count per status — chip counters. */
  statusCounts: ReadonlyMap<TaskStatus, number>
  /** Empty set = no category filter (all statuses). */
  selectedStatuses: ReadonlySet<TaskStatus>
  onSelectedStatusesChange: (next: Set<TaskStatus>) => void
  filteredCount: number
  finishedCount: number
  loading: boolean
  deletingBulk: boolean
  clearing: boolean
  onRefresh: () => void
  onCreate: () => void
  onBulkDelete: () => void
  onClearFinished: () => void
}

type ArmTarget = 'bulk' | 'clear' | null

const ARM_TIMEOUT_MS = 4000

export const KanbanToolbar = ({
  activeCount,
  workerCount,
  search,
  onSearchChange,
  resultCount,
  workers,
  selectedWorkers,
  onSelectedWorkersChange,
  statusCounts,
  selectedStatuses,
  onSelectedStatusesChange,
  filteredCount,
  finishedCount,
  loading,
  deletingBulk,
  clearing,
  onRefresh,
  onCreate,
  onBulkDelete,
  onClearFinished,
}: KanbanToolbarProps) => {
  // Micro-toolbar: destructive icon buttons arm on first click and fire on the
  // second (auto-disarm), replacing the previous two-button confirm row.
  const [armed, setArmed] = useState<ArmTarget>(null)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  const toggleStatus = (status: TaskStatus) => {
    const next = new Set(selectedStatuses)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    onSelectedStatusesChange(next)
  }

  return (
    <header className="kb-toolbar">
      <div className="kb-toolbar-row">
        <span className="kb-titlebar">
          <ClipboardList size={13} />
          <span className="kb-titlebar-name">Канбан</span>
          <span className="kb-titlebar-meta">
            {`${activeCount} ${plural(activeCount, ['задача', 'задачи', 'задач'])}`}
            {' · '}
            {`${workerCount} ${plural(workerCount, ['воркер', 'воркера', 'воркеров'])}`}
            {resultCount !== null && ` · найдено: ${resultCount}`}
          </span>
        </span>

        <div style={{ flex: 1 }} />

        <button type="button" className="kb-btn kb-btn--primary" onClick={onCreate}>
          <Plus size={13} />
          <span>Задача</span>
        </button>
      </div>

      <div className="kb-toolbar-row">
        <div className="kb-search">
          <Search size={13} className="kb-search-icon" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Поиск..."
            aria-label="Поиск задач"
          />
          {search && (
            <button
              type="button"
              className="kb-search-clear"
              onClick={() => onSearchChange('')}
              aria-label="Очистить поиск"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <WorkerMultiSelect
          workers={workers}
          selected={selectedWorkers}
          onChange={onSelectedWorkersChange}
        />

        <div style={{ flex: 1 }} />

        <div className="kb-button-group">
          {filteredCount > 0 && (
            <button
              type="button"
              className={`kb-btn kb-icon-btn ${armed === 'bulk' ? 'kb-btn--danger kb-btn--armed' : ''}`}
              title={
                armed === 'bulk'
                  ? `Ещё раз — удалить ${filteredCount}`
                  : `Удалить все отфильтрованные задачи (${filteredCount}). Сузь выбор фильтрами ниже.`
              }
              disabled={deletingBulk}
              onClick={() => {
                if (armed === 'bulk') {
                  setArmed(null)
                  onBulkDelete()
                } else {
                  setArmed('bulk')
                }
              }}
            >
              <Trash2 size={14} />
              <span>
                {selectedStatuses?.size > 0 ? 'Удалить' : ''} {filteredCount}
              </span>
            </button>
          )}

          {finishedCount > 0 && (
            <button
              type="button"
              className={`kb-btn kb-icon-btn ${armed === 'clear' ? 'kb-btn--danger kb-btn--armed' : ''}`}
              title={
                armed === 'clear'
                  ? `Ещё раз — удалить ${finishedCount}`
                  : `Очистить выполненные (${finishedCount})`
              }
              disabled={clearing}
              onClick={() => {
                if (armed === 'clear') {
                  setArmed(null)
                  onClearFinished()
                } else {
                  setArmed('clear')
                }
              }}
            >
              <Sparkles size={14} />
              <span>{finishedCount}</span>
            </button>
          )}

          <button
            type="button"
            className={`kb-btn kb-icon-btn kb-icon-btn--solo ${loading ? 'kb-spinning' : ''}`}
            title="Обновить доску"
            aria-label="Обновить доску"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <fieldset className="kb-filter-row" aria-label="Фильтр по категориям">
        <button
          type="button"
          className={`kb-filter-chip ${selectedStatuses.size === 0 ? 'kb-filter-chip--on' : ''}`}
          data-testid="status-filter-all"
          onClick={() => onSelectedStatusesChange(new Set())}
        >
          Все
        </button>
        {STATUS_FILTER_CHIPS.map((chip) => {
          const count = statusCounts.get(chip.id) ?? 0
          const on = selectedStatuses.has(chip.id)
          return (
            <button
              key={chip.id}
              type="button"
              className={`kb-filter-chip ${on ? 'kb-filter-chip--on' : ''} ${count === 0 ? 'kb-filter-chip--empty' : ''}`}
              data-testid={`status-filter-${chip.id}`}
              style={on ? { borderColor: chip.accent, color: chip.accent } : undefined}
              aria-pressed={on}
              onClick={() => toggleStatus(chip.id)}
            >
              {chip.label}
              <span className="kb-filter-chip-count">{count}</span>
            </button>
          )
        })}
      </fieldset>
    </header>
  )
}
