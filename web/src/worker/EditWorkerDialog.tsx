import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, ChevronRight, Settings2, Shuffle } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { CommandPreset } from '../api.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { WorkspaceCommandPresetSelect } from '../workspace/WorkspaceCommandPresetSelect.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { useWorkerAvatar } from './catAvatars.js'

export type EditWorkerInput = {
  name: string
  description: string
  commandPresetId: string
  startupCommand: string
}

type EditWorkerDialogProps = {
  busy: boolean
  commandPresetError: string | null
  commandPresets: CommandPreset[]
  onClose: () => void
  onSubmit: (input: EditWorkerInput) => void
  worker: TeamListItem | null
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-xs font-medium uppercase tracking-wider text-ter">{children}</span>
)

const isShellWrapper = (command: string) => {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    base === 'cmd' ||
    base === 'cmd.exe' ||
    base === 'sh' ||
    base === 'bash' ||
    base === 'zsh' ||
    base === 'ksh' ||
    base === 'dash' ||
    base === 'fish' ||
    base === 'pwsh' ||
    base === 'powershell' ||
    base === 'powershell.exe'
  )
}

const reconstructStartupCommand = (
  command: string | undefined,
  args: string[] | undefined
): string => {
  if (!command) return ''
  if (isShellWrapper(command) && args && args.length > 0) {
    return args[args.length - 1] ?? ''
  }
  return [command, ...(args ?? [])].join(' ')
}

export const EditWorkerDialog = ({
  busy,
  commandPresetError,
  commandPresets,
  onClose,
  onSubmit,
  worker,
}: EditWorkerDialogProps) => {
  const { t } = useI18n()
  const [name, setName] = useState(worker?.name ?? '')
  const [description, setDescription] = useState(worker?.description ?? '')
  const initialPreset = worker?.commandPresetId ?? ''
  const initialStartup = worker
    ? worker.commandPresetId
      ? ''
      : reconstructStartupCommand(worker.command, worker.args)
    : ''
  const [commandPresetId, setCommandPresetId] = useState(initialPreset)
  const [startupExpanded, setStartupExpanded] = useState(false)
  const [startupCommand, setStartupCommand] = useState(initialStartup)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const { filename: catAvatarFilename, randomize: randomizeAvatar } = useWorkerAvatar(
    worker?.id ?? ''
  )

  useEffect(() => {
    if (!worker) return
    setName(worker.name)
    setDescription(worker.description ?? '')
    setCommandPresetId(worker.commandPresetId ?? '')
    setStartupCommand(
      worker.commandPresetId ? '' : reconstructStartupCommand(worker.command, worker.args)
    )
    const id = window.setTimeout(() => {
      nameRef.current?.select()
    }, 30)
    return () => window.clearTimeout(id)
  }, [worker])

  if (!worker) return null

  const trimmedName = name.trim()
  const startupClean = startupCommand.trim()
  const cliDirty = commandPresetId !== initialPreset || startupClean !== initialStartup
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const genericPresetNeedsStartup = !commandPresetId && startupClean.length === 0
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const availabilityError = genericPresetNeedsStartup
    ? t('workspace.preset.genericRequiresStartup')
    : selectedPresetUnavailable
      ? t('workspace.preset.notInstalled', { name: selectedPreset.displayName })
      : null
  const canSave =
    !busy &&
    trimmedName.length > 0 &&
    (!cliDirty || (!genericPresetNeedsStartup && !selectedPresetUnavailable))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onSubmit({
      name: trimmedName,
      description: description.trim(),
      commandPresetId,
      startupCommand: startupClean,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="edit-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="edit-worker-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[560px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <form onSubmit={handleSubmit} className="flex max-h-[85vh] flex-col">
              <div
                className="flex items-start gap-3 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                    color: 'var(--accent)',
                    border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                  }}
                >
                  <Settings2 size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {t('worker.editTitle', { name: worker.name })}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-ter">
                    {t('worker.editDesc')}
                  </Dialog.Description>
                </div>
                <Tooltip label={t('worker.avatarShuffle')}>
                  <button
                    type="button"
                    onClick={randomizeAvatar}
                    aria-label={t('worker.avatarShuffleAria', { name: worker.name })}
                    data-testid="edit-worker-avatar-shuffle"
                    className="relative shrink-0 rounded-full"
                  >
                    <CliAgentAvatar
                      commandPresetId={worker.commandPresetId}
                      workerName={worker.name}
                      workerRole={worker.role}
                      size={32}
                      catAvatarFilename={catAvatarFilename}
                    />
                    <span
                      aria-hidden
                      className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full"
                      style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-bright)',
                      }}
                    >
                      <Shuffle size={9} />
                    </span>
                  </button>
                </Tooltip>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
                <label className="flex flex-col gap-2">
                  <FieldLabel>{t('addWorker.name')}</FieldLabel>
                  <input
                    ref={nameRef}
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={64}
                    className="input"
                    data-testid="edit-worker-name"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <FieldLabel>{t('addWorker.roleInstructions')}</FieldLabel>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={8}
                    className="input mono resize-y"
                    data-testid="edit-worker-description"
                  />
                </label>

                <WorkspaceCommandPresetSelect
                  error={commandPresetError ?? availabilityError}
                  label={t('addWorker.agentCli')}
                  onChange={setCommandPresetId}
                  presets={commandPresets}
                  value={commandPresetId}
                />

                <button
                  type="button"
                  onClick={() => setStartupExpanded((value) => !value)}
                  className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter hover:text-sec"
                  data-testid="edit-worker-startup-toggle"
                >
                  {startupExpanded ? (
                    <ChevronDown size={12} aria-hidden />
                  ) : (
                    <ChevronRight size={12} aria-hidden />
                  )}
                  {t('workspace.advanced.startup')}
                </button>
                {startupExpanded ? (
                  <label className="flex flex-col gap-2">
                    <FieldLabel>{t('workspace.field.startup')}</FieldLabel>
                    <input
                      type="text"
                      value={startupCommand}
                      onChange={(event) => setStartupCommand(event.target.value)}
                      placeholder={t('workspace.field.startupPlaceholder')}
                      className="input mono"
                      data-testid="edit-worker-startup-command"
                    />
                    <span className="text-xs text-ter">{t('workspace.startup.hint')}</span>
                  </label>
                ) : null}
              </div>

              <div
                className="flex items-center justify-end gap-2 border-t px-5 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <button type="button" onClick={onClose} className="icon-btn" disabled={busy}>
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!canSave}
                  className="icon-btn icon-btn--primary"
                  data-testid="edit-worker-save"
                >
                  {busy ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
