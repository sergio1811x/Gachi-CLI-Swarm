import { Activity, Bot, ChevronDown, ChevronRight, Cpu, Gauge, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  type AgentControlSummary,
  fetchControlSummary,
  fetchWorkspaceMetrics,
  type WorkspaceMetricsItem,
} from '../api.js'
import { useI18n } from '../i18n.js'

/**
 * Swarm dashboard (roadmap Wave 2 / competitor parity with Vibe Kanban's
 * "active sessions" panel): one compact overview of every agent in the
 * workspace — engine, live status, model, context pressure and tokens —
 * plus the kanban task counters. Polls the bulk control-summary endpoint.
 * Collapsible: the collapsed state persists in localStorage.
 */

const POLL_MS = 10_000
const COLLAPSED_KEY = 'swarm.dashboard.collapsed'

const readCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const writeCollapsed = (value: boolean) => {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0')
  } catch {
    // Losing the preference only means the panel reopens expanded.
  }
}

const CONTEXT_BAR_COLORS = (pct: number) =>
  pct >= 85 ? '#f87171' : pct >= 70 ? '#fbbf24' : '#34d399'

const STATUS_DOT: Record<string, string> = {
  idle: '#6ee7b7',
  stopped: '#9ca3af',
  waiting_decision: '#fbbf24',
  working: '#60a5fa',
}

interface SwarmDashboardProps {
  workspaceId: string
  /** Opens the same edit dialog the team-member cards use. */
  onEditAgent?: (agentId: string) => void
}

export const SwarmDashboard = ({ workspaceId, onEditAgent }: SwarmDashboardProps) => {
  const { t } = useI18n()
  const [summary, setSummary] = useState<AgentControlSummary | null>(null)
  const [metrics, setMetrics] = useState<WorkspaceMetricsItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      writeCollapsed(!current)
      return !current
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSummary(await fetchControlSummary(workspaceId))
      // Metrics are best-effort: schema v25 may be fresh and samples empty.
      try {
        setMetrics(await fetchWorkspaceMetrics(workspaceId, 24))
      } catch {
        setMetrics(null)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(interval)
  }, [load])

  if (error && !summary) {
    return (
      <div className="px-1 pb-2 text-xs text-red-300" data-testid="swarm-dashboard-error">
        {error}
      </div>
    )
  }
  if (!summary) return null

  const runningCount = summary.agents.filter((a) => a.running).length
  const totalTokens = summary.agents.reduce((acc, a) => acc + (a.tokens_used ?? 0), 0)

  return (
    <div
      className="mb-3 rounded-xl border p-3 text-xs"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      data-testid="swarm-dashboard"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 font-semibold text-pri">
          <Bot size={13} aria-hidden /> Swarm
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-semibold"
          style={{ background: 'rgba(96,165,250,0.15)', color: '#93c5fd' }}
          data-testid="swarm-running-count"
        >
          {runningCount}/{summary.agents.length} running
        </span>
        {totalTokens > 0 ? (
          <span className="text-ter">{totalTokens.toLocaleString()} tokens total</span>
        ) : null}
        <button
          type="button"
          className="icon-btn ml-auto px-1.5 py-0.5"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('swarm.expandAria') : t('swarm.collapseAria')}
          title={collapsed ? t('swarm.expandAria') : t('swarm.collapseAria')}
          data-testid="swarm-collapse"
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden />
          ) : (
            <ChevronDown size={12} aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="icon-btn px-1.5 py-0.5"
          aria-label={t('swarm.refreshAria')}
          onClick={() => void load()}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden />
        </button>
      </div>

      {error ? <div className="mb-2 text-red-300">{error}</div> : null}

      {!collapsed ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {summary.agents.map((agent) => (
              <div
                key={agent.agent_id}
                className="rounded-lg border p-2"
                style={{ background: 'var(--bg-0)', borderColor: 'var(--border)' }}
                data-testid={`swarm-agent-${agent.name}`}
                title={`${agent.name}: ${agent.status}`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: STATUS_DOT[agent.status] ?? '#9ca3af' }}
                  />
                  <span className="truncate font-semibold text-pri">{agent.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-ter">
                    {agent.role}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1 truncate text-[10px] text-sec">
                  <Cpu size={10} className="shrink-0" aria-hidden />
                  {agent.capability?.display_name ?? agent.provider ?? 'unknown'}
                  {agent.model ? <span className="truncate">· {agent.model}</span> : null}
                </div>
                {agent.context_percent !== null ? (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Activity size={10} className="shrink-0 text-ter" aria-hidden />
                    <div
                      className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
                      style={{ background: 'var(--bg-2, var(--bg-0))' }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, agent.context_percent))}%`,
                          background: CONTEXT_BAR_COLORS(agent.context_percent),
                        }}
                      />
                    </div>
                    <span className="shrink-0 text-[10px] text-ter">
                      {Math.round(agent.context_percent)}%
                    </span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ter">
            {(
              [
                ['backlog', summary.tasks.backlog],
                ['ready', summary.tasks.ready],
                ['assigned', summary.tasks.assigned],
                ['running', summary.tasks.running],
                ['review', summary.tasks.review],
                ['done', summary.tasks.done],
                ['failed', summary.tasks.failed],
              ] as const
            ).map(([label, count]) => (
              <span key={label}>
                {label}: <span className="font-semibold text-sec">{count}</span>
              </span>
            ))}
          </div>

          {/* Metrics (ROADMAP R1): 24h aggregates from the durable usage log. */}
          {metrics ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[11px] text-ter"
              style={{ borderColor: 'var(--border)' }}
              data-testid="swarm-metrics"
            >
              <span className="flex items-center gap-1 font-semibold text-sec">
                <Gauge size={11} aria-hidden /> 24h
              </span>
              <span>
                tokens:{' '}
                <span className="font-semibold text-sec">
                  {metrics.tokens_total.toLocaleString()}
                </span>
              </span>
              {metrics.tasks.success_rate !== null ? (
                <span>
                  success:{' '}
                  <span
                    className="font-semibold"
                    style={{
                      color:
                        metrics.tasks.success_rate >= 90
                          ? '#34d399'
                          : metrics.tasks.success_rate >= 70
                            ? '#fbbf24'
                            : '#f87171',
                    }}
                  >
                    {metrics.tasks.success_rate}%
                  </span>
                </span>
              ) : null}
              {metrics.tasks.avg_task_duration_ms !== null ? (
                <span>
                  avg task:{' '}
                  <span className="font-semibold text-sec">
                    {Math.round(metrics.tasks.avg_task_duration_ms / 60_000)}m
                  </span>
                </span>
              ) : null}
              <span className="ml-auto text-[10px] opacity-70">
                done {metrics.tasks.done} · failed {metrics.tasks.failed}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
