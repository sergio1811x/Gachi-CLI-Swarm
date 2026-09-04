import { Loader2, Pause, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { useWorkerAvatar } from './catAvatars.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

const statusColorByKind: Record<WorkerStatusKind, string> = {
  working: '#22c55e',
  waiting_decision: '#f59e0b',
  idle: '#fbbf24',
  stopped: '#ef4444',
}
const roleKey = (role: TeamListItem['role']) =>
  `role.${role}` as 'role.coder' | 'role.custom' | 'role.reviewer' | 'role.tester'
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'waiting_decision') return 'common.waiting_decision'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

/**
 * The card root opens the worker on click. Only clicks that started on the
 * card's own secondary controls — the hover action cluster and the task
 * link — must be excluded; everything else (identity button, avatar, name,
 * status, flags, padding) opens the worker. Guarding against *any* button
 * would swallow clicks on the row's own identity button, killing the
 * open-worker interaction entirely.
 */
const isRowControlTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-row-control]') !== null

export type WorkerCardActionKind =
  | 'start'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'reset'
  | 'rename'
  | 'delete'

type WorkerCardProps = {
  hasRun: boolean
  isPending?: boolean
  onAction?: (kind: WorkerCardActionKind, worker: TeamListItem) => void
  onClick: (worker: TeamListItem) => void
  onOpenTask?: ((taskId: string) => void) | undefined
  worker: TeamListItem
}

/**
 * Worker row — ТЗ v2 §3: one horizontal line per worker. Avatar (28px),
 * name · meta, colored status pinned right; the current task sits on a
 * second line indented under the avatar; actions live in reserved space
 * at the row end and appear only on hover/focus.
 */
const formatPresetBadge = (presetId: string | undefined): string | null => {
  if (!presetId) return null
  const clean = presetId.toLowerCase().trim()
  if (clean === 'codex') return 'CODEX'
  if (clean === 'agy') return 'AGY'
  if (clean === 'claude') return 'CLAUDE'
  if (clean === 'opencode') return 'OPENCODE'
  if (clean === 'gemini') return 'GEMINI'
  if (clean === 'qwen') return 'QWEN'
  if (clean.length > 10 || /^[0-9a-f-]{16,}$/i.test(clean)) return 'CUSTOM'
  return clean.toUpperCase()
}

export const WorkerCard = ({
  hasRun,
  isPending = false,
  onAction,
  onClick,
  onOpenTask,
  worker,
}: WorkerCardProps) => {
  const { t } = useI18n()
  const status = presentWorkerStatus(worker)
  const { filename: catAvatarFilename } = useWorkerAvatar(worker.id)
  const presetBadge = formatPresetBadge(worker.commandPresetId)

  const isStalled =
    worker.status === 'working' &&
    typeof worker.lastPtyOutputAt === 'number' &&
    Date.now() - worker.lastPtyOutputAt > 90_000

  // Orchestrator feedback #3: PTY silence ≠ idleness, and PTY chatter ≠ work.
  // The honest signal is file activity in the workspace.
  const artifactStallMinutes =
    worker.status === 'working' &&
    typeof worker.minutesSinceLastArtifact === 'number' &&
    worker.minutesSinceLastArtifact >= 10
      ? worker.minutesSinceLastArtifact
      : null

  const handleAction =
    (kind: WorkerCardActionKind): ((event: ReactMouseEvent<HTMLButtonElement>) => void) =>
    (event) => {
      event.stopPropagation()
      onAction?.(kind, worker)
    }

  const hasFailure = Boolean(worker.lastFailure)
  const showTaskLine = hasFailure || Boolean(worker.currentTaskId && worker.currentTaskTitle)

  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts nested controls; a native button would create button-in-button nesting
    <div
      className="worker-row"
      data-status={status.kind}
      data-worker-name={worker.name}
      data-testid={`worker-card-${worker.id}`}
      role="button"
      tabIndex={0}
      aria-label={t('worker.open', { name: worker.name })}
      onClick={(e) => {
        if (isRowControlTarget(e.target)) return
        onClick(worker)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onClick(worker)
      }}
    >
      {/* Top row: avatar · name · status */}
      <div className="worker-row__top" data-testid={`worker-card-body-${worker.id}`}>
        <span className="worker-row__avatar">
          <CliAgentAvatar
            commandPresetId={worker.commandPresetId}
            workerName={worker.name}
            workerRole={worker.role}
            size={24}
            statusRing="none"
            catAvatarFilename={catAvatarFilename}
          />
        </span>
        <span className="worker-row__name" title={worker.name}>
          {worker.name}
        </span>
        <span
          className="worker-row__status"
          role="status"
          title={t(statusKey(status.kind))}
          style={{ color: statusColorByKind[status.kind] }}
        >
          <span className={`worker-row__dot worker-row__dot--${status.kind}`} aria-hidden />
          {t(statusKey(status.kind))}
        </span>
      </div>

      {/* Meta line: role · preset · diagnostic flags */}
      <div className="worker-row__meta">
        <span className="truncate">{t(roleKey(worker?.role))}</span>
        {presetBadge && (
          <>
            <span aria-hidden>·</span>
            <span className="worker-row__meta-preset">{presetBadge}</span>
          </>
        )}
        {worker.rssMb != null && (
          <>
            <span aria-hidden>·</span>
            <span className="worker-row__meta-preset" title={t('worker.rssTitle')}>
              🧠{' '}
              {worker.rssMb >= 1024
                ? `${(worker.rssMb / 1024).toFixed(1)} GB`
                : `${Math.round(worker.rssMb)} MB`}
            </span>
          </>
        )}
        {(worker.paused || isStalled || artifactStallMinutes !== null) && (
          <span className="worker-row__flags">
            {worker.paused && (
              <span
                className="text-[9px] px-1 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 font-semibold shrink-0"
                title={t('worker.flagPausedTitle')}
              >
                <Pause size={9} aria-hidden /> {t('worker.flagPaused')}
              </span>
            )}
            {isStalled && (
              <span
                className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold shrink-0"
                title={t('worker.flagStalledTitle')}
              >
                ⚠️ {t('worker.flagStalled')}
              </span>
            )}
            {artifactStallMinutes !== null && (
              <span
                className="text-[9px] px-1 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 font-semibold shrink-0"
                title={t('worker.flagNoFilesTitle', { minutes: artifactStallMinutes })}
              >
                ⏱ {artifactStallMinutes}m
              </span>
            )}
          </span>
        )}
      </div>

      {/* Task line — always visible, no click needed */}
      {showTaskLine ? (
        hasFailure ? (
          <span
            className="worker-row__task worker-row__task--failure"
            title={worker.lastFailure ?? undefined}
          >
            ✗ {worker.lastFailure}
          </span>
        ) : worker.currentTaskId && onOpenTask ? (
          <button
            type="button"
            data-row-control
            onClick={() => {
              if (!worker.currentTaskId) return
              onOpenTask(worker.currentTaskId)
            }}
            className="worker-row__task"
            title={worker.currentTaskTitle ?? ''}
          >
            📝{' '}
            {worker.currentTaskStatus === 'review'
              ? t('worker.reviewTask', { title: worker.currentTaskTitle ?? '' })
              : t('worker.currentTask', { title: worker.currentTaskTitle ?? '' })}
          </button>
        ) : (
          <span className="worker-row__task" title={worker.currentTaskTitle ?? ''}>
            📝{' '}
            {worker.currentTaskStatus === 'review'
              ? t('worker.reviewTask', { title: worker.currentTaskTitle ?? '' })
              : t('worker.currentTask', { title: worker.currentTaskTitle ?? '' })}
          </span>
        )
      ) : null}

      {/* Hover actions — bottom row of the card */}
      {onAction ? (
        <div className="worker-row__actions" data-row-control>
          {hasRun ? (
            <>
              <CardActionBtn
                title={worker.paused ? t('worker.resumeTitle') : t('worker.pauseTitle')}
                onClick={handleAction('pause')}
                disabled={isPending}
                variant="warning"
                testId={`worker-card-pause-${worker.id}`}
                ariaLabel={worker.paused ? t('common.resume') : t('common.pause')}
              >
                {worker.paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
              </CardActionBtn>
              <CardActionBtn
                title={t('common.stop')}
                onClick={handleAction('stop')}
                disabled={isPending}
                variant="danger"
                testId={`worker-card-stop-${worker.id}`}
                ariaLabel={t('worker.stopAria', { name: worker.name })}
              >
                {isPending ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Square size={12} aria-hidden />
                )}
              </CardActionBtn>
              <CardActionBtn
                title={t('worker.resetTitle')}
                onClick={handleAction('reset')}
                disabled={isPending}
                testId={`worker-card-reset-${worker.id}`}
                ariaLabel={t('worker.resetAria')}
              >
                <RotateCcw size={12} aria-hidden />
              </CardActionBtn>
            </>
          ) : (
            <CardActionBtn
              title={t('common.start')}
              onClick={handleAction('start')}
              disabled={isPending}
              variant="success"
              testId={`worker-card-start-${worker.id}`}
              ariaLabel={t('worker.startAria', { name: worker.name })}
            >
              {isPending ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <Play size={12} aria-hidden />
              )}
            </CardActionBtn>
          )}
          <CardActionBtn
            title={t('worker.edit')}
            onClick={handleAction('rename')}
            disabled={isPending}
            testId={`worker-card-rename-${worker.id}`}
            ariaLabel={t('worker.editAria', { name: worker.name })}
          >
            <Pencil size={12} aria-hidden />
          </CardActionBtn>
          <CardActionBtn
            title={t('common.delete')}
            onClick={handleAction('delete')}
            variant="danger"
            testId={`worker-card-delete-${worker.id}`}
            ariaLabel={t('worker.deleteAria', { name: worker.name })}
          >
            <Trash2 size={12} aria-hidden />
          </CardActionBtn>
        </div>
      ) : null}
    </div>
  )
}

interface CardActionBtnProps {
  ariaLabel: string
  children: ReactNode
  disabled?: boolean
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  testId: string
  title: string
  variant?: 'default' | 'success' | 'warning' | 'danger'
}

const CardActionBtn = ({
  ariaLabel,
  children,
  disabled,
  onClick,
  testId,
  title,
  variant = 'default',
}: CardActionBtnProps) => (
  <Tooltip label={title}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      data-variant={variant}
      className="worker-row__action"
    >
      {children}
    </button>
  </Tooltip>
)
