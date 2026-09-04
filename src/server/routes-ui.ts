import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const uiRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/session', ({ response, store }) => {
    const token = store.getUiToken()
    response.setHeader('set-cookie', `gachi_ui_token=${token}; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(response, 200, { ok: true, token })
  }),
  route('POST', '/api/ui/session/regenerate', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const token = store.regenerateUiToken()
    response.setHeader('set-cookie', `gachi_ui_token=${token}; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(response, 200, { ok: true, token })
  }),
]
