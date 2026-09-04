import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { parseTelegramRole, type TelegramRole } from './telegram-links-store.js'
import {
  TELEGRAM_EVENT_TYPES,
  type TelegramEventType,
  TelegramServiceError,
} from './telegram-service.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * Telegram interface HTTP API (spec Part 3): configuration, account pairing,
 * linked-account management and the approval inbox for the web UI.
 * All payloads are snake_case at the boundary.
 */

interface TelegramSettingsBody {
  enabled?: boolean
  token?: string | null
  events?: string[]
  /** '' → auto-detect system/env proxy, 'off' → force direct, else URL. */
  proxy_url?: string | null
  api_root?: string | null
}

const serializeLink = (link: {
  chatId: string
  userId: string
  username: string | null
  role: string
  workspaceId: string | null
  linkedAt: number
}) => ({
  chat_id: link.chatId,
  user_id: link.userId,
  username: link.username,
  role: link.role,
  workspace_id: link.workspaceId,
  linked_at: link.linkedAt,
})

export const telegramRoutes: RouteDefinition[] = [
  route('GET', '/api/settings/telegram', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, {
      config: store.getTelegramConfig(),
      links: store.listTelegramLinks().map(serializeLink),
      available_events: TELEGRAM_EVENT_TYPES,
    })
  }),
  route('POST', '/api/settings/telegram', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<TelegramSettingsBody>(request)
    const events = Array.isArray(body.events)
      ? (body.events.filter((event): event is TelegramEventType =>
          (TELEGRAM_EVENT_TYPES as readonly string[]).includes(event)
        ) as TelegramEventType[])
      : undefined
    await store.setTelegramConfig({
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.token !== undefined ? { token: body.token } : {}),
      ...(events ? { events } : {}),
      ...(body.proxy_url !== undefined ? { proxyUrl: body.proxy_url } : {}),
      ...(body.api_root !== undefined ? { apiRoot: body.api_root } : {}),
    })
    sendJson(response, 200, { ok: true, config: store.getTelegramConfig() })
  }),
  route('POST', '/api/settings/telegram/verify', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{ token?: string }>(request)
    if (!body.token?.trim()) {
      sendJson(response, 400, { error: 'Bot token is required' })
      return
    }
    try {
      const botUsername = await store.verifyTelegramToken(body.token.trim())
      sendJson(response, 200, { ok: true, bot_username: botUsername })
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Token verification failed',
      })
    }
  }),
  route('POST', '/api/settings/telegram/test', async ({ request, response, store }) => {
    // Verifies the STORED token — no input needed — so users can re-check a
    // saved configuration (the input field is cleared after saving).
    requireUiTokenFromRequest(request, store.validateUiToken)
    const result = await store.testTelegramConnection()
    if (!result.ok) {
      sendJson(response, 200, { ok: false, error: result.error })
      return
    }
    sendJson(response, 200, { ok: true, bot_username: result.botUsername })
  }),
  route('POST', '/api/settings/telegram/pairing', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const pairing = store.createTelegramPairingCode()
    sendJson(response, 201, { code: pairing.code, expires_at: pairing.expiresAt })
  }),
  route('POST', '/api/settings/telegram/links/role', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{ chat_id?: string; user_id?: string; role?: string }>(request)
    if (!body.chat_id || !body.user_id) {
      sendJson(response, 400, { error: 'chat_id and user_id are required' })
      return
    }
    const role = parseTelegramRole(body.role)
    if (!role) {
      sendJson(response, 400, { error: 'Expected role: owner | operator | viewer' })
      return
    }
    const updated = store.setTelegramLinkRole(body.chat_id, body.user_id, role as TelegramRole)
    if (!updated) {
      sendJson(response, 404, { error: 'Link not found' })
      return
    }
    sendJson(response, 200, { ok: true, link: serializeLink(updated) })
  }),
  route(
    'DELETE',
    '/api/settings/telegram/links/:userId',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const userId = getRequiredParam(response, params, 'userId', 'User id is required')
      if (!userId) return
      // chat id arrives as a query param (chat ids can be negative numbers).
      const url = new URL(request.url ?? '', 'http://127.0.0.1')
      const chatId = url.searchParams.get('chat_id') ?? ''
      if (!chatId) {
        sendJson(response, 400, { error: 'chat_id query parameter is required' })
        return
      }
      if (!store.removeTelegramLink(chatId, userId)) {
        sendJson(response, 404, { error: 'Link not found' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route('GET', '/api/workspaces/:workspaceId/approvals', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return
    requireUiTokenFromRequest(request, store.validateUiToken)
    const { pending, recent } = store.listApprovals(workspaceId)
    sendJson(response, 200, { approvals: pending, recent })
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/approvals/:requestId/decide',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and request id are required'
      )
      const requestId = getRequiredParam(
        response,
        params,
        'requestId',
        'Workspace id and request id are required'
      )
      if (!workspaceId || !requestId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ decision?: string }>(request)
      if (body.decision !== 'approved' && body.decision !== 'denied') {
        sendJson(response, 400, { error: "Expected decision: 'approved' or 'denied'" })
        return
      }
      try {
        const request = await store.decideApproval(requestId, body.decision, 'web-ui')
        if (!request) {
          sendJson(response, 409, { error: `Approval ${requestId} is not pending` })
          return
        }
        sendJson(response, 200, {
          ok: true,
          status: request.status,
          request_id: request.id,
        })
      } catch (error) {
        if (error instanceof TelegramServiceError) {
          sendJson(response, 409, { error: error.message })
          return
        }
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Failed to decide approval',
        })
      }
    }
  ),
]
