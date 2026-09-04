import { Check, ChevronDown, UserX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TeamListItem } from '../../../../src/shared/types.js'
import { Avatar } from './Avatar.js'

/** Pseudo-filter value matching tasks without an assignee. */
export const FILTER_UNASSIGNED = '__unassigned__'

interface WorkerMultiSelectProps {
  workers: readonly TeamListItem[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}

export const WorkerMultiSelect = ({ workers, selected, onChange }: WorkerMultiSelectProps) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const pickedWorkers = workers.filter((w) => selected.has(w.id))
  const count = pickedWorkers.length + (selected.has(FILTER_UNASSIGNED) ? 1 : 0)
  const singlePicked = pickedWorkers[0]
  const label =
    count === 0
      ? 'Все воркеры'
      : count === 1 && singlePicked
        ? `@${singlePicked.name}`
        : `${count} выбрано`

  return (
    <div className="kb-ms-wrap" ref={rootRef}>
      <button
        type="button"
        className="kb-ms-trigger"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {count > 0 ? (
          <>
            <span className="kb-avatar-stack">
              {(count > pickedWorkers.length
                ? pickedWorkers.slice(0, 2)
                : pickedWorkers.slice(0, 3)
              ).map((w) => (
                <Avatar key={w.id} name={w.name} />
              ))}
            </span>
            <span>{label}</span>
            <span className="kb-ms-count">{count}</span>
          </>
        ) : (
          <span>{label}</span>
        )}
        <ChevronDown size={13} style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div className="kb-ms-panel" role="listbox" aria-label="Фильтр по воркерам">
          <button
            type="button"
            className="kb-ms-item"
            role="option"
            aria-selected={selected.has(FILTER_UNASSIGNED)}
            onClick={() => toggle(FILTER_UNASSIGNED)}
          >
            <span
              className={`kb-checkbox ${selected.has(FILTER_UNASSIGNED) ? 'kb-checkbox--on' : ''}`}
            >
              <Check size={11} strokeWidth={3} />
            </span>
            <UserX size={14} style={{ color: 'var(--text-tertiary)' }} />
            <span className="kb-ms-item-name">Без исполнителя</span>
          </button>
          {workers.map((w) => (
            <button
              key={w.id}
              type="button"
              className="kb-ms-item"
              role="option"
              aria-selected={selected.has(w.id)}
              onClick={() => toggle(w.id)}
            >
              <span className={`kb-checkbox ${selected.has(w.id) ? 'kb-checkbox--on' : ''}`}>
                <Check size={11} strokeWidth={3} />
              </span>
              <Avatar name={w.name} />
              <span className="kb-ms-item-name">@{w.name}</span>
              <span className="kb-ms-item-role">{w.role}</span>
            </button>
          ))}
          {count > 0 && (
            <button
              type="button"
              className="kb-ms-item"
              onClick={() => onChange(new Set())}
              style={{ color: 'var(--text-tertiary)', justifyContent: 'center' }}
            >
              Сбросить фильтр
            </button>
          )}
        </div>
      )}
    </div>
  )
}
