import { Copy, Crown, LoaderCircle, Play, RotateCcw, Settings, Square } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../i18n.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  onStop: () => void
  onRemoveWorkspace: () => void
  onStart: () => void
  onRestart: () => void
  /** When provided, renders a header button that opens the Orchestrator CLI dialog. */
  onConfigure?: () => void
}

const StartingBody = () => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-starting-body" className="flex flex-1">
      <EmptyState
        icon={<LoaderCircle size={24} className="animate-spin" />}
        title={t('orchestrator.startingTitle')}
        description={t('orchestrator.startingDesc')}
      />
    </div>
  )
}

const StoppedBody = ({ onStart }: { onStart: () => void }) => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-stopped-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={30} />}
        title={t('orchestrator.stoppedTitle')}
        description={t('orchestrator.stoppedDesc')}
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> {t('orchestrator.start')}
          </button>
        }
      />
    </div>
  )
}

const FailedBody = ({
  error,
  onRemoveWorkspace,
  onRestart,
  onConfigure,
}: {
  error: string
  onRemoveWorkspace: () => void
  onRestart: () => void
  onConfigure?: () => void
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copyError = () => {
    void navigator.clipboard
      ?.writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div
      data-testid="orchestrator-failed-body"
      className="m-auto flex max-w-[480px] flex-col items-center gap-3 px-6 py-8"
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded text-sec"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
      >
        <Crown size={24} />
      </div>
      <div className="text-lg font-semibold text-pri">{t('orchestrator.failed')}</div>
      <div className="relative w-full">
        <pre
          data-testid="orchestrator-error-message"
          className="mono w-full max-h-40 overflow-auto whitespace-pre-wrap break-all rounded p-3 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--status-red) 24%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {error}
        </pre>
        <Tooltip label={copied ? t('common.copied') : t('common.copyError')}>
          <button
            type="button"
            onClick={copyError}
            aria-label={t('orchestrator.copyErrorAria')}
            className="icon-btn icon-btn--ghost absolute right-1 top-1 h-6 px-1.5"
            data-testid="orchestrator-copy-error"
          >
            <Copy size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-retry"
        >
          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
        </button>
        <button
          type="button"
          onClick={onRemoveWorkspace}
          className="icon-btn icon-btn--danger"
          data-testid="orchestrator-remove-workspace"
        >
          {t('orchestrator.removeWorkspace')}
        </button>
        {onConfigure ? (
          <button
            type="button"
            onClick={onConfigure}
            className="icon-btn"
            data-testid="orchestrator-failed-configure"
          >
            <Settings size={12} aria-hidden /> {t('orchestrator.config.openAria')}
          </button>
        ) : null}
      </div>
      {/* Header retry was a duplicate; alias kept for back-compat. */}
      <span data-testid="orchestrator-retry-header" className="sr-only">
        {t('common.retry')}
      </span>
    </div>
  )
}

export const OrchestratorPane = ({
  state,
  onRemoveWorkspace,
  onRestart,
  onStart,
  onStop,
  onConfigure,
}: OrchestratorPaneProps) => {
  const { t } = useI18n()
  const showHeader = Boolean(onConfigure) || state.kind === 'running'
  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      style={{
        background: 'var(--bg-crust)',
        borderRight: '1px solid var(--border)',
      }}
      data-testid="orchestrator-terminal-slot"
    >
      {showHeader ? (
        <div
          className="flex shrink-0 items-center gap-2 px-3 py-1.5"
          style={{ boxShadow: 'inset 0 -1px 0 var(--border)' }}
        >
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ter">
            <Crown size={12} aria-hidden /> {t('orchestrator.config.title')}
          </span>
          <div className="flex-1" />
          {state.kind === 'running' ? (
            <Tooltip label={t('orchestrator.stopAria')}>
              <button
                type="button"
                onClick={onStop}
                className="icon-btn icon-btn--danger h-6 gap-1 px-1.5"
                aria-label={t('orchestrator.stopAria')}
                data-testid="orchestrator-stop"
              >
                <Square size={11} aria-hidden /> {t('orchestrator.stop')}
              </button>
            </Tooltip>
          ) : null}
          {onConfigure ? (
            <button
              type="button"
              onClick={onConfigure}
              className="icon-btn icon-btn--ghost h-6 px-1.5"
              aria-label={t('orchestrator.config.openAria')}
              data-testid="orchestrator-configure"
            >
              <Settings size={12} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'running' ? (
        <div
          id={`orch-pty-${state.runId}`}
          className="flex min-h-0 w-full flex-1"
          data-pty-slot="orchestrator"
        />
      ) : state.kind === 'failed' ? (
        <FailedBody
          error={state.error}
          onRemoveWorkspace={onRemoveWorkspace}
          onRestart={onRestart}
          {...(onConfigure ? { onConfigure } : {})}
        />
      ) : state.kind === 'stopped' ? (
        <StoppedBody onStart={onStart} />
      ) : (
        <StartingBody />
      )}
    </div>
  )
}
