import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, FolderSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  type CommandPreset,
  type FsProbeResponse,
  listCommandPresets,
  probeFs,
  resolveFolder,
} from '../api.js'
import { useI18n } from '../i18n.js'
import { ConfirmWorkspaceDialog } from './ConfirmWorkspaceDialog.js'
import { ServerBrowseDialog } from './ServerBrowseDialog.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

type AddWorkspaceDialogProps = {
  /**
   * Discriminator: `idle` = dialog closed; `request-pick` = parent asked us to
   * open a new flow, we should fire the native folder picker on mount.
   */
  trigger: number
  onClose: () => void
  onCreate: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'resolving' }
  | { kind: 'candidates'; name: string; matches: string[] }
  | { kind: 'confirm'; probe: FsProbeResponse | null; pasteDefault: boolean }
  | { kind: 'browse' }
  | { kind: 'error'; message: string; title?: string }

const DEFAULT_COMMAND_PRESET_ID = 'claude'

const chooseDefaultCommandPresetId = (presets: CommandPreset[]) =>
  presets.some((preset) => preset.id === DEFAULT_COMMAND_PRESET_ID && preset.available)
    ? DEFAULT_COMMAND_PRESET_ID
    : (presets.find((preset) => preset.available)?.id ??
      presets[0]?.id ??
      DEFAULT_COMMAND_PRESET_ID)

/**
 * The browser's native file input with `webkitdirectory` opens the OS's own
 * modern folder picker on every platform. The browser only exposes the chosen
 * folder's basename (via `webkitRelativePath`), so we ask the server to resolve
 * that name back to a real path inside the browse root.
 */
const folderNameFromFiles = (files: FileList | null): string | null => {
  if (!files || files.length === 0) return null
  const first = files[0]
  const relative = first.webkitRelativePath ?? ''
  const firstSegment = relative.split('/')[0]
  return firstSegment && firstSegment.length > 0 ? firstSegment : null
}

export const AddWorkspaceDialog = ({ trigger, onClose, onCreate }: AddWorkspaceDialogProps) => {
  const { t } = useI18n()
  // Effect-stable view of `t`: writing to a ref lets the trigger-driven
  // useEffect read the current translator without re-running each render
  // (which would re-fire the native folder picker every time language changes).
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState(DEFAULT_COMMAND_PRESET_ID)
  const [commandPresetError, setCommandPresetError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const commandPresetSnapshotRef = useRef<{
    error: string | null
    id: string
    presets: CommandPreset[]
  }>({ error: null, id: DEFAULT_COMMAND_PRESET_ID, presets: [] })
  // Keep the latest onClose in a ref so the pick effect can depend only on
  // `trigger`. If we listed onClose in the deps array, a fresh inline lambda
  // from the parent (which is the normal React pattern) would re-fire the
  // native picker every render — including after a successful create.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Fire the native picker on mount, then resolve the chosen folder.
  useEffect(() => {
    if (trigger === 0) return
    setCommandPresetError(null)
    void listCommandPresets()
      .then((presets) => {
        const nextId = presets.some(
          (preset) => preset.id === commandPresetSnapshotRef.current.id && preset.available
        )
          ? commandPresetSnapshotRef.current.id
          : chooseDefaultCommandPresetId(presets)
        commandPresetSnapshotRef.current = { error: null, id: nextId, presets }
        setCommandPresets(presets)
        setCommandPresetId(nextId)
      })
      .catch(() => {
        const errorMessage = tRef.current('workspace.preset.loadFailed')
        commandPresetSnapshotRef.current = {
          error: errorMessage,
          id: DEFAULT_COMMAND_PRESET_ID,
          presets: [],
        }
        setCommandPresets([])
        setCommandPresetId(DEFAULT_COMMAND_PRESET_ID)
        setCommandPresetError(errorMessage)
      })
    setStage({ kind: 'picking' })
    // Defer the click so the input is mounted and focusable; browsers allow
    // programmatic .click() on file inputs, opening the OS folder dialog.
    const frame = requestAnimationFrame(() => inputRef.current?.click())
    return () => cancelAnimationFrame(frame)
  }, [trigger])

  const handlePick = async (files: FileList | null) => {
    const name = folderNameFromFiles(files)
    if (!name) {
      // User canceled the native dialog — dismiss silently.
      setStage({ kind: 'idle' })
      onCloseRef.current()
      return
    }
    setStage({ kind: 'resolving' })
    try {
      const result = await resolveFolder(name)
      if (result.path) {
        const probe = await probeFs(result.path)
        if (probe.ok && probe.is_dir) {
          setStage({ kind: 'confirm', probe, pasteDefault: false })
          return
        }
        setStage({
          kind: 'error',
          message: tRef.current('workspace.error.outsideSandbox'),
        })
        return
      }
      if (result.matches.length > 0) {
        setStage({ kind: 'candidates', name, matches: result.matches })
        return
      }
      setStage({
        kind: 'error',
        message: result.error ?? tRef.current('workspace.error.pickerFailed'),
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : tRef.current('workspace.error.pickerFailed')
      setStage({ kind: 'error', message })
    }
  }

  const handleCancel = () => {
    setStage({ kind: 'idle' })
    onClose()
  }

  const handleCreate = (input: WorkspaceCreateInput) => {
    void Promise.resolve(onCreate(input))
      .then(() => setStage({ kind: 'idle' }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t('workspace.error.createFailed')
        setStage({ kind: 'error', title: t('workspace.error.createTitle'), message })
      })
  }

  const handleCommandPresetChange = (value: string) => {
    commandPresetSnapshotRef.current = { ...commandPresetSnapshotRef.current, id: value }
    setCommandPresetId(value)
  }

  const renderedCommandPresets =
    commandPresets.length > 0 || commandPresetError
      ? commandPresets
      : commandPresetSnapshotRef.current.presets
  const renderedCommandPresetId =
    commandPresetId === ''
      ? ''
      : renderedCommandPresets.length > 0 &&
          !renderedCommandPresets.some(
            (preset) => preset.id === commandPresetId && preset.available
          )
        ? commandPresetSnapshotRef.current.id
        : commandPresetId
  const renderedCommandPresetError = commandPresetError ?? commandPresetSnapshotRef.current.error

  if (stage.kind === 'idle') return null
  if (stage.kind === 'picking' || stage.kind === 'resolving') {
    // Programmatic file-input clicks lose the user gesture (rAF) and are
    // blocked outright in some embedders — a bare "opening…" overlay would
    // dead-end. Offer explicit paths: retry the native picker or paste path.
    return (
      <Dialog.Root open onOpenChange={(next) => !next && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <Dialog.Content
            data-testid="add-workspace-picking"
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            <Dialog.Title className="sr-only">{t('workspace.picking.title')}</Dialog.Title>
            <div
              data-testid="add-workspace-picking-panel"
              className="dialog-scale-pop elev-2 flex flex-col items-center gap-3 rounded-lg border px-6 py-5"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
            >
              <div className="flex items-center gap-3">
                <FolderSearch
                  size={18}
                  aria-hidden
                  className={stage.kind === 'picking' ? 'animate-pulse' : ''}
                  style={{ color: 'var(--accent)' }}
                />
                <span className="text-sm text-pri">{t('workspace.picking.message')}</span>
              </div>
              {stage.kind === 'picking' ? (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="add-workspace-paste-fallback"
                    onClick={() => setStage({ kind: 'confirm', probe: null, pasteDefault: true })}
                    className="icon-btn icon-btn--primary rounded px-3 py-1.5 text-xs"
                  >
                    {t('workspace.picker.pasteInstead')}
                  </button>
                  <button
                    type="button"
                    data-testid="add-workspace-picker-retry"
                    onClick={() => inputRef.current?.click()}
                    className="icon-btn rounded px-3 py-1.5 text-xs"
                  >
                    {t('workspace.picker.openNative')}
                  </button>
                </div>
              ) : null}
            </div>
            <input
              ref={inputRef}
              type="file"
              webkitdirectory=""
              data-testid="add-workspace-native-input"
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => void handlePick(event.target.files)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'candidates') {
    return (
      <Dialog.Root open onOpenChange={(next) => !next && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
            <Dialog.Content
              data-testid="add-workspace-candidates"
              className="dialog-scale-pop elev-2 pointer-events-auto w-[460px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
            >
              <Dialog.Title className="text-lg font-semibold text-pri">
                {t('workspace.candidates.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-ter">
                {t('workspace.candidates.description', { name: stage.name })}
              </Dialog.Description>
              <ul className="scroll-y mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
                {stage.matches.map((match) => (
                  <li key={match}>
                    <button
                      type="button"
                      data-testid="add-workspace-candidate"
                      onClick={() => {
                        void probeFs(match).then((probe) => {
                          if (probe.ok && probe.is_dir) {
                            setStage({ kind: 'confirm', probe, pasteDefault: false })
                          } else {
                            setStage({
                              kind: 'error',
                              message: t('workspace.error.outsideSandbox'),
                            })
                          }
                        })
                      }}
                      className="w-full truncate rounded border px-3 py-2 text-left text-xs text-pri hover:bg-3"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {match}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={handleCancel} className="icon-btn">
                  {t('common.cancel')}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'error') {
    return (
      <Dialog.Root open onOpenChange={(open) => !open && handleCancel()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
            <Dialog.Content
              data-testid="add-workspace-error"
              className="dialog-scale-pop elev-2 pointer-events-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                  style={{
                    background: 'color-mix(in oklab, var(--status-red) 14%, transparent)',
                    color: 'var(--status-red)',
                  }}
                >
                  <AlertTriangle size={18} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {stage.title ?? t('workspace.error.pickerFailed')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-1.5 break-words text-sm text-ter">
                    {stage.message}
                  </Dialog.Description>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={handleCancel} className="icon-btn">
                  {t('common.close')}
                </button>
                <button
                  type="button"
                  onClick={() => setStage({ kind: 'confirm', probe: null, pasteDefault: true })}
                  className="icon-btn icon-btn--primary"
                >
                  {t('workspace.error.pastePathInstead')}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (stage.kind === 'browse') {
    return (
      <ServerBrowseDialog
        commandPresetError={renderedCommandPresetError}
        commandPresetId={renderedCommandPresetId}
        commandPresets={renderedCommandPresets}
        onClose={handleCancel}
        onCommandPresetChange={handleCommandPresetChange}
        onCreate={handleCreate}
        open
      />
    )
  }
  return (
    <ConfirmWorkspaceDialog
      commandPresetError={renderedCommandPresetError}
      commandPresetId={renderedCommandPresetId}
      commandPresets={renderedCommandPresets}
      pasteFallbackDefault={stage.pasteDefault}
      probe={stage.probe}
      onCancel={handleCancel}
      onCommandPresetChange={handleCommandPresetChange}
      onCreate={handleCreate}
      onOpenServerBrowse={() => setStage({ kind: 'browse' })}
    />
  )
}
