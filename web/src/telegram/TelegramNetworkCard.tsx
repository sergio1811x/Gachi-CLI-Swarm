import { useEffect, useRef, useState } from 'react'
import type { TelegramSettings } from '../api.js'
import { updateTelegramSettings } from '../api.js'
import { useI18n } from '../i18n.js'
import { useToast } from '../ui/useToast.js'
import { TelegramCard } from './TelegramCard.js'

interface TelegramNetworkCardProps {
  settings: TelegramSettings | null
  reload: () => void
}

/**
 * Proxy section (ТЗ v3 §5): one field, no labels, no save button. The value
 * commits on blur (empty = clear back to direct connection); the hint line
 * is the only copy.
 */
export const TelegramNetworkCard = ({ reload }: TelegramNetworkCardProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [proxyInput, setProxyInput] = useState('')
  const committedRef = useRef<string>('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(
    () => () => {
      setSaving(false)
    },
    []
  )

  // Auto-save on blur: only when the value actually differs from what the
  // server already has (tracked locally — the API returns a masked proxy).
  const commitProxy = () => {
    const value = proxyInput.trim()
    if (value === committedRef.current || saving) return
    setSaving(true)
    setSaveError(null)
    updateTelegramSettings({ proxy_url: value.length > 0 ? value : null })
      .then(() => {
        committedRef.current = value
        toast.show({ kind: 'success', message: t('network.updated') })
        reload()
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to save network settings')
      })
      .finally(() => setSaving(false))
  }

  return (
    <TelegramCard label={t('network.proxyLabel')}>
      <input
        type="text"
        value={proxyInput}
        placeholder={t('telegram.proxy.placeholder')}
        autoComplete="off"
        spellCheck={false}
        className="mono tg-input h-[34px]"
        aria-label={t('network.proxyLabel')}
        onChange={(event) => setProxyInput(event.currentTarget.value)}
        onBlur={commitProxy}
      />
      <p className="tg-hint">ℹ️ {t('telegram.advanced.helper')}</p>

      {saving ? <p className="tg-hint">{t('common.saving')}</p> : null}
      {saveError ? (
        <p
          className="mt-1 truncate text-[11px]"
          style={{ color: 'var(--status-red)' }}
          role="alert"
          title={saveError}
        >
          {saveError}
        </p>
      ) : null}
    </TelegramCard>
  )
}
