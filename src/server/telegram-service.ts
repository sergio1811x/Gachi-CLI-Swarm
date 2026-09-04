import { randomInt } from 'node:crypto'

import { dayKey } from './agent-scheduler.js'
import type { ApprovalRequest, ApprovalStore } from './approval-store.js'
import { createSecretBox, SecretBoxError } from './secret-box.js'
import type { SettingsStore } from './settings-store.js'
import { clearSystemProxyCache, detectSystemProxy } from './system-proxy.js'
import { taskStore } from './task-store.js'
import {
  createTelegramBotApi,
  type TelegramBotApi,
  type TelegramUpdate,
  type TelegramUser,
} from './telegram-bot-api.js'
import {
  roleSatisfies,
  type TelegramLink,
  type TelegramLinksStore,
  type TelegramRole,
} from './telegram-links-store.js'

/**
 * Telegram interface (spec Part 3): Telegram is a CLIENT of the orchestrator,
 * not another agent system. Messages become task operations through the same
 * runtime APIs the web UI uses; runtime events are fanned out to paired chats.
 *
 * Long polling keeps the whole thing local-first — no public URL, no webhook.
 */

const CONFIG_TOKEN_KEY = 'telegram_bot_token'
const CONFIG_ENABLED_KEY = 'telegram_enabled'
const CONFIG_EVENTS_KEY = 'telegram_events_json'
const CONFIG_BOT_USERNAME_KEY = 'telegram_bot_username'
const CONFIG_LAST_ERROR_KEY = 'telegram_last_error'
const CONFIG_PROXY_KEY = 'telegram_proxy_url' // '' → auto-detect, 'off' → disabled
const CONFIG_API_ROOT_KEY = 'telegram_api_root'

export const TELEGRAM_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'approval_required',
  'approval_decided',
  'agent_stuck',
  'agent_recovered',
  // Opt-in (Discovery spec §7): scraped context usage crossed the warning
  // threshold — the owner probably wants to know before the worker stalls.
  'usage_limit_warning',
] as const

export type TelegramEventType = (typeof TELEGRAM_EVENT_TYPES)[number]

const DEFAULT_EVENTS: readonly TelegramEventType[] = [
  'task_completed',
  'task_failed',
  'approval_required',
  'approval_decided',
  'agent_stuck',
  'agent_recovered',
]

const PAIRING_TTL_MS = 10 * 60_000
const POLL_SECONDS = 25
const ERROR_BACKOFF_MS = 3_000

/** CSI + OSC + single-char escape sequences painted by TUI CLIs. */
const ANSI_ESCAPE_RE = new RegExp(
  '\\u001b\\[[0-9;?]*[ -/]*[@-~]' + // CSI: colors, cursor moves, erase
    '|\\u001b\\].*?(?:\\u0007|\\u001b\\\\)' + // OSC: titles, hyperlinks
    '|\\u001b[@-Z\\-_]', // other single-char escapes
  'g'
)

// Bounded outbound sends (audit M-3): one slow/unreachable chat must not stall
// event fan-out for minutes, so each message races a hard timeout and retries
// once before being dropped with a log line. Both knobs are injectable for
// tests via TelegramServiceDeps.
const DEFAULT_SEND_TIMEOUT_MS = 10_000
const DEFAULT_SEND_RETRY_DELAY_MS = 750

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })

/**
 * Natural-language task creation (spec Part 3 §Main usage): the spec's example
 * is a plain sentence — "Create task: audit backend runtime" — not a command.
 */
const CREATE_TASK_INTENT_RE =
  /^(?:create(?:\s+a)?\s+task|созда(?:й|ть)\s+задачу)\s*[:\-—]?\s*(.+)$/i

/** Questions about state get a status summary ONLY when clearly anchored at
 *  the start; anything else (even containing «задачи») is RELAYED to the
 *  orchestrator — the old substring match silently swallowed real orders. */
const STATUS_QUERY_RE =
  /^(?:\/(?:status|tasks)|what'?s happening|status\b|queue\b|что происходит|статус\b|очередь\b)/i

export interface TelegramServiceDeps {
  links: TelegramLinksStore
  approvals: ApprovalStore
  settings: SettingsStore
  /** Domain ports — the same team-ops paths the HTTP routes use. */
  listWorkspaceIds?: () => string[]
  getWorkspaceName?: (workspaceId: string) => string | undefined
  listWorkers?: (workspaceId: string) => Array<{ name: string; status: string }>
  cancelTaskById?: (workspaceId: string, taskId: string) => boolean
  /** Relays free-form user text into the orchestrator PTY. Returns `true` only
   * when the payload was actually written; `false`/undefined (legacy) means
   * delivery could not be confirmed — the service queues and retries.
   */
  sendToOrchestrator?: (workspaceId: string, text: string) => boolean
  /**
   * T1 morning digest: composes the 24h summary (done/failed, tokens,
   * [STALL]/[RISK], commits). Called at most once per calendar day.
   */
  getDailyDigest?: () => Promise<string> | string
  writeRunInput?: (runId: string, text: string) => void
  getActiveRunByAgentId?: (workspaceId: string, agentId: string) => { runId: string } | undefined
  addTaskLog?: (workspaceId: string, taskId: string, message: string) => void
  /** Hard per-message send timeout (default 10s — audit M-3). */
  sendTimeoutMs?: number
  /** Delay before the single retry of a failed send (default 750ms). */
  sendRetryDelayMs?: number
  /** Override for tests (fake gateway). */
  createApi?: (token: string) => TelegramBotApi
}

export interface TelegramConfig {
  enabled: boolean
  tokenSet: boolean
  botUsername: string | null
  events: TelegramEventType[]
  /** Last polling/connection error, persisted so the UI can show WHY it is down. */
  lastError: string | null
  /**
   * Effective proxy URL in use (credentials masked), or null when connecting
   * directly. `telegram_proxy_url` setting: '' → auto (system/env), 'off' →
   * force direct, otherwise the URL.
   */
  proxy: string | null
  apiRoot: string
}

interface PairingCode {
  code: string
  expiresAt: number
}

const shortId = (id: string): string => id.slice(0, 8)

export class TelegramServiceError extends Error {}

const maskProxy = (url: string): string => url.replace(/^(https?:\/\/)([^@/]+)@/, '$1***@')

export const createTelegramService = (deps: TelegramServiceDeps) => {
  const { settings, links, approvals } = deps
  let pairingCodes = new Map<string, PairingCode>()
  let running = false
  let offset = 0

  // Stability: messages for a temporarily offline orchestrator are queued
  // per workspace (bounded) and re-injected on every loop tick until the PTY
  // accepts them — a typed order must never vanish with a fake "Forwarded".
  const RELAY_QUEUE_CAP = 30
  const pendingRelay = new Map<string, Array<{ chatId: string | number; text: string }>>()

  const enqueueRelay = (workspaceId: string, chatId: string | number, text: string): number => {
    const queue = pendingRelay.get(workspaceId) ?? []
    if (queue.length >= RELAY_QUEUE_CAP) {
      const dropped = queue.shift()
      console.warn(
        `[TELEGRAM] relay queue full for ${shortId(workspaceId)} — dropped oldest: ${dropped?.text.slice(0, 60)}...`
      )
    }
    queue.push({ chatId, text })
    pendingRelay.set(workspaceId, queue)
    return queue.length
  }

  /** Returns the number of messages delivered on this pass. */
  const flushPendingRelay = async (): Promise<number> => {
    let delivered = 0
    for (const [workspaceId, queue] of [...pendingRelay]) {
      let lastChatId: string | number | null = null
      while (queue.length > 0) {
        const head = queue[0] as { chatId: string | number; text: string }
        lastChatId = head.chatId
        let ok = false
        try {
          ok = deps.sendToOrchestrator?.(workspaceId, head.text) !== false
        } catch {
          ok = false
        }
        if (!ok) break
        queue.shift()
        delivered += 1
      }
      if (queue.length === 0) {
        pendingRelay.delete(workspaceId)
        if (lastChatId !== null && delivered > 0) {
          try {
            const token = await getStoredToken()
            if (token) {
              await apiFor(token).sendMessage(
                lastChatId,
                '✅ Orchestrator is back — all queued messages were delivered.'
              )
            }
          } catch {}
        }
      } else {
        pendingRelay.set(workspaceId, queue)
      }
    }
    return delivered
  }

  // T1 morning digest: at most one per calendar day, at/after `HH:MM` local.
  const CONFIG_DIGEST_AT_KEY = 'telegram_digest_at'
  const CONFIG_DIGEST_LASTDAY_KEY = 'telegram_digest_lastday'

  const maybeSendDigest = async (now = Date.now()): Promise<boolean> => {
    const at = settings.getAppState(CONFIG_DIGEST_AT_KEY)?.value?.trim() ?? ''
    if (!/^\d{2}:\d{2}$/.test(at)) return false
    const todayKey = dayKey(now)
    if (settings.getAppState(CONFIG_DIGEST_LASTDAY_KEY)?.value === todayKey) return false
    const [hh, mm] = at.split(':').map((part) => Number(part))
    const scheduledAt = new Date(now)
    scheduledAt.setHours(hh ?? 0, mm ?? 0, 0, 0)
    if (now < scheduledAt.getTime()) return false

    const body = await deps.getDailyDigest?.()
    if (!body) return false
    const delivered = await broadcast(`🌅 Daily digest (${todayKey})\n\n${body}`, {
      requireRole: 'viewer',
    })
    settings.setAppState(CONFIG_DIGEST_LASTDAY_KEY, todayKey)
    console.log(`[TELEGRAM] daily digest sent to ${delivered} chat(s)`)
    return delivered > 0
  }

  const secrets = createSecretBox()

  // The token is stored sealed (DPAPI on Windows — audit M-2). Reads decode
  // through an async cache keyed by the raw stored value so the long-poll loop
  // and command handlers share one decryption; saving a new token invalidates.
  let tokenCache: { raw: string | null; value: string | null } | null = null

  const getStoredTokenRaw = (): string | null =>
    settings.getAppState(CONFIG_TOKEN_KEY)?.value ?? null

  const getStoredToken = async (): Promise<string | null> => {
    const raw = getStoredTokenRaw()
    if (!raw) return null
    if (!secrets.isSealed(raw)) return raw
    if (tokenCache?.raw === raw) return tokenCache.value
    try {
      const value = await secrets.open(raw)
      tokenCache = { raw, value }
      return value
    } catch (error) {
      if (error instanceof SecretBoxError) {
        console.error('[TELEGRAM] failed to unseal bot token:', error.message)
      }
      return raw
    }
  }

  const isEnabled = (): boolean => settings.getAppState(CONFIG_ENABLED_KEY)?.value === 'true'

  const getEvents = (): TelegramEventType[] => {
    const raw = settings.getAppState(CONFIG_EVENTS_KEY)?.value
    if (!raw) return [...DEFAULT_EVENTS]
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return [...DEFAULT_EVENTS]
      return parsed.filter((item): item is TelegramEventType =>
        (TELEGRAM_EVENT_TYPES as readonly string[]).includes(item as string)
      )
    } catch {
      return [...DEFAULT_EVENTS]
    }
  }

  // Connection options (explicit setting → 'off' → system/env auto-detect),
  // resolved asynchronously and cached synchronously so every call site stays
  // sync. Refreshed at startup, on each loop tick and after config changes —
  // a stale value costs at most one polling cycle.
  let connOpts: { apiRoot?: string | undefined; proxyUrl: string | null } = {
    apiRoot: undefined,
    proxyUrl: null,
  }
  const refreshConnOpts = async (): Promise<void> => {
    clearSystemProxyCache()
    const rawProxy = settings.getAppState(CONFIG_PROXY_KEY)?.value ?? ''
    const apiRoot = settings.getAppState(CONFIG_API_ROOT_KEY)?.value ?? ''
    if (rawProxy === 'off') {
      connOpts = { apiRoot: apiRoot || undefined, proxyUrl: null }
      return
    }
    const detected = await detectSystemProxy()
    connOpts = {
      apiRoot: apiRoot || undefined,
      proxyUrl: rawProxy || detected.url || null,
    }
  }
  void refreshConnOpts()

  const apiForBase = (token: string): TelegramBotApi =>
    deps.createApi
      ? deps.createApi(token)
      : createTelegramBotApi({
          token,
          ...(connOpts.apiRoot ? { apiRoot: connOpts.apiRoot } : {}),
          proxyUrl: connOpts.proxyUrl,
        })
  const apiFor = apiForBase

  const broadcast = async (
    text: string,
    options?: {
      workspaceId?: string
      requireRole?: TelegramRole
      keyboard?: Parameters<TelegramBotApi['sendMessage']>[2]
    }
  ): Promise<number> => {
    const token = await getStoredToken()
    if (!token || !isEnabled()) return 0
    const api = apiFor(token)
    const recipients = links
      .list()
      .filter(
        (link) =>
          (!options?.workspaceId ||
            link.workspaceId === null ||
            link.workspaceId === options.workspaceId) &&
          (!options?.requireRole || roleSatisfies(link.role, options.requireRole))
      )
    let sent = 0
    const sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
    const retryDelayMs = deps.sendRetryDelayMs ?? DEFAULT_SEND_RETRY_DELAY_MS
    // Chats are independent: fan out in parallel so a dead chat cannot delay
    // the others (audit M-3).
    const results = await Promise.allSettled(
      recipients.map(async (link) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await withTimeout(
              api.sendMessage(link.chatId, text, options?.keyboard),
              sendTimeoutMs,
              'telegram sendMessage'
            )
            return true
          } catch (error) {
            if (attempt === 1) {
              console.error(
                `[TELEGRAM] send to ${link.chatId} failed:`,
                error instanceof Error ? error.message : error
              )
              return false
            }
            await delay(retryDelayMs)
          }
        }
        return false
      })
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) sent += 1
    }
    return sent
  }

  const resolveWorkspaceId = (linkWorkspaceId: string | null): string | undefined => {
    if (linkWorkspaceId && deps.getWorkspaceName?.(linkWorkspaceId) !== undefined) {
      return linkWorkspaceId
    }
    return deps.listWorkspaceIds?.()[0]
  }

  const formatStatus = (): string => {
    const lines: string[] = []
    for (const workspaceId of deps.listWorkspaceIds?.() ?? []) {
      const name = deps.getWorkspaceName?.(workspaceId) ?? workspaceId
      const tasks = taskStore.listTasks(workspaceId)
      const active = tasks.filter((t) =>
        ['assigned', 'claimed', 'running', 'review'].includes(t.status)
      )
      lines.push(`Workspace ${name}:`)
      if (active.length === 0) {
        lines.push('  No active tasks.')
      }
      for (const task of active) {
        const worker = task.assignedAgentId ? ` (@${shortId(task.assignedAgentId)})` : ''
        lines.push(`  #${shortId(task.id)} [${task.status}]${worker} ${task.title}`)
      }
      const pendingApprovals = approvals.listPending(workspaceId)
      if (pendingApprovals.length > 0) {
        lines.push(`  Approvals waiting: ${pendingApprovals.length}`)
      }
      const queued = pendingRelay.get(workspaceId)?.length ?? 0
      if (queued > 0) {
        lines.push(`  ⏳ Messages queued for the orchestrator: ${queued}`)
      }
    }
    return lines.length > 0 ? lines.join('\n') : 'No workspaces.'
  }

  const formatWorkers = (): string => {
    const lines: string[] = []
    for (const workspaceId of deps.listWorkspaceIds?.() ?? []) {
      const name = deps.getWorkspaceName?.(workspaceId) ?? workspaceId
      lines.push(`Workspace ${name}:`)
      for (const agent of deps.listWorkers?.(workspaceId) ?? []) {
        lines.push(`  @${agent.name}: ${agent.status}`)
      }
    }
    return lines.join('\n')
  }

  const decideApprovalInternal = async (
    requestId: string,
    decision: 'approved' | 'denied',
    actor: string
  ): Promise<ApprovalRequest> => {
    const request = approvals.decide(requestId, decision, actor)
    if (!request) {
      throw new TelegramServiceError(`Approval ${shortId(requestId)} is not pending`)
    }

    // Deliver the verdict into the waiting worker's PTY and the task journal.
    const run =
      request.agentId && deps.getActiveRunByAgentId
        ? deps.getActiveRunByAgentId(request.workspaceId, request.agentId)
        : undefined
    const verdictLine = `[Gachi system message: permission ${decision.toUpperCase()}] command: ${request.command}${
      request.reason ? ` (reason: ${request.reason})` : ''
    }`
    if (run && deps.writeRunInput) {
      try {
        deps.writeRunInput(run.runId, `${verdictLine}\n`)
      } catch (error) {
        console.error(
          '[TELEGRAM] approval PTY write failed:',
          error instanceof Error ? error.message : error
        )
      }
    }
    if (request.taskId && deps.addTaskLog) {
      try {
        deps.addTaskLog(
          request.workspaceId,
          request.taskId,
          `[APPROVAL ${decision.toUpperCase()}] ${request.command} — by ${actor}`
        )
      } catch {
        // Journal entry is best-effort; the durable decision is already stored.
      }
    }

    await broadcast(
      `${decision === 'approved' ? '✅ Approved' : '⛔️ Denied'}: \`${request.command}\` (${shortId(request.id)}) by ${actor}`,
      { workspaceId: request.workspaceId, requireRole: 'viewer' }
    ).catch(() => 0)

    return request
  }

  const handleCommandMessage = async (
    text: string,
    from: TelegramUser,
    chatId: number | string
  ) => {
    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()

    // Pairing works before any link exists.
    if (lower.startsWith('/start')) {
      const code = trimmed.slice('/start'.length).trim()
      const entry = code ? pairingCodes.get(code) : undefined
      if (!entry || entry.expiresAt < Date.now()) {
        pairingCodes.delete(code)
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          'Invalid or expired pairing code. Generate a new one in the Gachi UI.'
        )
        return
      }
      pairingCodes.delete(code)
      // Owner heals automatically: if NO owner exists yet, this account gets
      // promoted — protects against stale rows blocking the real user.
      const hasOwner = links.list().some((item) => item.role === 'owner')
      const link = links.upsert({
        chatId: String(chatId),
        userId: String(from.id),
        username: from.username ?? null,
        role: hasOwner ? 'viewer' : 'owner',
      })
      await apiFor((await getStoredToken()) ?? '').sendMessage(
        chatId,
        `Linked as ${link.role.toUpperCase()}. You will receive workspace notifications here.` +
          (link.role === 'viewer'
            ? ' Ask an owner to promote you via the web panel if needed.'
            : '')
      )
      return
    }

    const link = links.get(String(chatId), String(from.id))
    if (!link) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(
        chatId,
        'This account is not linked. Use /start <pairing-code> from the Gachi UI.'
      )
      return
    }

    if (lower.startsWith('/help') || trimmed === '') {
      await apiFor((await getStoredToken()) ?? '').sendMessage(
        chatId,
        [
          '/status — what is happening',
          '/tasks — list active tasks',
          '/workers — worker statuses',
          '/create <title> — create a task (operator+)',
          '/stop <task-id> — cancel a task (operator+)',
          '/approve <id> / /deny <id> — answer permission requests (operator+)',
          '/help — this text',
        ].join('\n')
      )
      return
    }

    if (lower.startsWith('/tasks') || lower.startsWith('/status')) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, formatStatus())
      return
    }

    if (lower.startsWith('/workers')) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, formatWorkers())
      return
    }

    if (lower.startsWith('/create')) {
      const title = trimmed.slice('/create'.length).trim()
      await createTaskFromChat(chatId, link, title, 'Usage: /create <task title>')
      return
    }

    if (lower.startsWith('/stop')) {
      if (!roleSatisfies(link.role, 'operator')) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, 'Operator role required.')
        return
      }
      const taskId = trimmed.slice('/stop'.length).trim().split(/\s+/)[0]
      if (!taskId) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, 'Usage: /stop <task-id>')
        return
      }
      const workspaceId = resolveWorkspaceId(link.workspaceId)
      const full = workspaceId ? findTaskId(workspaceId, taskId) : undefined
      if (!workspaceId || !full || !deps.cancelTaskById?.(workspaceId, full)) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          `Task ${taskId} not found or cannot be canceled.`
        )
        return
      }
      await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, `Canceled #${taskId}.`)
      return
    }

    if (lower.startsWith('/approve') || lower.startsWith('/deny')) {
      if (!roleSatisfies(link.role, 'operator')) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, 'Operator role required.')
        return
      }
      const parts = trimmed.split(/\s+/)
      const requestId = parts[1]
      if (!requestId) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          `Usage: ${parts[0]} <request-id>`
        )
        return
      }
      const pending = approvals.listPending().find((item) => item.id.startsWith(requestId))
      if (!pending) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          `Pending request ${requestId} not found.`
        )
        return
      }
      try {
        await decideApprovalInternal(
          pending.id,
          lower.startsWith('/approve') ? 'approved' : 'denied',
          `@${from.username ?? from.id}`
        )
      } catch (error) {
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          error instanceof Error ? error.message : 'Failed to decide approval.'
        )
      }
      return
    }

    if (trimmed.startsWith('/')) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(
        chatId,
        'Unknown command. Try /help.'
      )
      return
    }

    // Free text: route by intent (spec Part 3 §Main usage / §Task management).
    const createIntent = CREATE_TASK_INTENT_RE.exec(trimmed)
    if (createIntent) {
      await createTaskFromChat(chatId, link, createIntent[1]?.trim() ?? '', undefined)
      return
    }

    const workspaceId = resolveWorkspaceId(link.workspaceId)
    const isStatusQuery = STATUS_QUERY_RE.test(trimmed)
    if (!isStatusQuery && roleSatisfies(link.role, 'operator')) {
      // "Continue discussions": relay into the orchestrator's PTY. Delivery
      // failures surface back to the chat instead of vanishing.
      if (workspaceId && deps.sendToOrchestrator) {
        // Role travels with the message so the orchestrator can tell an
        // authorized order from a stranger's note (it previously refused
        // @lzrksa as "посторонний аккаунт").
        const roleTag =
          link.role === 'owner' ? ' (OWNER)' : link.role === 'operator' ? ' (OPERATOR)' : ''
        const payload = `[Telegram @${from.username ?? from.id}${roleTag}]: ${trimmed}`
        let delivered = false
        try {
          delivered = deps.sendToOrchestrator(workspaceId, payload) !== false
        } catch (error) {
          await apiFor((await getStoredToken()) ?? '').sendMessage(
            chatId,
            `⚠️ Not delivered: ${error instanceof Error ? error.message : String(error)}`
          )
          return
        }
        if (!delivered) {
          // Orchestrator PTY is not writable — queue instead of lying.
          const pending = enqueueRelay(workspaceId, chatId, payload)
          await apiFor((await getStoredToken()) ?? '').sendMessage(
            chatId,
            `⏳ The orchestrator is not running right now — your message is queued (${pending} pending) and will be delivered automatically.`
          )
          return
        }
        await apiFor((await getStoredToken()) ?? '').sendMessage(
          chatId,
          'Forwarded to the orchestrator.'
        )
        return
      }
    }
    await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, formatStatus())
  }

  const createTaskFromChat = async (
    chatId: number | string,
    link: TelegramLink,
    title: string,
    usageHint?: string
  ): Promise<void> => {
    if (!roleSatisfies(link.role, 'operator')) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, 'Operator role required.')
      return
    }
    if (!title) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(
        chatId,
        usageHint ?? 'Task title is required.'
      )
      return
    }
    const workspaceId = resolveWorkspaceId(link.workspaceId)
    if (!workspaceId) {
      await apiFor((await getStoredToken()) ?? '').sendMessage(chatId, 'No workspace available.')
      return
    }
    const created = taskStore.createTask(workspaceId, { status: 'ready', title })
    await apiFor((await getStoredToken()) ?? '').sendMessage(
      chatId,
      `Created #${shortId(created.id)} "${created.title}" (ready).`
    )
  }

  const findTaskId = (workspaceId: string, prefix: string): string | undefined => {
    const exact = taskStore.getTask(workspaceId, prefix)
    if (exact) return exact.id
    return taskStore.listTasks(workspaceId).find((task) => task.id.startsWith(prefix))?.id
  }

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    if (update.callback_query) {
      const query = update.callback_query
      const data = query.data ?? ''
      const [, requestId, decision] = data.split(':')
      const link = links.get(String(query.message?.chat.id ?? ''), String(query.from.id))
      try {
        if (!link || !roleSatisfies(link.role, 'operator')) {
          throw new TelegramServiceError('Operator role required.')
        }
        if (!requestId || (decision !== 'approved' && decision !== 'denied')) {
          throw new TelegramServiceError('Malformed approval callback.')
        }
        await decideApprovalInternal(
          requestId,
          decision,
          `@${query.from.username ?? query.from.id}`
        )
        await apiFor((await getStoredToken()) ?? '').answerCallbackQuery(
          query.id,
          `Request ${decision}.`
        )
      } catch (error) {
        await apiFor((await getStoredToken()) ?? '').answerCallbackQuery(
          query.id,
          error instanceof Error ? error.message : 'Failed.'
        )
      }
      return
    }

    const message = update.message
    if (!message?.text) return
    await handleCommandMessage(
      message.text,
      message.from ?? { id: message.chat.id, is_bot: false },
      message.chat.id
    )
  }

  const loop = async (): Promise<void> => {
    // Stability: exponential backoff on consecutive polling errors so a long
    // outage neither hammers the API nor floods logs; resets on success.
    let errorBackoffMs = ERROR_BACKOFF_MS
    while (running) {
      void refreshConnOpts()
      const token = await getStoredToken()
      if (!token || !isEnabled()) {
        await sleep(2000)
        continue
      }
      // Deliver anything queued while the orchestrator was offline.
      try {
        await flushPendingRelay()
      } catch {}
      // T1 morning digest — at most once per day, right after the configured
      // time; a missed slot fires on the first tick after boot (same day).
      try {
        await maybeSendDigest()
      } catch {}
      try {
        const updates = await apiFor(token).getUpdates(offset, POLL_SECONDS)
        errorBackoffMs = ERROR_BACKOFF_MS
        // A successful long poll means token + network are healthy again.
        if (settings.getAppState(CONFIG_LAST_ERROR_KEY)?.value) {
          settings.setAppState(CONFIG_LAST_ERROR_KEY, null)
        }
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1)
          try {
            await handleUpdate(update)
          } catch (error) {
            console.error(
              '[TELEGRAM] update handling failed:',
              error instanceof Error ? error.message : error
            )
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[TELEGRAM] polling error:', message)
        settings.setAppState(CONFIG_LAST_ERROR_KEY, message.slice(0, 300))
        if (message.includes('409')) {
          // Another getUpdates consumer is fighting us for the token.
          await sleep(15_000)
          continue
        }
        await sleep(errorBackoffMs)
        errorBackoffMs = Math.min(errorBackoffMs * 2, 30_000)
      }
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    getConfig(): TelegramConfig {
      return {
        enabled: isEnabled(),
        events: getEvents(),
        tokenSet: Boolean(getStoredTokenRaw()),
        botUsername: settings.getAppState(CONFIG_BOT_USERNAME_KEY)?.value ?? null,
        lastError: settings.getAppState(CONFIG_LAST_ERROR_KEY)?.value ?? null,
        proxy: connOpts.proxyUrl ? maskProxy(connOpts.proxyUrl) : null,
        apiRoot: connOpts.apiRoot ?? 'https://api.telegram.org',
      }
    },

    async setConfig(input: {
      enabled?: boolean
      token?: string | null
      events?: TelegramEventType[]
      /** '' → auto-detect, 'off' → direct, otherwise proxy URL. */
      proxyUrl?: string | null
      apiRoot?: string | null
    }): Promise<void> {
      if (input.token !== undefined) {
        const trimmed = input.token?.trim() ? input.token.trim() : null
        // Store sealed (DPAPI on Windows, explicit envelope elsewhere — M-2).
        const stored = trimmed ? await secrets.seal(trimmed) : null
        settings.setAppState(CONFIG_TOKEN_KEY, stored)
        tokenCache = null
        // A new token may be a different bot: drop stale identity/error state.
        if (trimmed) {
          settings.setAppState(CONFIG_BOT_USERNAME_KEY, null)
        }
        settings.setAppState(CONFIG_LAST_ERROR_KEY, null)
      }
      if (input.enabled !== undefined) {
        settings.setAppState(CONFIG_ENABLED_KEY, input.enabled ? 'true' : 'false')
      }
      if (input.events !== undefined) {
        const valid = input.events.filter((event): event is TelegramEventType =>
          (TELEGRAM_EVENT_TYPES as readonly string[]).includes(event)
        )
        settings.setAppState(CONFIG_EVENTS_KEY, JSON.stringify(valid))
      }
      if (input.proxyUrl !== undefined) {
        const trimmed = input.proxyUrl?.trim() ? input.proxyUrl.trim() : ''
        settings.setAppState(CONFIG_PROXY_KEY, trimmed)
      }
      if (input.apiRoot !== undefined) {
        const trimmed = input.apiRoot?.trim() ? input.apiRoot.trim() : null
        settings.setAppState(CONFIG_API_ROOT_KEY, trimmed)
      }
      await refreshConnOpts()
    },

    async verifyToken(token: string): Promise<string> {
      const me = await apiFor(token).getMe()
      const username = me.username ? `@${me.username}` : String(me.id)
      settings.setAppState(CONFIG_BOT_USERNAME_KEY, username)
      return username
    },

    /**
     * Verifies the STORED token (no input required) so the user can check the
     * saved configuration any time; persists the bot identity on success.
     */
    async testConnection(): Promise<
      { ok: true; botUsername: string } | { ok: false; error: string }
    > {
      const token = await getStoredToken()
      if (!token) return { ok: false, error: 'Token is not configured' }
      try {
        const me = await apiFor(token).getMe()
        const username = me.username ? `@${me.username}` : String(me.id)
        settings.setAppState(CONFIG_BOT_USERNAME_KEY, username)
        settings.setAppState(CONFIG_LAST_ERROR_KEY, null)
        return { ok: true, botUsername: username }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        settings.setAppState(CONFIG_LAST_ERROR_KEY, message.slice(0, 300))
        return { ok: false, error: message }
      }
    },

    createPairingCode(): PairingCode {
      const entry: PairingCode = {
        // Presenting this code grants owner control of the bot — it must come
        // from a CSPRNG, not Math.random().
        code: String(randomInt(100_000, 1_000_000)),
        expiresAt: Date.now() + PAIRING_TTL_MS,
      }
      pairingCodes.set(entry.code, entry)
      // Bound the map: drop expired codes opportunistically.
      for (const [code, value] of pairingCodes) {
        if (value.expiresAt < Date.now()) pairingCodes.delete(code)
      }
      return entry
    },

    listLinks() {
      return links.list()
    },

    removeLink(chatId: string, userId: string): boolean {
      return links.remove(chatId, userId)
    },

    setLinkRole(chatId: string, userId: string, role: TelegramRole) {
      const existing = links.get(chatId, userId)
      if (!existing) return undefined
      return links.upsert({
        chatId,
        userId,
        username: existing.username,
        role,
        workspaceId: existing.workspaceId,
      })
    },

    start(): void {
      if (running) return
      running = true
      void loop()
    },

    stop(): void {
      running = false
      pairingCodes = new Map()
    },

    /** Push a new permission request to operator chats with Approve/Deny buttons. */
    async notifyApproval(request: ApprovalRequest): Promise<void> {
      if (!getEvents().includes('approval_required')) return
      const text = [
        '⚠️ Permission required',
        `Agent: @${shortId(request.agentId)}`,
        `Command: ${request.command}`,
        request.reason ? `Reason: ${request.reason}` : undefined,
        `Request: ${shortId(request.id)}`,
        'Reply /approve <id> or /deny <id>, or use the buttons.',
      ]
        .filter(Boolean)
        .join('\n')
      await broadcast(text, {
        keyboard: {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `appr:${request.id}:approved` },
                { text: '⛔️ Deny', callback_data: `appr:${request.id}:denied` },
              ],
            ],
          },
        },
        requireRole: 'viewer',
        workspaceId: request.workspaceId,
      })
    },

    /** Runtime event fan-out (spec Part 3 §Event integration). */
    async notifyEvent(type: TelegramEventType, workspaceId: string, text: string): Promise<void> {
      if (!getEvents().includes(type)) return
      await broadcast(text, { workspaceId, requireRole: 'viewer' })
    },

    /**
     * Direct orchestrator → chat reply ([TG_REPLY] bridge). Not gated by the
     * event preferences: a user asking the orchestrator something in Telegram
     * must always get the answer back, regardless of which notifications are
     * enabled.
     */
    async notifyOrchestratorReply(text: string): Promise<void> {
      if (!text) return
      await broadcast(`💬 ${text}`, { requireRole: 'viewer' })
    },

    decideApproval: decideApprovalInternal,

    _test: {
      handleUpdate,
      handleCommandMessage,
      resolveWorkspaceId,
      flushPendingRelay,
      maybeSendDigest,
    },
  }
}

export type TelegramService = ReturnType<typeof createTelegramService>

/**
 * Line-buffer bridge for the orchestrator → Telegram reply channel: the PTY
 * stream arrives in arbitrary chunks, so `[TG_REPLY] …` lines must be
 * assembled before matching. Non-matching lines are dropped silently.
 *
 * TUI repaint dedup: Claude Code keeps repainting the whole screen while its
 * spinner runs, so an already-delivered `[TG_REPLY]` line reappears many
 * times — often mangled by the narrow terminal: spaces dropped, letters
 * lost mid-word, tails truncated. Exact/prefix comparison cannot catch
 * those, so suppression uses fuzzy character-trigram similarity (Dice
 * coefficient): a repaint of the same reply scores ≥0.75 against the
 * delivered original and is dropped; a genuinely new answer scores far
 * lower. Each suppressed echo refreshes the entry timestamp, so a repaint
 * storm never outlives the window.
 */

const REPLY_DEDUPE_WINDOW_MS = 90_000
const REPLY_DEDUPE_MAX = 8
/** Containment above which a payload counts as a repaint duplicate.
 * Measured on real Claude Code repaint garbage: truncated/glued/mangled
 * variants score 0.64–1.0 against the original, distinct replies ≤0.2. */
const REPLY_SIMILARITY_THRESHOLD = 0.5
/** Below this length only exact matches are deduped (trigrams too coarse). */
const REPLY_FUZZY_MIN_CHARS = 12

export interface TgReplyForwarderOptions {
  /** Suppression window for TUI-repaint duplicates. 0 disables dedup. */
  dedupeWindowMs?: number
}

const normalizeReply = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

const trigrams = (normalized: string): Set<string> => {
  if (normalized.length < 3) return new Set([normalized])
  const set = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i += 1) set.add(normalized.slice(i, i + 3))
  return set
}

/** Trigram containment: fraction of the smaller set covered by the larger.
 * Unlike Dice it does not penalize length differences, which is exactly the
 * repaint case (a truncated echo of a long reply). */
const trigramContainment = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const gram of small) if (large.has(gram)) intersection += 1
  return intersection / small.size
}

export const createTgReplyLineForwarder = (
  onMessage: (text: string) => void,
  maxBufferChars = 64_000,
  options: TgReplyForwarderOptions = {}
): ((chunk: string) => void) => {
  const dedupeWindowMs = options.dedupeWindowMs ?? REPLY_DEDUPE_WINDOW_MS
  let buffer = ''
  const recentReplies: Array<{ key: string; grams: Set<string>; at: number }> = []

  const emitReply = (payload: string): void => {
    const key = normalizeReply(payload)
    const now = Date.now()
    if (dedupeWindowMs > 0) {
      const grams = key.length >= REPLY_FUZZY_MIN_CHARS ? trigrams(key) : null
      let duplicate = false
      for (const entry of recentReplies) {
        if (now - entry.at > dedupeWindowMs) continue
        if (
          entry.key === key ||
          (grams && trigramContainment(grams, entry.grams) >= REPLY_SIMILARITY_THRESHOLD)
        ) {
          // Repaint echo: refresh so an ongoing storm stays suppressed.
          entry.at = now
          duplicate = true
          break
        }
      }
      if (duplicate) return
      recentReplies.push({ key, grams: grams ?? trigrams(key), at: now })
      if (recentReplies.length > REPLY_DEDUPE_MAX) recentReplies.shift()
    }
    try {
      onMessage(payload.trim())
    } catch {
      // A failing consumer must not wedge the PTY stream bridge.
    }
  }

  const handleRawLine = (rawLine: string): void => {
    // Within one line the last carriage return wins: a bare \r is a TUI
    // cursor rewind (spinner repaint), so everything before it was
    // overwritten on the terminal. Deleting \r outright glued the repaint
    // onto the stale prefix, and since the tag is matched anywhere, the
    // first [TG_REPLY] then spanned the glued garbage.
    // TUIs (Claude Code) also paint the line with ANSI colors and a leading
    // bullet ("● [TG_REPLY] …"), so decoration must be stripped and the
    // tag matched anywhere in the line — anchoring at ^ silently drops
    // every real-world reply.
    const line = rawLine
      .slice(rawLine.lastIndexOf('\r') + 1)
      .replace(ANSI_ESCAPE_RE, '')
      .replace(/^\s*[●•*>·]+\s*/, '')
      .trim()
    const match = /\[TG_REPLY\]\s*(.+)$/i.exec(line)
    const payload = match?.[1]
    if (payload) {
      emitReply(payload)
    }
  }

  return (chunk: string) => {
    // Normalize CRLF first: \r\n is just a line break, while a bare \r is a
    // repaint rewind that must not be glued into the previous line.
    buffer += chunk.replace(/\r\n/g, '\n')
    if (buffer.length > maxBufferChars) buffer = buffer.slice(-maxBufferChars)
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      handleRawLine(rawLine)
      newlineIndex = buffer.indexOf('\n')
    }
    // The unterminated tail is a partial line: a trailing bare \r means the
    // TUI is repainting it, so everything before the rewind is stale.
    const lastCr = buffer.lastIndexOf('\r')
    if (lastCr !== -1) buffer = buffer.slice(lastCr + 1)
  }
}
