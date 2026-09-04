import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { type OpenWorkspaceResult, openWorkspaceInEditor } from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import {
  getOpenTargetOption,
  getOpenTargetOptions,
  loadPersistedOpenTargetId,
  type OpenTargetId,
  persistOpenTargetId,
  resolveOpenTargetPlatform,
} from './open-targets.js'

interface OpenWorkspaceButtonProps {
  workspace: WorkspaceSummary | null | undefined
}

const ERROR_TOAST_KEY: Record<
  Exclude<OpenWorkspaceResult & { ok: false }, never>['errorCode'],
  TranslationKey
> = {
  'app-not-installed': 'openWorkspace.error.appNotInstalled',
  'command-not-in-path': 'openWorkspace.error.commandNotInPath',
  'invalid-path': 'openWorkspace.error.invalidPath',
  'invalid-target': 'openWorkspace.error.invalidTarget',
  unknown: 'openWorkspace.error.unknown',
}

export const OpenWorkspaceButton = ({ workspace }: OpenWorkspaceButtonProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const platform = useMemo(() => resolveOpenTargetPlatform(), [])
  const options = useMemo(() => getOpenTargetOptions(platform), [platform])
  const [selectedId, setSelectedId] = useState<OpenTargetId>(() =>
    loadPersistedOpenTargetId(platform)
  )
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mainButtonRef = useRef<HTMLButtonElement>(null)

  const selectedOption = useMemo(
    () => getOpenTargetOption(selectedId, platform),
    [platform, selectedId]
  )
  const selectedLabel = t(selectedOption.labelKey)

  useEffect(() => {
    if (!popoverOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    const handlePointer = (event: PointerEvent) => {
      const root = containerRef.current
      if (root && !root.contains(event.target as Node)) setPopoverOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handlePointer)
    }
  }, [popoverOpen])

  const handleSelect = useCallback((targetId: OpenTargetId) => {
    setSelectedId(targetId)
    persistOpenTargetId(targetId)
    setPopoverOpen(false)
    mainButtonRef.current?.focus()
  }, [])

  const handleOpen = useCallback(async () => {
    if (!workspace || isOpening) return
    setIsOpening(true)
    try {
      const result = await openWorkspaceInEditor(workspace.id, selectedId)
      if (!result.ok) {
        const labelKey = getOpenTargetOption(result.effectiveTargetId, platform).labelKey
        toast.show({
          kind: 'error',
          message: t(ERROR_TOAST_KEY[result.errorCode], { app: t(labelKey) }),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message })
    } finally {
      setIsOpening(false)
    }
  }, [isOpening, platform, selectedId, t, toast, workspace])

  const disabled = !workspace
  const disabledTooltip = t('openWorkspace.noWorkspace')
  const mainTooltip = workspace
    ? t('openWorkspace.openIn', { app: selectedLabel, workspace: workspace.name })
    : disabledTooltip

  const mainAriaLabel = workspace
    ? t('openWorkspace.openInAria', { app: selectedLabel, workspace: workspace.name })
    : disabledTooltip

  return (
    <div ref={containerRef} className="relative flex">
      <Tooltip label={mainTooltip}>
        <span className="flex">
          <button
            ref={mainButtonRef}
            type="button"
            aria-label={mainAriaLabel}
            data-testid="topbar-open-workspace"
            disabled={disabled || isOpening}
            onClick={() => void handleOpen()}
            className="flex h-7 items-center gap-1 rounded rounded-r-none border border-r-0 px-2 text-xs font-medium text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          >
            {isOpening ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden />
            ) : (
              <img
                src={selectedOption.iconSrc}
                alt=""
                aria-hidden
                style={{
                  width: 13,
                  height: 13,
                  objectFit: 'contain',
                  // CSS transform scales the rendered image without enlarging
                  // the layout box, so a scaled-up icon doesn't make this row
                  // taller than its neighbors.
                  transform: selectedOption.iconScale
                    ? `scale(${selectedOption.iconScale})`
                    : undefined,
                  transformOrigin: 'center',
                }}
              />
            )}
            <span>{t('openWorkspace.open')}</span>
          </button>
        </span>
      </Tooltip>
      <Tooltip label={t('openWorkspace.selectTarget')}>
        <button
          type="button"
          aria-label={t('openWorkspace.selectTarget')}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          data-testid="topbar-open-workspace-chevron"
          disabled={disabled}
          onClick={() => setPopoverOpen((value) => !value)}
          className="flex h-7 w-6 items-center justify-center rounded rounded-l-none border px-0 text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      </Tooltip>
      {popoverOpen ? (
        <div
          role="menu"
          aria-label={t('openWorkspace.selectTarget')}
          className="elev-2 absolute top-8 right-0 z-50 min-w-[180px] rounded border p-1"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          data-testid="topbar-open-workspace-menu"
        >
          {options.map((option) => {
            const isSelected = option.id === selectedId
            return (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={isSelected}
                type="button"
                onClick={() => handleSelect(option.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-pri hover:bg-3"
                style={isSelected ? { background: 'var(--bg-3)' } : undefined}
                data-testid={`topbar-open-workspace-option-${option.id}`}
              >
                <img
                  src={option.iconSrc}
                  alt=""
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    objectFit: 'contain',
                    transform: option.iconScale ? `scale(${option.iconScale})` : undefined,
                    transformOrigin: 'center',
                  }}
                />
                <span className="flex-1">{t(option.labelKey)}</span>
                {isSelected ? <Check size={14} className="text-ter" aria-hidden /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
