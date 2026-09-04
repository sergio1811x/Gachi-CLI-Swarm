import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import type { TelegramSettings } from '../api.js'
import { testTelegramConnection } from '../api.js'
import { useI18n } from '../i18n.js'
import { TelegramCard } from './TelegramCard.js'
import { writeTokenVerifiedAt } from './tokenVerification.js'

type ConnectionState = 'active' | 'setup' | 'offline'

const connectionState = (config: TelegramSettings['config']): ConnectionState => {
  if (!config.tokenSet || config.lastError) return 'offline'
  return config.enabled ? 'active' : 'setup'
}

const stateHue: Record<ConnectionState, string> = {
  active: '#22c55e',
  setup: 'var(--status-gold)',
  offline: 'var(--status-red)',
}

interface TelegramStatusCardProps {
  settings: TelegramSettings | null
  reload: () => void
}

/**
 * Status section (ТЗ v3 §3): one line — colored badge, bot username, and a
 * compact "test connection" action pinned right. Errors surface as a single
 * muted line under the row instead of an expandable block.
 */
export const TelegramStatusCard = ({ settings, reload }: TelegramStatusCardProps) => {
  const { t } = useI18n()
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const config = settings?.config
  const state: ConnectionState = config ? connectionState(config) : 'offline'
  const hue = stateHue[state]
  const statusLabel =
    state === 'active'
      ? t('telegram.status.active')
      : state === 'setup'
        ? t('telegram.status.setup')
        : t('telegram.status.offline')

  const runTest = () => {
    setTesting(true)
    setTestError(null)
    testTelegramConnection()
      .then((result) => {
        if (result.ok && result.bot_username) {
          writeTokenVerifiedAt()
          reload()
        } else {
          setTestError(result.error ?? 'Connection test failed')
        }
      })
      .catch((err: unknown) =>
        setTestError(err instanceof Error ? err.message : 'Connection test failed')
      )
      .finally(() => setTesting(false))
  }

  const errorText = testError ?? config?.lastError ?? null

  return (
    <TelegramCard label={t('telegram.status.sectionLabel')} testId="telegram-status-block">
      <div className="flex min-w-0 items-center gap-2">
        {testing ? (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-ter"
            data-testid="telegram-status-skeleton"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden />…
          </span>
        ) : (
          <>
            <span
              className="tg-badge"
              data-testid="telegram-status-badge"
              style={{
                color: hue,
                background: `color-mix(in oklab, ${hue} 10%, transparent)`,
              }}
            >
              <span
                aria-hidden
                className="inline-block h-[6px] w-[6px] rounded-full"
                style={{ background: hue }}
              />
              {statusLabel}
            </span>
            {config?.botUsername ? (
              <code
                className="mono truncate text-[13px]"
                style={{ color: 'var(--text-primary)' }}
                title={`@${config.botUsername}`}
              >
                {`@${config.botUsername}`}
              </code>
            ) : null}
          </>
        )}
        <button
          type="button"
          className="tg-btn-sm ml-auto shrink-0"
          disabled={!config?.tokenSet || testing}
          onClick={runTest}
          data-testid="telegram-test-connection"
        >
          {testing ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
          {t('telegram.test')}
        </button>
      </div>

      {errorText && !testing ? (
        <p
          className="mt-1.5 truncate text-[11px]"
          style={{ color: 'var(--status-red)' }}
          role="alert"
          title={errorText}
        >
          {errorText}
        </p>
      ) : null}
    </TelegramCard>
  )
}
