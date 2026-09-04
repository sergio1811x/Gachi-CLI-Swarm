import { describe, expect, test } from 'vitest'
import { createTelegramService } from '../../src/server/telegram-service.js'

const makeCtx = (digestText: string) => {
  const values = new Map<string, string | null>()
  values.set('telegram_enabled', 'true')
  values.set('telegram_bot_token', 'test-token')
  const settings = {
    getAppState: (key: string) =>
      values.has(key) ? { key, value: values.get(key) ?? null } : undefined,
    setAppState: (key: string, value: string | null) => void values.set(key, value),
  }
  const sent: Array<{ text: string }> = []
  const service = createTelegramService({
    approvals: {
      create: () => {
        throw new Error('unused')
      },
      decide: () => undefined,
      get: () => undefined,
      listPending: () => [],
      listRecent: () => [],
    } as never,
    links: {
      upsert: () => {
        throw new Error('unused')
      },
      get: () => undefined,
      list: () => [
        {
          chatId: '-500',
          linkedAt: Date.now(),
          role: 'owner' as const,
          userId: '100',
          username: null,
          workspaceId: null,
        },
      ],
      remove: () => false,
    },
    settings,
    createApi: () =>
      ({
        async getMe() {
          return { id: 1, is_bot: true, username: 'bot' }
        },
        async getUpdates() {
          return []
        },
        async sendMessage(_chatId: string | number, text: string) {
          sent.push({ text })
        },
        async answerCallbackQuery() {},
      }) as never,
    getDailyDigest: () => digestText,
    listWorkspaceIds: () => ['ws-1'],
  })
  const maybeSendDigest = (
    service._test as unknown as { maybeSendDigest: (now?: number) => Promise<boolean> }
  ).maybeSendDigest
  return { maybeSendDigest, sent, settings }
}

describe('telegram morning digest (T1)', () => {
  test('sends once per day at/after the configured time, then stays quiet', async () => {
    const ctx = makeCtx('Last 24h: ✅ 3 done, ❌ 0 failed\nTokens: ~42,000')
    // 2026-08-27 09:31 local — one minute past the configured time.
    const now = new Date(2026, 7, 27, 9, 31).getTime()
    ctx.settings.setAppState('telegram_digest_at', '09:30')

    expect(await ctx.maybeSendDigest(new Date(2026, 7, 27, 9, 0).getTime())).toBe(false)
    expect(ctx.sent).toHaveLength(0)

    expect(await ctx.maybeSendDigest(now)).toBe(true)
    expect(ctx.sent[0]?.text).toContain('Daily digest')
    expect(ctx.sent[0]?.text).toContain('✅ 3 done')

    // Same day → silent even after the time.
    expect(await ctx.maybeSendDigest(now + 60 * 60_000)).toBe(false)
    expect(ctx.sent).toHaveLength(1)

    // Next day → fires again.
    const nextDay = new Date(2026, 7, 28, 10, 0).getTime()
    expect(await ctx.maybeSendDigest(nextDay)).toBe(true)
    expect(ctx.sent).toHaveLength(2)
  })

  test('disabled without a config value', async () => {
    const ctx = makeCtx('x')
    expect(await ctx.maybeSendDigest(Date.now())).toBe(false)
    expect(ctx.sent).toHaveLength(0)
  })
})
