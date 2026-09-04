import { Check, Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TelegramSettings } from '../api.js'
import { updateTelegramSettings, verifyTelegramToken } from '../api.js'
import { useI18n } from '../i18n.js'
import { useToast } from '../ui/useToast.js'
import { TelegramCard } from './TelegramCard.js'
import {
  formatCheckedAgo,
  isPlausibleTokenFormat,
  readTokenVerifiedAt,
  writeTokenVerifiedAt,
} from './tokenVerification.js'

type SaveState = 'idle' | 'saving' | 'saved'

interface TelegramTokenCardProps {
  settings: TelegramSettings | null
  reload: () => void
}

/**
 * Token section (ТЗ v3 §4): stored-state indicator, a 34px password field
 * with inline reveal toggle, and compact Verify / Save actions. The helper
 * copy is gone — the placeholder explains what to paste when empty.
 */
export const TelegramTokenCard = ({ settings, reload }: TelegramTokenCardProps) => {
  const { t, language } = useI18n()
  const toast = useToast()
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [debouncedValue, setDebouncedValue] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifiedUsername, setVerifiedUsername] = useState<string | null>(null)
  const [verifiedAt, setVerifiedAt] = useState<number | null>(() => readTokenVerifiedAt())
  const savedTimer = useRef<number | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(tokenInput), 300)
    return () => window.clearTimeout(timer)
  }, [tokenInput])

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
    },
    []
  )

  const trimmed = debouncedValue.trim()
  const formatError = trimmed !== '' && !isPlausibleTokenFormat(trimmed)
  const dirty = tokenInput.trim() !== ''
  const canSave = dirty && !formatError && saveState === 'idle'
  const canVerify = trimmed !== '' && !formatError && !verifying

  const handleSave = () => {
    if (!canSave) return
    setSaveState('saving')
    setVerifyError(null)
    // Saving a token implies enabling the interface — the user expects the
    // bot to start working right after Save, not after hunting a checkbox.
    updateTelegramSettings({ token: tokenInput.trim(), enabled: true })
      .then(() => {
        writeTokenVerifiedAt()
        setVerifiedAt(Date.now())
        setTokenInput('')
        setDebouncedValue('')
        setVerifiedUsername(null)
        reload()
        toast.show({ kind: 'success', message: t('token.updated') })
        setSaveState('saved')
        savedTimer.current = window.setTimeout(() => setSaveState('idle'), 1500)
      })
      .catch((err: unknown) => {
        setSaveState('idle')
        setVerifyError(err instanceof Error ? err.message : 'Failed to save token')
      })
  }

  const handleVerify = () => {
    if (!canVerify) return
    setVerifying(true)
    setVerifyError(null)
    verifyTelegramToken(tokenInput.trim())
      .then((username) => {
        writeTokenVerifiedAt()
        setVerifiedAt(Date.now())
        setVerifiedUsername(username)
        reload()
      })
      .catch((err: unknown) => {
        setVerifiedUsername(null)
        setVerifyError(err instanceof Error ? err.message : 'Token verification failed')
      })
      .finally(() => setVerifying(false))
  }

  const statusLine = (() => {
    if (!settings?.config.tokenSet && !dirty) return null
    if (verifiedAt === null) return t('telegram.token.stored')
    return `${t('token.valid')} · ${t('token.checkedAt', { time: formatCheckedAgo(verifiedAt, language) })}`
  })()

  return (
    <TelegramCard label={t('telegram.token.label')}>
      {statusLine ? (
        <div
          className="mb-1.5 flex items-center gap-1.5 text-[11px]"
          style={{ color: '#22c55e' }}
          data-testid="telegram-token-status"
        >
          <span aria-hidden>●</span>
          {statusLine}
        </div>
      ) : null}

      <div className="relative">
        <input
          type={showToken ? 'text' : 'password'}
          value={tokenInput}
          placeholder={
            settings?.config.tokenSet ? t('telegram.token.stored') : t('token.placeholder')
          }
          autoComplete="off"
          spellCheck={false}
          className={`mono tg-input h-[34px] pr-9 ${formatError ? 'tg-input--error' : ''}`}
          data-testid="telegram-token-input"
          aria-invalid={formatError}
          onChange={(event) => setTokenInput(event.currentTarget.value)}
        />
        <button
          type="button"
          aria-label={showToken ? t('token.hide') : t('token.show')}
          className="sd-icon-btn absolute top-1/2 right-1 -translate-y-1/2"
          onClick={() => setShowToken((value) => !value)}
        >
          {showToken ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        </button>
      </div>

      {formatError ? (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--status-red)' }} role="alert">
          ❌ {t('token.invalidFormat')}
        </p>
      ) : null}

      {verifiedUsername ? (
        <p className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: '#22c55e' }}>
          <Check size={11} aria-hidden />
          {t('telegram.verified')}: @{verifiedUsername}
        </p>
      ) : null}
      {verifyError ? (
        <p
          className="mt-1 truncate text-[11px]"
          style={{ color: 'var(--status-red)' }}
          role="alert"
          title={verifyError}
        >
          {verifyError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="tg-btn tg-btn--secondary"
          disabled={!canVerify}
          onClick={handleVerify}
          data-testid="telegram-verify"
        >
          {verifying ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : (
            <RefreshCw size={12} aria-hidden />
          )}
          {t('telegram.verify')}
        </button>
        <button
          type="button"
          className="tg-btn tg-btn--primary ml-auto"
          disabled={!canSave}
          onClick={handleSave}
          data-testid="telegram-save-token"
        >
          {saveState === 'saving' ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : saveState === 'saved' ? (
            <Check size={12} aria-hidden />
          ) : null}
          {saveState === 'saving' ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </TelegramCard>
  )
}
