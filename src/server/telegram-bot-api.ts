/**
 * Minimal Telegram Bot API client (long polling — no public URL needed for a
 * local-first app). The transport is injectable so tests can drive the whole
 * service against a fake gateway without network access.
 *
 * Only the surface the integration needs: getMe (token check), getUpdates
 * (long poll), sendMessage (text + inline keyboards), answerCallbackQuery,
 * setMyCommands.
 */

import { ProxyAgent } from 'undici'

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name?: string | undefined
  username?: string | undefined
}

export interface TelegramChat {
  id: number
  type: string
  title?: string | undefined
  username?: string | undefined
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser | undefined
  chat: TelegramChat
  date: number
  text?: string | undefined
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage | undefined
  data?: string | undefined
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage | undefined
  callback_query?: TelegramCallbackQuery | undefined
}

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export interface SendMessageOptions {
  reply_markup?: TelegramInlineKeyboard
}

export interface TelegramBotApi {
  getMe: () => Promise<TelegramUser>
  getUpdates: (offset: number, timeoutSeconds: number) => Promise<TelegramUpdate[]>
  sendMessage: (
    chatId: string | number,
    text: string,
    options?: SendMessageOptions
  ) => Promise<void>
  answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>
}

export interface TelegramBotApiOptions {
  token: string
  /** Override for tests (fake gateway base URL). */
  apiRoot?: string
  fetchImpl?: typeof fetch
  fetchTimeoutMs?: number
  /**
   * HTTP(S) proxy URL (e.g. the user's local proxy at http://127.0.0.1:10809).
   * Console runtimes ignore the Windows system proxy, which is why browsers
   * reach api.telegram.org while the app gets "fetch failed".
   */
  proxyUrl?: string | null
}

const DEFAULT_API_ROOT = 'https://api.telegram.org'

export const createTelegramBotApi = ({
  token,
  apiRoot = DEFAULT_API_ROOT,
  fetchImpl = fetch,
  fetchTimeoutMs = 60_000,
  proxyUrl = null,
}: TelegramBotApiOptions): TelegramBotApi => {
  const dispatcher: ProxyAgent | undefined =
    proxyUrl && !proxyUrl.startsWith('socks') ? new ProxyAgent(proxyUrl) : undefined

  const call = async <T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = fetchTimeoutMs
  ): Promise<T> => {
    let response: Response
    try {
      const init: RequestInit & Record<string, unknown> = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (dispatcher) init.dispatcher = dispatcher
      response = await fetchImpl(`${apiRoot}/bot${token}/${method}`, init)
    } catch (error) {
      // Network errors can echo the request URL, which embeds the bot token —
      // redact it before the message reaches any log or chat (audit M-2), and
      // tell the user what "fetch failed" actually means.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Telegram ${method} network error: ${message.split(token).join('***')} — check internet/VPN/proxy access to ${apiRoot}`
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // Flood control: Telegram tells us exactly how long to wait. Honor it
      // once instead of failing the notification (stability: replies must
      // not be lost to a burst).
      if (response.status === 429) {
        let retryAfterSeconds = 2
        try {
          const parsed = JSON.parse(detail) as {
            parameters?: { retry_after?: number }
          }
          if (typeof parsed.parameters?.retry_after === 'number') {
            retryAfterSeconds = Math.min(Math.max(parsed.parameters.retry_after, 1), 10)
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000 + 250))
        return call<T>(method, body, timeoutMs)
      }
      throw new Error(
        `Telegram ${method} failed (${response.status}): ${detail.slice(0, 200).split(token).join('***')}`
      )
    }
    const payload = (await response.json()) as { ok: boolean; result: T; description?: string }
    if (!payload.ok) {
      throw new Error(
        `Telegram ${method} rejected: ${(payload.description ?? 'unknown error').split(token).join('***')}`
      )
    }
    return payload.result
  }

  return {
    async getMe() {
      return call<TelegramUser>('getMe', {})
    },
    async getUpdates(offset, timeoutSeconds) {
      return call<TelegramUpdate[]>(
        'getUpdates',
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        },
        // Long poll must outlive the server-side wait plus network slop.
        timeoutSeconds * 1000 + 30_000
      )
    },
    async sendMessage(chatId, text, options) {
      await call<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...options,
      })
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call<boolean>(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
        10_000
      )
    },
  }
}
