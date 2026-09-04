import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, Clock, Crown, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { type CommandPreset, getHeartbeatIntervalMs, saveHeartbeatIntervalMs } from '../api.js'
import { useI18n } from '../i18n.js'
import { useToast } from '../ui/useToast.js'
import { WorkspaceCommandPresetSelect } from '../workspace/WorkspaceCommandPresetSelect.js'

const HEARTBEAT_DISABLED_VALUE = 0
const HEARTBEAT_INTERVAL_OPTIONS_MS = [
  HEARTBEAT_DISABLED_VALUE,
  180_000,
  300_000,
  600_000,
  1_800_000,
] as const
const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000

export type OrchestratorConfigInput = {
  command_preset_id: string | null
  startup_command?: string
}

type OrchestratorConfigDialogProps = {
  commandPresetError: string | null
  commandPresets: CommandPreset[]
  onCancel: () => void
  onSave: (input: OrchestratorConfigInput) => void
  saving: boolean
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-xs font-medium uppercase tracking-wider text-ter">{children}</span>
)

export const OrchestratorConfigDialog = ({
  commandPresetError,
  commandPresets,
  onCancel,
  onSave,
  saving,
}: OrchestratorConfigDialogProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [commandPresetId, setCommandPresetId] = useState('')
  const [startupCommand, setStartupCommand] = useState('')
  const [heartbeatIntervalMs, setHeartbeatIntervalMs] = useState(DEFAULT_HEARTBEAT_INTERVAL_MS)

  useEffect(() => {
    getHeartbeatIntervalMs()
      .then((value) => setHeartbeatIntervalMs(value ?? DEFAULT_HEARTBEAT_INTERVAL_MS))
      .catch(() => undefined)
  }, [])

  const handleHeartbeatIntervalChange = (value: number) => {
    setHeartbeatIntervalMs(value)
    void saveHeartbeatIntervalMs(value)
      .then(() => toast.show({ kind: 'success', message: t('orchestrator.heartbeat.saved') }))
      .catch(() => toast.show({ kind: 'error', message: t('orchestrator.heartbeat.saveFailed') }))
  }

  const formatIntervalOption = (ms: number) =>
    ms === HEARTBEAT_DISABLED_VALUE
      ? t('orchestrator.heartbeat.disabled')
      : t('orchestrator.heartbeat.minutes', { n: String(ms / 60_000) })

  const startupClean = startupCommand.trim()
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const genericPresetNeedsStartup = !commandPresetId && startupClean.length === 0
  const selectedPresetUnavailable = selectedPreset?.available === false && startupClean.length === 0
  const availabilityError = genericPresetNeedsStartup
    ? t('workspace.preset.genericRequiresStartup')
    : selectedPresetUnavailable
      ? t('workspace.preset.notInstalled', { name: selectedPreset.displayName })
      : null
  const canSave = !saving && !genericPresetNeedsStartup && !selectedPresetUnavailable

  const handleSave = () => {
    if (!canSave) return
    onSave({
      command_preset_id: commandPresetId || null,
      ...(startupClean ? { startup_command: startupClean } : {}),
    })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="orchestrator-config-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="orchestrator-config-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto flex w-[480px] max-w-full flex-col rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <div
              className="flex items-center gap-3 border-b px-5 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Crown size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('orchestrator.config.title')}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ter">
                  {t('orchestrator.config.description')}
                </Dialog.Description>
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-4">
              <WorkspaceCommandPresetSelect
                error={commandPresetError ?? availabilityError}
                onChange={setCommandPresetId}
                presets={commandPresets}
                value={commandPresetId}
              />

              <label className="flex flex-col gap-2">
                <FieldLabel>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock size={12} aria-hidden />
                    {t('orchestrator.heartbeat.label')}
                  </span>
                </FieldLabel>
                <select
                  value={heartbeatIntervalMs}
                  onChange={(event) => handleHeartbeatIntervalChange(Number(event.target.value))}
                  className="input"
                  data-testid="orchestrator-config-heartbeat-interval"
                >
                  {HEARTBEAT_INTERVAL_OPTIONS_MS.map((ms) => (
                    <option key={ms} value={ms}>
                      {formatIntervalOption(ms)}
                    </option>
                  ))}
                </select>
              </label>

              <span className="flex items-center gap-1.5 self-start text-xs uppercase tracking-wider text-ter">
                <ChevronDown size={12} aria-hidden />
                {t('workspace.advanced.startup')}
              </span>
              <label className="flex flex-col gap-2">
                <FieldLabel>{t('workspace.field.startup')}</FieldLabel>
                <input
                  type="text"
                  value={startupCommand}
                  onChange={(event) => setStartupCommand(event.target.value)}
                  placeholder={t('workspace.field.startupPlaceholder')}
                  className="input mono"
                  data-testid="orchestrator-config-startup-command"
                />
                <span className="text-xs text-ter">{t('workspace.startup.hint')}</span>
              </label>
            </div>

            <div
              className="flex items-center justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" onClick={onCancel} className="icon-btn" disabled={saving}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                data-testid="orchestrator-config-save"
                className="icon-btn icon-btn--primary"
              >
                {saving ? <LoaderCircle size={12} aria-hidden className="animate-spin" /> : null}
                {saving ? t('orchestrator.config.saving') : t('orchestrator.config.save')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
