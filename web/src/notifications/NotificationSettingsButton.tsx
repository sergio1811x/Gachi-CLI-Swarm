import { Settings } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import { NotificationSettingsModal } from './NotificationSettingsModal.js'

export const NotificationSettingsButton = () => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Tooltip label={t('notifications.settings.tooltip')}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('notifications.settings.aria')}
          className="flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
          data-testid="topbar-settings"
          onClick={() => setOpen(true)}
        >
          <Settings size={22} aria-hidden />
        </button>
      </Tooltip>
      <NotificationSettingsModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
