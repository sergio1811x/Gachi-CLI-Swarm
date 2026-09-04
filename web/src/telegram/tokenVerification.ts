import type { UiLanguage } from '../uiLanguage.js'

/**
 * Client-side convenience timestamp of the last successful token check
 * (verify / test connection). UI hint only — "checked 2 min ago" — never a
 * source of truth for the bot state (that is the server's lastError/config).
 */

const STORAGE_KEY = 'telegram.token.verifiedAt'

export const readTokenVerifiedAt = (): number | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export const writeTokenVerifiedAt = (): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()))
  } catch {
    // Losing the timestamp only hides the relative-time hint.
  }
}

/** "2 minutes ago"-style phrase in the active UI language. */
export const formatCheckedAgo = (timestamp: number, language: UiLanguage): string => {
  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000))
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.round(hours / 24), 'day')
}

/**
 * Telegram bot tokens look like `123456789:AAExample_Token-Chars` — numeric
 * bot id, colon, base64url-ish secret. Deliberately loose: the authoritative
 * check is the server call to BotFather.
 */
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/

export const isPlausibleTokenFormat = (token: string): boolean => TOKEN_PATTERN.test(token.trim())
