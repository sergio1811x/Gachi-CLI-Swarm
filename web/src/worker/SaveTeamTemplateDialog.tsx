import * as Dialog from '@radix-ui/react-dialog'
import { Save } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

type SaveTeamTemplateDialogProps = {
  open: boolean
  memberCount: number
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (name: string) => void
}

export const SaveTeamTemplateDialog = ({
  open,
  memberCount,
  saving,
  error,
  onClose,
  onSave,
}: SaveTeamTemplateDialogProps) => {
  const { t } = useI18n()
  const [name, setName] = useState('')

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setName('')
      onClose()
    }
  }

  const trimmed = name.trim()

  const handleSubmit = () => {
    if (!trimmed || saving) return
    onSave(trimmed)
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            data-testid="save-team-template-dialog"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[420px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="flex items-start gap-3">
              <div
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Save size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('teamTemplate.saveTitle')}
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 text-sm text-sec">
                  {t('teamTemplate.saveDescription', { count: String(memberCount) })}
                </Dialog.Description>
              </div>
            </div>

            <label className="mt-4 flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-ter">
                {t('teamTemplate.nameLabel')}
              </span>
              <input
                // biome-ignore lint/a11y/noAutofocus: naming dialog should land the caret in the field
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSubmit()
                }}
                placeholder={t('teamTemplate.namePlaceholder')}
                className="input"
                data-testid="save-team-template-name"
              />
            </label>
            {error ? (
              <p className="mt-2 text-xs" style={{ color: 'var(--status-red)' }}>
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="icon-btn">
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!trimmed || saving}
                data-testid="save-team-template-confirm"
                className="icon-btn icon-btn--primary"
              >
                {saving ? t('teamTemplate.saving') : t('teamTemplate.save')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
