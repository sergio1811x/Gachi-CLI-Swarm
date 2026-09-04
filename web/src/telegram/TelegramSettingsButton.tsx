import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { TelegramSettings } from '../api.js'
import { fetchTelegramSettings } from '../api.js'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { TelegramAccessCard } from './TelegramAccessCard.js'
import { TelegramIcon } from './TelegramIcon.js'
import { TelegramNetworkCard } from './TelegramNetworkCard.js'
import { TelegramStatusCard } from './TelegramStatusCard.js'
import { TelegramTokenCard } from './TelegramTokenCard.js'

/**
 * Telegram interface settings (ТЗ v3): topbar trigger + a narrow 360px
 * right-side drawer. Flat hairline-separated sections — connection status,
 * bot token, proxy, access control — no cards, no duplicate headings.
 */
export const TelegramSettingsButton = () => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<TelegramSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(() => {
    fetchTelegramSettings()
      .then((next) => {
        setSettings(next)
        setLoadError(null)
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings')
      )
  }, [])

  // Reload whenever the drawer opens so the panel reflects server state.
  useEffect(() => {
    if (!open) return
    reload()
  }, [open, reload])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={t('telegram.tooltip')}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('telegram.tooltip')}
          className="flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
          data-testid="topbar-telegram"
          onClick={() => setOpen(true)}
        >
          <TelegramIcon size={22} />
        </button>
      </Tooltip>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <Dialog.Content
          data-testid="telegram-settings"
          className="settings-drawer pointer-events-auto fixed top-0 right-0 z-50 flex h-screen w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden border-y-0 border-r-0 p-4"
          style={{ background: 'var(--bg-0)', borderLeft: '1px solid var(--border-bright)' }}
        >
          <div className="relative shrink-0 border-b pb-4" style={{ borderColor: 'var(--border)' }}>
            <Dialog.Title className="pr-8 text-base font-semibold text-pri">
              🤖 {t('telegram.heading')}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-ter">
              {t('telegram.subtitle')}
            </Dialog.Description>
            <Dialog.Close
              aria-label={t('common.close')}
              className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center rounded-md text-ter transition-colors hover:bg-3 hover:text-pri"
              data-testid="telegram-close"
            >
              <X size={14} aria-hidden />
            </Dialog.Close>
          </div>

          <div className="scroll-y min-h-0 flex-1 overflow-y-auto">
            {loadError ? (
              <p
                className="mt-2 rounded-md px-2 py-1.5 text-xs"
                style={{
                  color: 'var(--status-red)',
                  background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                }}
                role="alert"
              >
                {loadError}
              </p>
            ) : null}

            <TelegramStatusCard settings={settings} reload={reload} />
            <TelegramTokenCard settings={settings} reload={reload} />
            <TelegramNetworkCard settings={settings} reload={reload} />
            <TelegramAccessCard settings={settings} reload={reload} />
          </div>

          <footer
            className="mt-1 flex shrink-0 items-center justify-end border-t pt-2.5"
            style={{ borderColor: 'var(--border)' }}
          >
            <Dialog.Close className="sm-cancel-btn" asChild>
              <button type="button">{t('common.close')}</button>
            </Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
