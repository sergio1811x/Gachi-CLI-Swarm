import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Bot, ChevronDown, Play, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { type CommandPreset, configureAgentLaunch } from '../api.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { AgentControlPanel } from './AgentControlPanel.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { useWorkerAvatar } from './catAvatars.js'
import { getRolePresentation } from './role-presentation.js'
import { useWorkerModalResize, WORKER_MODAL_MIN } from './useWorkerModalResize.js'
import { presentWorkerRuntimeStatus } from './worker-status.js'

type WorkerModalProps = {
  commandPresets?: CommandPreset[]
  onClose: () => void
  onStart: (worker: TeamListItem) => Promise<void>
  onStop: (worker: TeamListItem) => Promise<void>
  runId: string | null
  startError: string | null
  starting: boolean
  worker: TeamListItem
  workspaceId?: string
}

/**
 * Worker detail dialog — PTY view with quick CLI engine switching and control.
 */
export const WorkerModal = ({
  commandPresets = [],
  onClose,
  onStart,
  onStop,
  runId,
  startError,
  starting,
  worker,
  workspaceId,
}: WorkerModalProps) => {
  const { t } = useI18n()
  const role = getRolePresentation(worker.role)
  const ptyRunning = !!runId
  const status = presentWorkerRuntimeStatus(ptyRunning)
  const resize = useWorkerModalResize()
  const { filename: catAvatarFilename } = useWorkerAvatar(worker.id)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [currentPresetId, setCurrentPresetId] = useState(worker.commandPresetId ?? '')

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  const handleEngineChange = async (newPresetId: string) => {
    if (!workspaceId) return
    setSwitching(true)
    setSwitchError(null)
    try {
      await configureAgentLaunch(workspaceId, worker.id, {
        command_preset_id: newPresetId || null,
      })
      if (ptyRunning) await onStop(worker)
      setCurrentPresetId(newPresetId)
      await onStart(worker)
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="worker-modal-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center">
          <Dialog.Content
            data-testid="worker-modal"
            aria-label={t('worker.detail', { name: worker.name })}
            className="dialog-scale-pop pointer-events-auto relative flex h-screen max-h-screen max-w-full flex-col overflow-hidden"
            onEscapeKeyDown={(event) => event.preventDefault()}
            style={{
              background: 'var(--bg-1)',
              width: `${resize.width}px`,
            }}
          >
            {/* Header bar with identity & engine switcher */}
            <div
              className="flex items-center justify-between px-4 py-2.5 shrink-0 border-b gap-3"
              style={{
                background: 'var(--bg-0, #09090b)',
                borderColor: 'var(--border)',
              }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <CliAgentAvatar
                  commandPresetId={currentPresetId || worker.commandPresetId}
                  workerName={worker.name}
                  workerRole={worker.role}
                  size={26}
                  catAvatarFilename={catAvatarFilename}
                />
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-sm text-pri truncate">{worker.name}</span>
                  <span className="text-xs text-ter">({role.label})</span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${
                      ptyRunning
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                        : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
                    }`}
                  >
                    {status.label}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {workspaceId && (
                  <div
                    className="flex items-center gap-2 rounded-md shrink-0"
                    style={{
                      height: '32px',
                      padding: '0 12px',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-bright)',
                    }}
                  >
                    <Bot className="shrink-0 text-accent" style={{ width: 16, height: 16 }} />
                    <span className="text-[13px] font-medium text-sec">CLI:</span>
                    <select
                      value={currentPresetId}
                      disabled={switching}
                      onChange={(e) => void handleEngineChange(e.target.value)}
                      className="bg-transparent border-0 text-pri font-medium focus:outline-none cursor-pointer pr-1"
                      style={{ fontSize: '13px' }}
                    >
                      <option value="codex" style={{ background: 'var(--bg-1)' }}>
                        OpenAI Codex
                      </option>
                      <option value="agy" style={{ background: 'var(--bg-1)' }}>
                        Google AGY
                      </option>
                      <option value="claude" style={{ background: 'var(--bg-1)' }}>
                        Claude Code
                      </option>
                      <option value="opencode" style={{ background: 'var(--bg-1)' }}>
                        OpenCode
                      </option>
                      {commandPresets
                        .filter((p) => !['codex', 'agy', 'claude', 'opencode'].includes(p.id))
                        .map((p) => (
                          <option key={p.id} value={p.id} style={{ background: 'var(--bg-1)' }}>
                            {p.displayName}
                          </option>
                        ))}
                    </select>
                    <ChevronDown
                      className="text-ter shrink-0"
                      style={{ width: 14, height: 14 }}
                      aria-hidden
                    />
                    {switching && <RefreshCw className="w-3.5 h-3.5 text-accent animate-spin" />}
                  </div>
                )}

                <Tooltip label={t('common.close')}>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label={t('worker.closeAria')}
                      data-testid="worker-modal-close"
                      className="p-1.5 rounded-lg text-sec hover:text-pri hover:bg-hover transition-colors cursor-pointer"
                    >
                      <X size={15} aria-hidden />
                    </button>
                  </Dialog.Close>
                </Tooltip>
              </div>
            </div>
            {switchError ? (
              <div
                className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200"
                role="alert"
              >
                {switchError}
              </div>
            ) : null}

            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('worker.widthResize')}
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--left"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('left')}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('worker.widthResize')}
              aria-valuemin={WORKER_MODAL_MIN}
              aria-valuenow={Math.round(resize.width)}
              className="modal-resize-handle modal-resize-handle--right"
              tabIndex={-1}
              data-resizing={resize.resizing || undefined}
              onPointerDown={resize.beginResize('right')}
            />
            <Dialog.Title className="sr-only">{worker.name}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {role.label} agent — status {status.label}
            </Dialog.Description>

            {startError ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs"
                style={{
                  background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                  color: 'var(--status-red)',
                }}
              >
                <AlertTriangle size={12} aria-hidden />
                <span className="break-words">{startError}</span>
              </div>
            ) : null}

            <div
              className="relative flex min-h-0 flex-1 flex-col p-3"
              data-testid="worker-modal-terminal-slot"
            >
              {workspaceId ? (
                <AgentControlPanel workspaceId={workspaceId} agentId={worker.id} />
              ) : null}

              <div
                className="flex min-h-0 flex-1 rounded-lg border"
                style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
              >
                {ptyRunning ? (
                  <div
                    id={`worker-pty-${runId}`}
                    className="flex h-full w-full"
                    data-pty-slot="worker"
                  />
                ) : (
                  <div className="m-auto flex max-w-[400px] flex-col items-center gap-3 px-6 text-center">
                    <CliAgentAvatar
                      commandPresetId={worker.commandPresetId}
                      workerName={worker.name}
                      workerRole={worker.role}
                      size={48}
                      catAvatarFilename={catAvatarFilename}
                    />
                    <div className="text-sm text-pri">{worker.name}</div>
                    <div className="text-xs text-ter">
                      {worker.status === 'stopped'
                        ? t('worker.terminalStopped')
                        : t('worker.terminalNotStarted')}
                      {worker.pendingTaskCount > 0
                        ? t('worker.pendingResume', { count: worker.pendingTaskCount })
                        : t('worker.startAgent')}
                    </div>
                    <button
                      type="button"
                      onClick={() => onStart(worker)}
                      disabled={starting}
                      className="icon-btn icon-btn--primary"
                      data-testid="worker-start-empty"
                    >
                      <Play size={12} aria-hidden />{' '}
                      {starting ? t('common.starting') : t('common.start')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
