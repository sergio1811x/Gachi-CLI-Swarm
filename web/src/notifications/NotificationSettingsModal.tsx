import * as Dialog from '@radix-ui/react-dialog'
import { Bell, Check, Copy, Loader2, Pause, Play, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getUiSessionToken, regenerateUiSessionToken } from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import type { UiLanguage } from '../uiLanguage.js'
import type { NotificationDetail, NotificationSound } from './NotificationProvider.js'
import { useNotifications } from './NotificationProvider.js'

interface SoundOption {
  labelKey: TranslationKey
  muted: boolean
  value: NotificationSound
}

const SOUND_OPTIONS: SoundOption[] = [
  { labelKey: 'notifications.sound.sound1.label', muted: false, value: 'sound1' },
  { labelKey: 'notifications.sound.sound2.label', muted: false, value: 'sound2' },
  { labelKey: 'notifications.sound.sound3.label', muted: false, value: 'sound3' },
  { labelKey: 'notifications.sound.off.label', muted: true, value: 'off' },
]

interface DetailOption {
  descriptionKey: TranslationKey
  labelKey: TranslationKey
  value: NotificationDetail
}

const DETAIL_OPTIONS: DetailOption[] = [
  {
    descriptionKey: 'notifications.detail.brief.description',
    labelKey: 'notifications.detail.brief.label',
    value: 'brief',
  },
  {
    descriptionKey: 'notifications.detail.detailed.description',
    labelKey: 'notifications.detail.detailed.label',
    value: 'detailed',
  },
]

const LANGUAGE_OPTIONS: UiLanguage[] = [
  'en',
  'ru',
  'zh',
  'es',
  'pt',
  'fr',
  'it',
  'de',
  'ja',
  'ko',
  'ar',
  'hi',
  'tr',
]

const formatSessionToken = (token: string) =>
  token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token

export interface NotificationSettingsModalProps {
  onClose: () => void
  open: boolean
}

/**
 * Settings drawer (ТЗ v3): a narrow right-side sheet instead of a centered
 * modal. Flat sections separated by hairlines — no cards. Sounds are a 2×2
 * radio grid with per-row preview; the status segment keeps its description
 * as a tooltip; the session key is one mono line with icon actions.
 */
export const NotificationSettingsModal = ({ onClose, open }: NotificationSettingsModalProps) => {
  const { language, setLanguage, t } = useI18n()
  const { notify, previewSound, requestDesktopNotifications, settings, updateSettings } =
    useNotifications()
  const toast = useToast()
  const desktopUnsupported = typeof window !== 'undefined' && !('Notification' in window)

  const [draft, setDraft] = useState(settings)
  const [snapshot, setSnapshot] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionDimmed, setSessionDimmed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  const [previewing, setPreviewing] = useState<NotificationSound | null>(null)

  // Latest provider values captured for the open-transition effect below;
  // drafts must initialize once when the dialog opens, not on every change.
  const latest = useRef({ settings })
  latest.current = { settings }

  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const saveTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setSnapshot(latest.current.settings)
    setDraft(latest.current.settings)
    setSaving(false)
    setCopied(false)
    setPreviewing(null)
    getUiSessionToken()
      .then(setSessionToken)
      .catch(() => setSessionToken(null))
  }, [open])

  useEffect(
    () => () => {
      window.clearTimeout(copyTimerRef.current)
      window.clearTimeout(saveTimerRef.current)
      previewAudioRef.current?.pause()
    },
    []
  )

  const dirty =
    draft.desktop !== snapshot.desktop ||
    draft.detail !== snapshot.detail ||
    draft.sound !== snapshot.sound

  const soundOptions = useMemo(
    () =>
      SOUND_OPTIONS.map((option) => ({
        ...option,
        label: t(option.labelKey),
      })),
    [t]
  )
  const detailOptions = useMemo(
    () =>
      DETAIL_OPTIONS.map((option) => ({
        ...option,
        description: t(option.descriptionKey),
        label: t(option.labelKey),
      })),
    [t]
  )
  const activeDetailOption = detailOptions.find((option) => option.value === draft.detail)

  // Language applies immediately (live preview); cancel only reverts the
  // drafted sound/detail/desktop settings.
  const discardAndClose = () => {
    updateSettings(snapshot)
    onClose()
  }

  const handleSave = () => {
    if (!dirty || saving) return
    setSaving(true)
    saveTimerRef.current = window.setTimeout(() => {
      updateSettings(draft)
      toast.show({ kind: 'success', message: t('notifications.settings.savedToast') })
      setSaving(false)
      onClose()
    }, 400)
  }

  const handleDesktopToggle = (checked: boolean) => {
    if (!checked) {
      setDraft((current) => ({ ...current, desktop: false }))
      return
    }
    void requestDesktopNotifications().then((granted) => {
      setDraft((current) => ({ ...current, desktop: granted }))
    })
  }

  const handlePreview = (value: NotificationSound) => {
    previewAudioRef.current?.pause()
    const audio = previewSound(value)
    if (!audio) return
    previewAudioRef.current = audio
    setPreviewing(value)
    audio.addEventListener(
      'ended',
      () => {
        setPreviewing((current) => (current === value ? null : current))
      },
      { once: true }
    )
  }

  const handleCopyToken = () => {
    if (!sessionToken) return
    void navigator.clipboard.writeText(sessionToken).then(() => {
      setCopied(true)
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleRegenerate = () => {
    setConfirmingRegenerate(false)
    setSessionBusy(true)
    setSessionDimmed(true)
    regenerateUiSessionToken()
      .then((token) => {
        setSessionToken(token)
        toast.show({ kind: 'success', message: t('session.regenerated') })
      })
      .catch(() => undefined)
      .finally(() => {
        setSessionBusy(false)
        setSessionDimmed(false)
      })
  }

  const sendTestNotification = () =>
    notify({
      brief: t('notifications.test.brief'),
      detail: t('notifications.test.detail'),
      kind: 'success',
      title: t('notifications.test.title'),
    })

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) discardAndClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <Dialog.Content
          className="settings-drawer pointer-events-auto fixed top-0 right-0 z-50 flex h-screen w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden border-y-0 border-r-0 p-4"
          style={{ background: 'var(--bg-0)', borderLeft: '1px solid var(--border-bright)' }}
          data-testid="notification-settings"
        >
          <div className="relative shrink-0 border-b pb-4" style={{ borderColor: 'var(--border)' }}>
            <Dialog.Title className="pr-8 text-base font-semibold text-pri">
              ⚙️ {t('notifications.settings.heading')}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-ter">
              {t('notifications.settings.subtitle')}
            </Dialog.Description>
            <Dialog.Close
              aria-label={t('common.close')}
              className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center rounded-md text-ter transition-colors hover:bg-3 hover:text-pri"
            >
              <X size={14} aria-hidden />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="settings-section">
              <div className="settings-section__label">{t('language.sectionLabel')}</div>
              <select
                aria-label={t('language.tooltip')}
                className="settings-select"
                value={language}
                onChange={(event) => setLanguage(event.currentTarget.value as UiLanguage)}
              >
                {LANGUAGE_OPTIONS.map((item) => (
                  <option key={item} value={item}>
                    {t(`language.${item}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </section>

            <section className="settings-section">
              <div className="settings-section__label">{t('notifications.sound.sectionLabel')}</div>
              <div
                aria-label={t('notifications.sound.sectionLabel')}
                className="sd-radio-grid"
                role="radiogroup"
              >
                {soundOptions.map((item) => {
                  const selected = draft.sound === item.value
                  const playing = previewing === item.value
                  return (
                    <label key={item.value} className="sd-radio-row">
                      <input
                        checked={selected}
                        className="sd-radio"
                        data-testid={`sound-option-${item.value}`}
                        name="notification-sound"
                        onChange={() => setDraft((c) => ({ ...c, sound: item.value }))}
                        type="radio"
                        value={item.value}
                      />
                      <span className="sd-radio-label">{item.label}</span>
                      {!item.muted ? (
                        <button
                          type="button"
                          aria-label={t('notifications.sound.previewAria', { label: item.label })}
                          className="sd-mini-play"
                          disabled={playing}
                          onClick={(event) => {
                            event.preventDefault()
                            handlePreview(item.value)
                          }}
                        >
                          {playing ? (
                            <Pause size={11} aria-hidden />
                          ) : (
                            <Play size={11} aria-hidden />
                          )}
                        </button>
                      ) : null}
                    </label>
                  )
                })}
              </div>
              <button
                type="button"
                className="sd-play-selected"
                disabled={!draft.sound || draft.sound === 'off' || previewing !== null}
                onClick={() => {
                  if (draft.sound && draft.sound !== 'off') handlePreview(draft.sound)
                }}
              >
                {previewing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
                {previewing
                  ? t('notifications.sound.playing')
                  : t('notifications.sound.previewSelected')}
              </button>
            </section>

            <section className="settings-section">
              <div className="settings-section__label">
                {t('notifications.detail.sectionLabel')}
              </div>
              <div
                aria-label={t('notifications.detail.sectionLabel')}
                className="sd-segment"
                role="radiogroup"
                title={activeDetailOption?.description}
              >
                <span
                  aria-hidden
                  className="sm-segment-pill"
                  style={{
                    transform: `translateX(${draft.detail === 'detailed' ? '100%' : '0'})`,
                  }}
                />
                {detailOptions.map((item) => {
                  const active = draft.detail === item.value
                  return (
                    <label key={item.value} className="sd-segment__option">
                      <input
                        checked={active}
                        className="sr-only"
                        name="notification-detail"
                        onChange={() => setDraft((c) => ({ ...c, detail: item.value }))}
                        type="radio"
                        value={item.value}
                      />
                      {item.label}
                    </label>
                  )
                })}
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section__label">{t('session.sectionLabel')}</div>
              <div
                className="flex items-center gap-1"
                style={{
                  opacity: sessionDimmed ? 0.5 : 1,
                  transition: 'opacity 150ms ease',
                }}
              >
                <code
                  className="mono min-w-0 flex-1 truncate text-xs"
                  style={{ color: 'var(--text-secondary)', letterSpacing: '0.03em' }}
                  data-testid="session-token-value"
                  title={sessionToken ?? undefined}
                >
                  {sessionToken ? formatSessionToken(sessionToken) : '…'}
                </code>
                <Tooltip label={copied ? t('common.copied') : t('session.copy')}>
                  <button
                    type="button"
                    aria-label={t('session.copy')}
                    className="sd-icon-btn"
                    data-testid="session-token-copy"
                    disabled={!sessionToken}
                    onClick={handleCopyToken}
                  >
                    {copied ? (
                      <Check size={13} color="var(--status-green)" aria-hidden />
                    ) : (
                      <Copy size={13} aria-hidden />
                    )}
                  </button>
                </Tooltip>
                <Tooltip label={t('session.regenerate')}>
                  <button
                    type="button"
                    aria-label={t('session.regenerate')}
                    className="sd-icon-btn"
                    data-testid="session-token-regenerate"
                    disabled={sessionBusy || !sessionToken}
                    onClick={() => setConfirmingRegenerate(true)}
                  >
                    <RefreshCw
                      size={13}
                      aria-hidden
                      className={sessionBusy ? 'animate-spin' : ''}
                    />
                  </button>
                </Tooltip>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-ter">{t('session.helper')}</p>
            </section>

            <section className="settings-section">
              <div className="flex items-center gap-2">
                <label className="flex min-w-0 cursor-pointer items-center gap-2">
                  <input
                    aria-label={t('notifications.desktop.aria')}
                    checked={draft.desktop}
                    className="sm-checkbox shrink-0"
                    data-testid="desktop-notifications-toggle"
                    disabled={desktopUnsupported}
                    onChange={(event) => handleDesktopToggle(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span
                    className="truncate text-[13px]"
                    style={{
                      color: desktopUnsupported ? 'var(--text-tertiary)' : '#d0d0d0',
                    }}
                    title={desktopUnsupported ? t('notifications.desktop.unsupported') : undefined}
                  >
                    {desktopUnsupported
                      ? t('notifications.desktop.unsupported')
                      : t('notifications.desktop.label')}
                  </span>
                </label>
                {draft.desktop && !desktopUnsupported ? (
                  <button
                    type="button"
                    className="sm-test-btn ml-auto shrink-0"
                    onClick={sendTestNotification}
                  >
                    <Bell size={12} aria-hidden />
                    {t('notifications.test.button')}
                  </button>
                ) : null}
              </div>
            </section>
          </div>

          <footer
            className="mt-1 flex shrink-0 items-center justify-end gap-2 border-t pt-2.5"
            style={{ borderColor: 'var(--border)' }}
          >
            <button type="button" className="sm-cancel-btn" onClick={discardAndClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="sm-save-btn"
              data-testid="settings-save"
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving ? <Loader2 size={13} aria-hidden className="animate-spin" /> : null}
              {t('common.save')}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>

      <Confirm
        open={confirmingRegenerate}
        onOpenChange={setConfirmingRegenerate}
        title={t('session.sectionLabel')}
        description={t('session.regenerateWarning')}
        confirmLabel={t('common.continue')}
        cancelLabel={t('common.cancel')}
        onConfirm={handleRegenerate}
      />
    </Dialog.Root>
  )
}
