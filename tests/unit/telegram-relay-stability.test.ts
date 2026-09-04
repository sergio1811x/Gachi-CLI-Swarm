import { describe, expect, test } from 'vitest'

import type { ApprovalStore } from '../../src/server/approval-store.js'
import type { TelegramBotApi, TelegramUpdate } from '../../src/server/telegram-bot-api.js'
import type { TelegramLink } from '../../src/server/telegram-links-store.js'
import type { TelegramServiceDeps } from '../../src/server/telegram-service.js'
import { createTelegramService } from '../../src/server/telegram-service.js'

/**
 * Stability regression (owner): free-text orders for a temporarily offline
 * orchestrator used to vanish while the bot replied "Forwarded to the
 * orchestrator." Delivery is now honest; offline messages queue and are
 * re-injected automatically when the PTY is writable again.
 */

const makeSettings = () => {
  const values = new Map<string, string | null>()
  return {
    getAppState: (key: string) =>
      values.has(key) ? { key, value: values.get(key) ?? null } : undefined,
    setAppState: (key: string, value: string | null) => {
      values.set(key, value)
    },
  }
}

const makeLinks = () => {
  const items = new Map<string, TelegramLink>()
  return {
    upsert(link: { chatId: string; userId: string; role?: TelegramLink['role'] }) {
      const record: TelegramLink = {
        chatId: link.chatId,
        linkedAt: Date.now(),
        role: link.role ?? 'viewer',
        userId: link.userId,
        username: null,
        workspaceId: null,
      }
      items.set(`${link.chatId}:${link.userId}`, record)
      return record
    },
    get: (chatId: string, userId: string) => items.get(`${chatId}:${userId}`),
    list: () => [...items.values()],
    remove: (chatId: string, userId: string) => items.delete(`${chatId}:${userId}`),
  }
}

const makeApprovals = (): ApprovalStore =>
  ({
    create: () => {
      throw new Error('unused')
    },
    decide: () => undefined,
    get: () => undefined,
    listPending: () => [],
    listRecent: () => [],
  }) as unknown as ApprovalStore

const setup = (sendToOrchestrator: NonNullable<TelegramServiceDeps['sendToOrchestrator']>) => {
  const sent: Array<{ chatId: string | number; text: string }> = []
  const settings = makeSettings()
  settings.setAppState('telegram_bot_token', 'test-token')
  settings.setAppState('telegram_enabled', 'true')
  const api: TelegramBotApi = {
    async getMe() {
      return { id: 42, is_bot: true, username: 'gachi_bot' }
    },
    async getUpdates() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return []
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text })
    },
    async answerCallbackQuery() {},
  }
  const service = createTelegramService({
    approvals: makeApprovals(),
    links: makeLinks(),
    settings,
    createApi: () => api,
    getWorkspaceName: () => 'Alpha',
    listWorkspaceIds: () => ['ws-1'],
    listWorkers: () => [],
    sendToOrchestrator,
  })
  const handleUpdate = (update: TelegramUpdate) =>
    (service._test.handleUpdate as (update: TelegramUpdate) => Promise<void>)(update)
  return { handleUpdate, sent, service }
}

const messageUpdate = (text: string): TelegramUpdate => ({
  update_id: Date.now(),
  message: {
    chat: { id: -500, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    from: { first_name: 'T', id: 100, is_bot: false, username: 'tester' },
    message_id: 1,
    text,
  },
})

describe('offline orchestrator relay (stability)', () => {
  test('undelivered order queues with an honest reply and flushes when back online', async () => {
    let online = false
    const delivered: string[] = []
    const ctx = setup((_workspaceId, text) => {
      if (!online) return false
      delivered.push(text)
      return true
    })

    const pairing = ctx.service.createPairingCode()
    await ctx.handleUpdate(messageUpdate(`/start ${pairing.code}`))
    ctx.sent.length = 0

    await ctx.handleUpdate(messageUpdate('почини сборку и отчитайся'))
    const lastReply = ctx.sent.at(-1)?.text ?? ''
    expect(lastReply).toContain('queued')
    expect(lastReply).toContain('not running')
    expect(delivered).toHaveLength(0)

    // Orchestrator returns → flush delivers the exact queued payload.
    online = true
    await (
      ctx.service._test as unknown as { flushPendingRelay: () => Promise<number> }
    ).flushPendingRelay()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('(OWNER)')
    expect(delivered[0]).toContain('почини сборку')
    expect(ctx.sent.some((m) => m.text.includes('all queued messages were delivered'))).toBe(true)
  })

  test('online orchestrator still confirms immediately without queueing', async () => {
    const delivered: string[] = []
    const ctx = setup((_ws, text) => {
      delivered.push(text)
      return true
    })
    const pairing = ctx.service.createPairingCode()
    await ctx.handleUpdate(messageUpdate(`/start ${pairing.code}`))
    ctx.sent.length = 0

    await ctx.handleUpdate(messageUpdate('run the release checklist'))
    expect(delivered).toHaveLength(1)
    expect(ctx.sent.at(-1)?.text).toBe('Forwarded to the orchestrator.')
  })
})
