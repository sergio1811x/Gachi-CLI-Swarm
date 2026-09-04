/**
 * T1 Autonomy Loop: per-workspace schedules that create work on their own.
 * A schedule lives in app-state as JSON:
 *
 *   key:   `schedule_<workspaceId>`
 *   value: { "intervalMinutes": 1440, "goal": "…", "title": "…" }
 *        or { "dailyAt": "09:30",      "goal": "…", "title": "…" }
 *
 * Semantics:
 * - `intervalMinutes` — fire every N minutes while the previous fired task is
 *   no longer open (anti-flood is the caller's job via hasOpenScheduledTask).
 * - `dailyAt` "HH:MM" local time — fire once per calendar day at/after that
 *   time (catch-up: if the app was off at 09:30, it fires on the first tick
 *   after boot the same day).
 * - Last-fired timestamp persists in `schedule_lastfired_<wsId>` so restarts
 *   do not double-fire within the same period.
 */

export const SCHEDULE_KEY_PREFIX = 'schedule_'
export const SCHEDULE_LAST_FIRED_PREFIX = 'schedule_lastfired_'

export interface ScheduleConfig {
  /** Concrete instruction for the created task. */
  goal: string
  /** Interval-based rule. */
  intervalMinutes?: number | undefined
  /** Daily-at-time rule ("HH:MM" local). */
  dailyAt?: string | undefined
  /** Optional task title; derived from goal when omitted. */
  title?: string | undefined
}

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

export const parseScheduleConfig = (raw: string | null | undefined): ScheduleConfig | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const goal = typeof parsed.goal === 'string' ? parsed.goal.trim() : ''
    if (!goal) return null
    const intervalMinutes =
      typeof parsed.intervalMinutes === 'number' && parsed.intervalMinutes >= 1
        ? Math.floor(parsed.intervalMinutes)
        : undefined
    const dailyAt =
      typeof parsed.dailyAt === 'string' && /^\d{2}:\d{2}$/.test(parsed.dailyAt)
        ? parsed.dailyAt
        : undefined
    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined
    if (!intervalMinutes && !dailyAt) return null
    return { dailyAt, goal, intervalMinutes, title }
  } catch {
    return null
  }
}

export const readSchedule = (
  settings: AppStateReader,
  workspaceId: string
): ScheduleConfig | null =>
  parseScheduleConfig(settings.getAppState(`${SCHEDULE_KEY_PREFIX}${workspaceId}`)?.value)

export const readLastFiredAt = (settings: AppStateReader, workspaceId: string): number | null => {
  const raw = settings.getAppState(`${SCHEDULE_LAST_FIRED_PREFIX}${workspaceId}`)?.value
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export const writeLastFiredAt = (
  settings: { setAppState: (key: string, value: string) => void },
  workspaceId: string,
  at: number
): void => {
  settings.setAppState(`${SCHEDULE_LAST_FIRED_PREFIX}${workspaceId}`, String(at))
}

const MINUTE = 60_000
const _DAY = 24 * 60 * MINUTE

/** Pure due-check + next-run computation. */
export const isScheduleDue = (
  config: ScheduleConfig,
  lastFiredAt: number | null,
  now: number
): boolean => {
  if (config.intervalMinutes) {
    const intervalMs = config.intervalMinutes * MINUTE
    if (lastFiredAt === null) return true
    return now - lastFiredAt >= intervalMs
  }
  if (config.dailyAt) {
    const [hh, mm] = config.dailyAt.split(':').map((part) => Number(part))
    const todayAt = new Date(now)
    todayAt.setHours(hh ?? 0, mm ?? 0, 0, 0)
    const scheduledToday = todayAt.getTime()
    // Due when we are past today's time AND have not fired since it started.
    if (lastFiredAt !== null && lastFiredAt >= scheduledToday) return false
    return now >= scheduledToday
  }
  return false
}

/** Marker embedded in the task description so anti-flood can find open ones. */
export const scheduledMarker = (workspaceId: string): string =>
  `[scheduled:${SCHEDULE_KEY_PREFIX}${workspaceId}]`

/** True when a previous scheduled task of this policy is still open. */
export const hasOpenScheduledTask = (
  tasks: Array<{ description: string; status: string }>,
  marker: string
): boolean =>
  tasks.some(
    (task) =>
      ['backlog', 'ready', 'claimed', 'assigned', 'running'].includes(task.status) &&
      task.description.includes(marker)
  )

/** Builds the card payload for a fired schedule. */
export const buildScheduledTaskInput = (
  config: ScheduleConfig,
  workspaceId: string
): { description: string; title: string } => ({
  description: [
    scheduledMarker(workspaceId),
    '',
    config.goal,
    '',
    'This task was created automatically by a workspace schedule.',
  ].join('\n'),
  title: config.title?.trim() || `⟳ ${config.goal.split('\n')[0]?.slice(0, 70)}`,
})

/** Day-key helper for the Telegram morning digest (local time). */
export const dayKey = (now: number): string => {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}
