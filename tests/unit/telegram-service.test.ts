import { describe, expect, test } from 'vitest'

import type { ApprovalRequest, ApprovalStore } from '../../src/server/approval-store.js'
import type { TelegramBotApi, TelegramUpdate } from '../../src/server/telegram-bot-api.js'
import type { TelegramLink } from '../../src/server/telegram-links-store.js'
import type { TelegramServiceDeps } from '../../src/server/telegram-service.js'
import { createTelegramService } from '../../src/server/telegram-service.js'

/**
 * Deterministic in-memory stand-ins: the service must be drivable without any
 * real network or database. The gateway records everything "sent" so tests can
 * assert on exact bot replies and keyboards.
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
    upsert(link: {
      chatId: string
      userId: string
      username?: null | string
      role?: TelegramLink['role']
    }) {
      const record: TelegramLink = {
        chatId: link.chatId,
        linkedAt: Date.now(),
        role: link.role ?? 'viewer',
        userId: link.userId,
        username: link.username ?? null,
        workspaceId: null,
      }
      items.set(`${link.chatId}:${link.userId}`, record)
      return record
    },
    get(chatId: string, userId: string) {
      return items.get(`${chatId}:${userId}`)
    },
    list: () => [...items.values()],
    remove(chatId: string, userId: string) {
      return items.delete(`${chatId}:${userId}`)
    },
  }
}

const makeApprovals = (): ApprovalStore & { seed: (input: { id: string }) => ApprovalRequest } => {
  const items = new Map<string, ApprovalRequest>()
  return {
    seed(input: { id: string }): ApprovalRequest {
      const record: ApprovalRequest = {
        agentId: 'ws-1:worker',
        command: 'npm install left-pad',
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        dispatchId: null,
        id: input.id,
        reason: 'needed for tests',
        status: 'pending',
        taskId: 'task-1',
        workspaceId: 'ws-1',
      }
      items.set(record.id, record)
      return record
    },
    create(input) {
      const id = `req-${items.size + 1}`
      const record: ApprovalRequest = {
        agentId: input.agentId,
        command: input.command,
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        dispatchId: input.dispatchId ?? null,
        id,
        reason: input.reason ?? null,
        status: 'pending',
        taskId: input.taskId ?? null,
        workspaceId: input.workspaceId,
      }
      items.set(id, record)
      return record
    },
    get(id) {
      return items.get(id)
    },
    decide(id, status, decidedBy) {
      const record = items.get(id)
      if (!record || record.status !== 'pending') return undefined
      record.status = status
      record.decidedAt = Date.now()
      record.decidedBy = decidedBy
      return record
    },
    listPending() {
      return [...items.values()].filter((item) => item.status === 'pending')
    },
    listRecent() {
      return [...items.values()].reverse()
    },
  } as ApprovalStore & { seed: (input: { id: string }) => ApprovalRequest }
}

interface SentMessage {
  chatId: string | number
  text: string
  keyboard: unknown
}

const makeGateway = () => {
  const sent: SentMessage[] = []
  const api: TelegramBotApi = {
    async getMe() {
      return { id: 42, is_bot: true, username: 'gachi_bot' }
    },
    async getUpdates() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return []
    },
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, keyboard: options?.reply_markup ?? null, text })
    },
    async answerCallbackQuery() {},
  }
  return { api, sent }
}

const makeService = (overrides: Partial<TelegramServiceDeps> = {}) => {
  const gateway = makeGateway()
  const settings = makeSettings()
  settings.setAppState('telegram_bot_token', 'test-token')
  settings.setAppState('telegram_enabled', 'true')
  const writtenToPty: string[] = []
  const taskLogs: string[] = []
  const orchestratorInbox: string[] = []
  const links = makeLinks()
  const approvals = makeApprovals()
  const service = createTelegramService({
    approvals,
    links,
    settings,
    addTaskLog: (_workspaceId, _taskId, message) => {
      taskLogs.push(message)
    },
    cancelTaskById: () => true,
    createApi: () => gateway.api,
    getActiveRunByAgentId: () => ({ runId: 'run-1' }),
    getWorkspaceName: (id) => (id === 'ws-1' ? 'Alpha' : undefined),
    listWorkspaceIds: () => ['ws-1'],
    listWorkers: () => [{ name: 'Alice', status: 'working' }],
    sendToOrchestrator: (_workspaceId, text) => {
      orchestratorInbox.push(text)
    },
    writeRunInput: (_runId, text) => {
      writtenToPty.push(text)
    },
    ...overrides,
  })
  const handleUpdate = (update: TelegramUpdate) =>
    (service._test.handleUpdate as (update: TelegramUpdate) => Promise<void>)(update)
  return {
    approvals,
    gateway,
    handleUpdate,
    orchestratorInbox,
    service,
    settings,
    taskLogs,
    writtenToPty,
  }
}

const messageUpdate = (text: string, fromId = 100): TelegramUpdate => ({
  update_id: 1,
  message: {
    chat: { id: -500, type: 'private' },
    date: Math.floor(Date.now() / 1000),
    from: { first_name: 'Tester', id: fromId, is_bot: false, username: 'tester' },
    message_id: 1,
    text,
  },
})

const pairOwner = async (ctx: ReturnType<typeof makeService>) => {
  const pairing = ctx.service.createPairingCode()
  await ctx.handleUpdate(messageUpdate(`/start ${pairing.code}`))
}

describe('telegram service', () => {
  test('pairing links the first account as owner and later accounts as viewers', async () => {
    const ctx = makeService()
    const firstPairing = ctx.service.createPairingCode()
    const secondPairing = ctx.service.createPairingCode()
    await ctx.handleUpdate(messageUpdate(`/start ${firstPairing.code}`))
    await ctx.handleUpdate(messageUpdate(`/start ${secondPairing.code}`, 200))

    expect(ctx.gateway.sent.some((m) => m.text.includes('Linked as OWNER'))).toBe(true)
    expect(ctx.gateway.sent.some((m) => m.text.includes('Linked as VIEWER'))).toBe(true)
    expect(ctx.service.listLinks().map((link) => link.role)).toEqual(['owner', 'viewer'])
  })

  test('rejects invalid pairing codes without linking anything', async () => {
    const ctx = makeService()
    await ctx.handleUpdate(messageUpdate('/start 999999'))
    expect(ctx.gateway.sent.at(-1)?.text).toContain('Invalid or expired')
    expect(ctx.service.listLinks()).toHaveLength(0)
  })

  test('plain text falls back to a status summary for linked accounts', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.gateway.sent.length = 0

    await ctx.handleUpdate(messageUpdate("What's happening?"))
    expect(ctx.gateway.sent.at(-1)?.text).toContain('Workspace Alpha:')
  })

  test('a message merely CONTAINING «задачи» is relayed, not eaten by the status filter', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.orchestratorInbox.length = 0

    await ctx.handleUpdate(messageUpdate('продолжай задачи по монтажу, финализируй ролик'))
    expect(ctx.orchestratorInbox).toHaveLength(1)
    expect(ctx.orchestratorInbox[0]).toContain('(OWNER)')
    expect(ctx.gateway.sent.at(-1)?.text).toContain('Forwarded to the orchestrator.')
  })

  test('natural-language "Create task: …" creates a ready task (spec main usage)', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.gateway.sent.length = 0

    await ctx.handleUpdate(messageUpdate('Create task: audit backend runtime'))
    const reply = ctx.gateway.sent.at(-1)?.text ?? ''
    expect(reply).toContain('Created #')
    expect(reply).toContain('audit backend runtime')
  })

  test('non-question free text is relayed into the orchestrator PTY', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.gateway.sent.length = 0

    await ctx.handleUpdate(messageUpdate('продолжай обсуждение архитектуры очереди'))
    expect(ctx.orchestratorInbox).toHaveLength(1)
    expect(ctx.orchestratorInbox[0]).toContain('(OWNER)')
    expect(ctx.orchestratorInbox[0]).toContain('@tester')
    expect(ctx.orchestratorInbox[0]).toContain('продолжай обсуждение архитектуры очереди')
    expect(ctx.gateway.sent.at(-1)?.text).toContain('Forwarded to the orchestrator.')
  })

  test('viewers cannot relay discussions — they get the status summary', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    // Second account pairs as viewer.
    const secondCode = ctx.service.createPairingCode()
    await ctx.handleUpdate(messageUpdate(`/start ${secondCode.code}`, 200))
    ctx.gateway.sent.length = 0

    await ctx.handleUpdate(messageUpdate('давайте обсудим план релиза', 200))
    expect(ctx.orchestratorInbox).toHaveLength(0)
    expect(ctx.gateway.sent.at(-1)?.text).toContain('Workspace Alpha:')
  })

  test('unlinked accounts are pointed at pairing instead of getting data', async () => {
    const ctx = makeService()
    await ctx.handleUpdate(messageUpdate('/status'))
    expect(ctx.gateway.sent.at(-1)?.text).toContain('/start')
  })

  test('approval callback decides the request, writes the PTY and journals the task', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.approvals.seed({ id: 'req-abc' })
    ctx.gateway.sent.length = 0

    const update: TelegramUpdate = {
      callback_query: {
        data: 'appr:req-abc:denied',
        from: { first_name: 'Owner', id: 100, is_bot: false, username: 'tester' },
        id: 'cq-1',
        message: { chat: { id: -500, type: 'private' }, date: 0, message_id: 2 },
      },
      update_id: 5,
    }
    await ctx.handleUpdate(update)

    const decided = ctx.approvals.get('req-abc')
    expect(decided?.status).toBe('denied')
    expect(ctx.writtenToPty[0]).toContain('permission DENIED')
    expect(ctx.writtenToPty[0]).toContain('npm install left-pad')
    expect(ctx.taskLogs[0]).toContain('[APPROVAL DENIED]')
  })

  test('notifyApproval sends an Approve/Deny keyboard to paired chats', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.gateway.sent.length = 0

    await ctx.service.notifyApproval({
      agentId: 'ws-1:worker',
      command: 'npm install left-pad',
      createdAt: Date.now(),
      decidedAt: null,
      decidedBy: null,
      dispatchId: null,
      id: 'abc-1',
      reason: 'needed for tests',
      status: 'pending',
      taskId: 'task-1',
      workspaceId: 'ws-1',
    })

    const last = ctx.gateway.sent.at(-1)
    expect(last?.text).toContain('Permission required')
    expect(last?.text).toContain('npm install left-pad')
    const keyboard = last?.keyboard as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    expect(keyboard.inline_keyboard[0].map((button) => button.callback_data)).toEqual([
      'appr:abc-1:approved',
      'appr:abc-1:denied',
    ])
  })

  test('disabled runtime swallows broadcasts silently', async () => {
    const ctx = makeService()
    await pairOwner(ctx)
    ctx.settings.setAppState('telegram_enabled', 'false')
    ctx.gateway.sent.length = 0

    await ctx.service.notifyEvent('task_failed', 'ws-1', 'TASK_FAILED: #1234 boom')
    expect(ctx.gateway.sent).toHaveLength(0)
  })

  test('a hanging chat times out, retries once and never blocks the caller (audit M-3)', async () => {
    let calls = 0
    const hangingGateway = makeGateway()
    hangingGateway.api.sendMessage = async () => {
      calls += 1
      await new Promise(() => {}) // never resolves
    }
    const settings = makeSettings()
    settings.setAppState('telegram_bot_token', 'test-token')
    settings.setAppState('telegram_enabled', 'true')
    const links = makeLinks()
    const service = createTelegramService({
      links,
      approvals: makeApprovals(),
      settings,
      createApi: () => hangingGateway.api,
      sendTimeoutMs: 40,
      sendRetryDelayMs: 10,
    })
    links.upsert({ chatId: '-500', userId: 'u1' })

    const startedAt = Date.now()
    await service.notifyEvent('task_failed', '', 'boom')
    const elapsed = Date.now() - startedAt

    // Initial attempt + single retry, then give up.
    expect(calls).toBe(2)
    expect(elapsed).toBeLessThan(2000)
  })

  test('one dead chat does not delay delivery to healthy chats', async () => {
    const mixedGateway = makeGateway()
    mixedGateway.api.sendMessage = async (chatId, text, options) => {
      if (String(chatId) === '-999') await new Promise(() => {})
      mixedGateway.sent.push({
        chatId,
        keyboard: options?.reply_markup ?? null,
        text,
      })
    }
    const settings = makeSettings()
    settings.setAppState('telegram_bot_token', 'test-token')
    settings.setAppState('telegram_enabled', 'true')
    const links = makeLinks()
    const service = createTelegramService({
      links,
      approvals: makeApprovals(),
      settings,
      createApi: () => mixedGateway.api,
      sendTimeoutMs: 60,
      sendRetryDelayMs: 10,
    })
    // The healthy chat pairs first so the dead one cannot head-of-line block it.
    links.upsert({ chatId: '-500', userId: 'fast' })
    links.upsert({ chatId: '-999', userId: 'dead' })

    const startedAt = Date.now()
    await service.notifyEvent('task_completed', '', 'ok')
    const elapsed = Date.now() - startedAt

    // The healthy chat received the message while the dead one was still
    // hanging; parallel fan-out kept the total latency bounded.
    expect(mixedGateway.sent.map((m) => String(m.chatId))).toEqual(['-500'])
    expect(elapsed).toBeLessThan(2000)
  })
})
