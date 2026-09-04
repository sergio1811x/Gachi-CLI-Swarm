import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type AgentDiscoveryItem,
  type AgentDiscoveryReport,
  fetchAgentDiscovery,
  rescanAgentDiscovery,
} from '../api.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'

/**
 * AI environment micro-chips pinned to the global topbar (ТЗ §3): one 22px
 * chip per discovered coding CLI — status dot + name. Hover shows the full
 * identity (path, version, auth, scanned time); click opens an anchored
 * dropdown with details and a per-panel rescan button. The ↻ glyph next to
 * the last chip rescans everything (chips dim while scanning). Polls the
 * TTL-cached discovery endpoint once a minute.
 */

const dotTone = (agent: AgentDiscoveryItem): 'ok' | 'warn' | 'off' => {
  if (!agent.installed) return 'off'
  return agent.authenticated ? 'ok' : 'warn'
}

const authState = (agent: AgentDiscoveryItem): string => {
  if (!agent.installed) return 'not installed'
  return agent.authenticated ? `auth: ${agent.auth_method ?? 'yes'}` : 'no auth'
}

export const AiEnvironmentPanel = () => {
  const { t } = useI18n()
  const [report, setReport] = useState<AgentDiscoveryReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback((force: boolean) => {
    setBusy(true)
    void (force ? rescanAgentDiscovery() : fetchAgentDiscovery())
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setBusy(false))
  }, [])

  useEffect(() => {
    load(false)
    const interval = setInterval(() => load(false), 60_000)
    return () => clearInterval(interval)
  }, [load])

  // Close the details dropdown on Escape / click outside, matching the
  // header-menu pattern used across the shell.
  useEffect(() => {
    if (expanded === null) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null)
    }
    const handlePointer = (event: PointerEvent) => {
      const root = document.querySelector('.env-chips')
      if (root && !root.contains(event.target as Node)) setExpanded(null)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handlePointer)
    }
  }, [expanded])

  const agents = report?.agents ?? null
  if (agents === null) return null

  const scannedLabel = report
    ? new Date(report.scanned_at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <div className="env-chips env-chips--compact" data-busy={busy}>
      <span className="sr-only">{t('env.title')}</span>
      {agents.map((agent) => {
        const isExpanded = expanded === agent.name
        const tooltipLabel = `${agent.path ?? agent.name}${
          agent.version ? ` · v${agent.version}` : ''
        } · ${authState(agent)}${scannedLabel ? ` · ${scannedLabel}` : ''}`
        return (
          <Tooltip key={agent.name} label={tooltipLabel}>
            <button
              type="button"
              className="env-chip"
              aria-expanded={isExpanded}
              onClick={() => setExpanded(isExpanded ? null : agent.name)}
            >
              <span className={`env-chip__dot env-dot--${dotTone(agent)}`} aria-hidden />
              <span className="env-chip__name">{agent.name}</span>
            </button>
          </Tooltip>
        )
      })}
      {(() => {
        const agent = agents.find((item) => item.name === expanded)
        if (!agent) return null
        return (
          <span className="env-chip__details" role="dialog" aria-label={agent.name}>
            <span className="env-chip__details-title">
              {agent.name}
              {agent.version ? ` · v${agent.version}` : ''}
            </span>
            <span>{agent.path ?? 'path: —'}</span>
            <span>{authState(agent)}</span>
            {agent.auth_error ? <span>error: {agent.auth_error}</span> : null}
            {agent.models.length > 0 ? (
              <span>
                models:{' '}
                {agent.models
                  .slice(0, 4)
                  .map((model) => model.id)
                  .join(', ')}
                {agent.models.length > 4 ? ` +${agent.models.length - 4}` : ''}
              </span>
            ) : null}
            {scannedLabel ? <span>scanned: {scannedLabel}</span> : null}
            <button
              type="button"
              className="env-refresh"
              disabled={busy}
              onClick={() => load(true)}
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} aria-hidden />
              {t('common.retry')}
            </button>
          </span>
        )
      })()}
      <button
        type="button"
        className="env-refresh"
        disabled={busy}
        aria-label={t('env.refresh')}
        onClick={() => load(true)}
      >
        <RefreshCw size={16} className={busy ? 'animate-spin' : ''} aria-hidden />
      </button>
    </div>
  )
}
