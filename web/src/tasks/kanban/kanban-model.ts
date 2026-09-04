import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Eye,
  type LucideIcon,
  User,
  XCircle,
  Zap,
} from 'lucide-react'
import type { TaskStatus } from '../../../../src/shared/types.js'
import type { TaskRecordItem } from '../../api.js'

/**
 * Server-authoritative status machine, mirrored verbatim from
 * `src/server/task-store.ts` (`statusTransitions`) so the board can
 * pre-validate drag & drop and status selects without a round trip.
 * The server remains the single source of truth — invalid transitions
 * are still rejected there.
 */
export const STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  assigned: ['ready', 'claimed', 'running', 'review', 'done', 'blocked', 'failed', 'canceled'],
  backlog: ['ready', 'claimed', 'assigned', 'canceled'],
  canceled: ['backlog'],
  claimed: ['ready', 'assigned', 'running', 'blocked', 'failed', 'canceled'],
  done: [],
  blocked: ['ready', 'claimed', 'assigned', 'running', 'failed', 'canceled'],
  failed: ['ready', 'claimed', 'assigned', 'canceled'],
  ready: ['claimed', 'assigned', 'canceled'],
  review: ['running', 'ready', 'done', 'failed', 'canceled'],
  running: ['ready', 'review', 'blocked', 'failed', 'canceled'],
}

export const transitionsFrom = (status: TaskStatus): readonly TaskStatus[] =>
  STATUS_TRANSITIONS[status] ?? []

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  transitionsFrom(from).includes(to)

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Бэклог',
  ready: 'Готова к работе',
  claimed: 'Заявлена',
  assigned: 'Назначена',
  running: 'В работе',
  review: 'На проверке',
  blocked: 'Заблокирована',
  failed: 'Ошибка',
  done: 'Готово',
  canceled: 'Отменена',
}

export interface ColumnDef {
  id: TaskStatus
  title: string
  /** English caption rendered as small uppercase subtitle under the title. */
  caption: string
  icon: LucideIcon
  /** Status accent: header icon + fallback card left border. */
  accent: string
  /** Counter badge background (spec section 5, dark theme). */
  badgeBg: string
  strike?: boolean
}

export const COLUMNS: ColumnDef[] = [
  {
    id: 'backlog',
    title: 'Бэклог',
    caption: 'Backlog',
    icon: CircleDashed,
    accent: '#6b7280',
    badgeBg: '#2a2a2a',
  },
  {
    id: 'ready',
    title: 'Готово к работе',
    caption: 'Ready',
    icon: Circle,
    accent: '#3b82f6',
    badgeBg: '#1e3a5f',
  },
  {
    id: 'assigned',
    title: 'Назначено',
    caption: 'Assigned',
    icon: User,
    accent: '#60a5fa',
    badgeBg: '#1e3a5f',
  },
  {
    id: 'running',
    title: 'В работе',
    caption: 'Running',
    icon: Zap,
    accent: '#fbbf24',
    badgeBg: '#3f2e05',
  },
  {
    id: 'review',
    title: 'На проверке',
    caption: 'Review',
    icon: Eye,
    accent: '#818cf8',
    badgeBg: '#312e81',
  },
  {
    id: 'done',
    title: 'Готово',
    caption: 'Done',
    icon: CheckCircle2,
    accent: '#22c55e',
    badgeBg: '#064e3b',
  },
  {
    id: 'failed',
    title: 'Ошибка',
    caption: 'Failed',
    icon: XCircle,
    accent: '#ef4444',
    badgeBg: '#450a0a',
  },
  {
    id: 'canceled',
    title: 'Отменено',
    caption: 'Canceled',
    icon: Ban,
    accent: '#6b7280',
    badgeBg: '#2a2a2a',
    strike: true,
  },
]

export const COLUMN_BY_ID = new Map(COLUMNS.map((c) => [c.id, c]))

/** Toolbar category filter: one chip per board column, board order. */
export const STATUS_FILTER_CHIPS: readonly { id: TaskStatus; label: string; accent: string }[] =
  COLUMNS.map((c) => ({ id: c.id, label: c.title, accent: c.accent }))

/** Occurrences per status, used for the category filter chip counters. */
export const statusCounts = (tasks: readonly { status: TaskStatus }[]) => {
  const counts = new Map<TaskStatus, number>()
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  return counts
}

export type CardPriority = NonNullable<TaskRecordItem['priority']>

const PRIORITY_BORDER: Partial<Record<CardPriority, string>> = {
  high: '#ef4444',
  critical: '#ef4444',
  low: '#22c55e',
}

const PRIORITY_BADGE: Partial<Record<CardPriority, string>> = {
  high: 'срочно',
  critical: 'срочно',
  low: 'низкий',
}

/** Left border color for a card: priority wins over the column accent. */
export const cardBorderColor = (
  priority: CardPriority | undefined,
  columnAccent: string
): string => (priority ? (PRIORITY_BORDER[priority] ?? columnAccent) : columnAccent)

export const priorityBadge = (priority: CardPriority | undefined): string | undefined =>
  priority ? PRIORITY_BADGE[priority] : undefined

/** Russian plural forms helper: plural(3, ['задача','задачи','задач']). */
export const plural = (n: number, forms: [string, string, string]): string => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/** All-occurrence case-insensitive substring ranges for search highlighting. */
export const findMatchRanges = (text: string, query: string): Array<[number, number]> => {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const haystack = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(q, from)
    if (idx === -1) break
    ranges.push([idx, idx + q.length])
    from = idx + q.length
  }
  return ranges
}

export interface SearchableTask {
  id: string
  title: string
  description: string
  assignedAgentId?: string | undefined
}

/**
 * Board search matches title, description, task id prefix and the
 * assigned worker's display name (without the @).
 */
export const matchesQuery = (
  task: SearchableTask,
  workerNameById: Map<string, string>,
  query: string
): boolean => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (task.title.toLowerCase().includes(q)) return true
  if (task.description.toLowerCase().includes(q)) return true
  if (task.id.toLowerCase().includes(q)) return true
  const name = task.assignedAgentId ? workerNameById.get(task.assignedAgentId) : undefined
  return name?.toLowerCase().includes(q) ?? false
}
