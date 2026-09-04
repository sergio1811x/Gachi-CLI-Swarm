import { BrainCircuit, Cpu, Eraser, Gauge, RefreshCw, RotateCcw, Scissors } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type AgentControlStateItem,
  fetchAgentControl,
  restartAgentControl,
  runAgentContextAction,
  setAgentReasoning,
} from '../api.js'
import { useI18n } from '../i18n.js'

/**
 * Control-plane dashboard for one worker (roadmap Wave 2.9, spec Part 2 §9):
 * live model / reasoning / context usage + the actions the engine's
 * capability registry actually supports. Unsupported controls stay hidden —
 * the backend 409s them anyway, but hiding beats an error toast.
 */

const POLL_MS = 10_000

interface AgentControlPanelProps {
  workspaceId: string
  agentId: string
}

export const AgentControlPanel = ({ workspaceId, agentId }: AgentControlPanelProps) => {
  const { t } = useI18n()
  const [state, setState] = useState<AgentControlStateItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchAgentControl(workspaceId, agentId)
      setState(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, agentId])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(interval)
  }, [load])

  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    void action()
      .then(load)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  if (!state) {
    return error ? (
      <div className="px-1 pb-2 text-red-300 text-xs" data-testid="agent-control-error">
        {error}
      </div>
    ) : null
  }

  const cap = state.capability
  if (!cap || !state.provider) return null

  const contextPct = state.context_percent
  const tokens = state.tokens_used

  return (
    <div
      className="agent-control-panel mb-3 flex flex-col rounded-xl border p-3 text-xs"
      style={{
        background: 'var(--bg-1)',
        borderColor: 'var(--border)',
        containerType: 'inline-size',
      }}
      data-testid="agent-control-panel"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 font-semibold text-pri">
          <Cpu size={13} aria-hidden /> {cap.display_name}
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-semibold"
          style={{
            background: state.running ? 'rgba(52,211,153,0.15)' : 'var(--bg-0)',
            color: state.running ? '#6ee7b7' : 'var(--text-secondary)',
          }}
        >
          {state.running ? t('common.running') : t('common.idle')}
        </span>
        <button
          type="button"
          className="ml-auto icon-btn px-1.5 py-0.5"
          disabled={busy}
          aria-label={t('agentControl.refreshAria')}
          onClick={() => void load()}
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} aria-hidden />
        </button>
      </div>

      {error ? <div className="mb-2 text-red-300">{error}</div> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Reasoning */}
        {cap.features.reasoning_control && cap.supported_reasoning_levels.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-ter text-[10px] uppercase tracking-wider">
              <BrainCircuit size={11} aria-hidden /> {t('agentControl.reasoning')}
            </span>
            <div className="flex gap-1">
              {cap.supported_reasoning_levels.map((level) => {
                const active = (state.reasoning_level ?? '').toLowerCase() === level.toLowerCase()
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        setAgentReasoning(
                          workspaceId,
                          agentId,
                          level.toLowerCase() as 'high' | 'low' | 'medium'
                        )
                      )
                    }
                    className="rounded px-2 py-1 text-[11px] font-semibold"
                    style={{
                      background: active ? 'var(--accent, #6366f1)' : 'var(--bg-0)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {level}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Context usage — hidden until telemetry is actually available */}
        {contextPct !== null ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-ter text-[10px] uppercase tracking-wider">
              <Gauge size={11} aria-hidden /> {t('agentControl.context')}
            </span>
            <div
              className="h-2 overflow-hidden rounded-full"
              style={{ background: 'var(--bg-0)' }}
              role="progressbar"
              aria-valuenow={Math.round(contextPct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.max(0, contextPct))}%`,
                  background:
                    contextPct >= 85 ? '#f87171' : contextPct >= 70 ? '#fbbf24' : '#34d399',
                }}
              />
            </div>
            <div className="text-ter text-[10px]">
              {t('agentControl.contextUsed', { percent: Math.round(contextPct) })}
              {tokens !== null
                ? ` · ${t('agentControl.tokensCount', { tokens: tokens.toLocaleString() })}`
                : ''}
            </div>
          </div>
        ) : null}
      </div>

      {/* Universal lifecycle actions (work for every engine) + context ops.
          ТЗ: fixed 28px buttons, 8px gap, no wrap-break, panel never gets
          squeezed into the terminal (shrink-0 on the card root). */}
      <div className="agent-toolbar">
        <button
          type="button"
          className="toolbar-btn"
          disabled={busy}
          title={t('agentControl.restartTitle')}
          onClick={() => run(() => restartAgentControl(workspaceId, agentId))}
        >
          <RotateCcw size={12} aria-hidden />
          <span className="btn-label">{t('agentControl.restart')}</span>
        </button>
        {cap.features.context_control ? (
          <>
            <span
              className="mx-1 h-4 w-px shrink-0"
              style={{ background: 'var(--border)' }}
              aria-hidden
            />
            {(['compact', 'clear'] as const).map((action) =>
              cap.context_commands[action] ? (
                <button
                  key={action}
                  type="button"
                  className="toolbar-btn"
                  disabled={busy || !state.running}
                  title={
                    !state.running
                      ? t('agentControl.notRunning')
                      : t('agentControl.sendContext', { command: cap.context_commands[action] })
                  }
                  onClick={() => run(() => runAgentContextAction(workspaceId, agentId, action))}
                >
                  {action === 'compact' ? (
                    <Scissors size={12} aria-hidden />
                  ) : (
                    <Eraser size={12} aria-hidden />
                  )}
                  <span className="btn-label">/{action}</span>
                </button>
              ) : null
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
