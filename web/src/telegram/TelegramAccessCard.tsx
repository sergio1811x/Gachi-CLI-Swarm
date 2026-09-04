import { Copy, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TelegramLinkItem, TelegramSettings } from '../api.js'
import { createTelegramPairingCode, removeTelegramLink } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import { TelegramCard } from './TelegramCard.js'

interface PairingCode {
  code: string
  expiresAt: number
}

interface TelegramAccessCardProps {
  settings: TelegramSettings | null
  reload: () => void
}

const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Access section (ТЗ v3 §6): pairing-code generation with live countdown,
 * then the linked accounts as bare rows — role badge + hover-revealed
 * remove. No cards, no role editor; roles display as-is.
 */
export const TelegramAccessCard = ({ settings, reload }: TelegramAccessCardProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [pairing, setPairing] = useState<PairingCode | null>(null)
  const [generating, setGenerating] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busyLink, setBusyLink] = useState<string | null>(null)
  const [unlinkTarget, setUnlinkTarget] = useState<TelegramLinkItem | null>(null)

  // Live countdown for the pairing code; the code disappears at zero.
  useEffect(() => {
    if (!pairing) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      if (Date.now() >= pairing.expiresAt) {
        setPairing(null)
        window.clearInterval(timer)
      } else {
        setNow(Date.now())
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pairing])

  const generateCode = () => {
    setGenerating(true)
    createTelegramPairingCode()
      .then((result) => setPairing({ code: result.code, expiresAt: result.expires_at }))
      .catch((err: unknown) => {
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : 'Failed to generate code',
        })
      })
      .finally(() => setGenerating(false))
  }

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      toast.show({ kind: 'success', message: t('common.copied') })
    })
  }

  const confirmUnlink = () => {
    if (!unlinkTarget) return
    const target = unlinkTarget
    const key = `${target.chat_id}:${target.user_id}`
    setBusyLink(key)
    removeTelegramLink(target.chat_id, target.user_id)
      .then(() => reload())
      .catch((err: unknown) => {
        toast.show({
          kind: 'warning',
          message: err instanceof Error ? err.message : 'Failed to remove link',
        })
      })
      .finally(() => setBusyLink(null))
  }

  const links = settings?.links ?? []

  return (
    <TelegramCard label={t('access.title')}>
      {!pairing ? (
        <button
          type="button"
          className="tg-btn tg-btn--secondary"
          disabled={generating}
          onClick={generateCode}
          data-testid="telegram-generate-code"
        >
          {generating ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : (
            <KeyRound size={12} aria-hidden />
          )}
          {t('telegram.pairing.button')}
        </button>
      ) : (
        <div className="flex items-center gap-2" data-testid="telegram-pairing-active">
          <code className="tg-code" data-testid="telegram-pairing-code">
            {pairing.code}
          </code>
          <span className="inline-flex items-center gap-1 text-[11px] text-ter">
            ⏳ {formatCountdown(pairing.expiresAt - now)}
          </span>
          <Tooltip label={t('pairing.copyCommand')}>
            <button
              type="button"
              aria-label={t('pairing.copyCommand')}
              className="sd-icon-btn ml-auto shrink-0"
              onClick={() => copyText(`/start ${pairing.code}`)}
            >
              <Copy size={12} aria-hidden />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="mt-3">
        {links.length === 0 ? (
          <p
            className="py-2 text-[11px] text-ter"
            style={{ color: 'var(--text-extra-light)' }}
            data-testid="telegram-links-empty"
          >
            {t('telegram.links.empty')}
          </p>
        ) : (
          <ul>
            {links.map((link) => {
              const key = `${link.chat_id}:${link.user_id}`
              const label = link.username ? `@${link.username}` : link.user_id
              return (
                <li key={key} className="tg-link-row">
                  <span
                    className="mono min-w-0 truncate text-[13px]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {label}
                  </span>
                  <span className={`tg-role-badge tg-role-badge--${link.role} ml-auto`}>
                    {t(`telegram.role.${link.role}`)}
                  </span>
                  <Tooltip label={t('telegram.remove')}>
                    <button
                      type="button"
                      aria-label={t('links.unlinkTitle', {
                        username: link.username ?? link.user_id,
                      })}
                      className="tg-remove"
                      disabled={busyLink === key}
                      onClick={() => setUnlinkTarget(link)}
                    >
                      <Trash2 size={11} aria-hidden />
                    </button>
                  </Tooltip>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Confirm
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null)
        }}
        title={
          unlinkTarget
            ? t('links.unlinkTitle', { username: unlinkTarget.username ?? unlinkTarget.user_id })
            : ''
        }
        description={t('links.unlinkDescription')}
        confirmLabel={t('telegram.remove')}
        confirmKind="danger"
        onConfirm={confirmUnlink}
      />
    </TelegramCard>
  )
}
