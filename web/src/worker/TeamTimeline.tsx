import { Activity, ArrowUpRight, Radio } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'

type TimelineEvent = {
  agent: TeamListItem
  detail: string
  kind: 'dispatch' | 'output' | 'status'
  timestamp: number
}

const relativeTime = (timestamp: number, language: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : 'hour'
  const value =
    unit === 'second'
      ? -seconds
      : unit === 'minute'
        ? -Math.round(seconds / 60)
        : -Math.round(seconds / 3600)
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(value, unit)
}

const buildTimeline = (workers: TeamListItem[]): TimelineEvent[] =>
  workers
    .flatMap((agent) => {
      const events: TimelineEvent[] = []
      if (agent.lastDispatchedAt) {
        events.push({
          agent,
          detail: agent.currentTaskId
            ? `task ${agent.currentTaskId} dispatched`
            : 'task dispatched',
          kind: 'dispatch',
          timestamp: agent.lastDispatchedAt,
        })
      }
      if (agent.lastDeliveredAt) {
        events.push({
          agent,
          detail: 'dispatch delivered to terminal',
          kind: 'dispatch',
          timestamp: agent.lastDeliveredAt,
        })
      }
      if (agent.lastPtyOutputAt) {
        events.push({
          agent,
          detail: agent.lastPtyLine?.trim() || `${agent.status} runtime signal`,
          kind: 'output',
          timestamp: agent.lastPtyOutputAt,
        })
      }
      return events
    })
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 8)

const eventIcon = (kind: TimelineEvent['kind']) => {
  if (kind === 'output') return <Radio size={13} aria-hidden />
  if (kind === 'dispatch') return <ArrowUpRight size={13} aria-hidden />
  return <Activity size={13} aria-hidden />
}

export const TeamTimeline = ({
  onOpenWorker,
  workers,
}: {
  onOpenWorker: (worker: TeamListItem) => void
  workers: TeamListItem[]
}) => {
  const { language, t } = useI18n()
  const events = buildTimeline(workers)
  if (events.length === 0) return null

  return (
    <section
      aria-label={t('worker.teamMembers')}
      className="shrink-0 border-b border-border bg-bg-1 px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-accent/15 text-accent">
          <Activity size={13} aria-hidden />
        </span>
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-sec">
          {t('worker.teamMembers')}
        </h2>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
      </div>
      <ol className="grid gap-1.5">
        {events.map((event) => (
          <li key={`${event.agent.id}:${event.kind}:${event.timestamp}`}>
            <button
              type="button"
              onClick={() => onOpenWorker(event.agent)}
              className="group flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-sec transition-colors hover:bg-bg-3 hover:text-pri focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="mt-0.5 shrink-0 text-ter group-hover:text-accent">
                {eventIcon(event.kind)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-pri">{event.agent.name}</span> {event.detail}
              </span>
              <time
                className="shrink-0 font-mono text-[10px] text-ter"
                dateTime={new Date(event.timestamp).toISOString()}
              >
                {relativeTime(event.timestamp, language)}
              </time>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
