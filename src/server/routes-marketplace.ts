import {
  isMarketplaceLanguage,
  loadManifest,
  MarketplaceNotFoundError,
  readAgent,
} from './marketplace-store.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const readLanguageParam = (request: { url?: string | undefined }) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('lang')
}

const readPathParam = (request: { url?: string | undefined }) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('path') ?? ''
}

export const marketplaceRoutes: RouteDefinition[] = [
  route('GET', '/api/marketplace/manifest', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const lang = readLanguageParam(request)
    if (!isMarketplaceLanguage(lang)) {
      sendJson(response, 400, { error: 'Invalid or missing lang parameter (expected en|zh)' })
      return
    }
    try {
      sendJson(response, 200, loadManifest(lang))
    } catch (error) {
      if (error instanceof MarketplaceNotFoundError) {
        sendJson(response, 404, { error: error.message })
        return
      }
      throw error
    }
  }),
  route('GET', '/api/marketplace/agent', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const lang = readLanguageParam(request)
    if (!isMarketplaceLanguage(lang)) {
      sendJson(response, 400, { error: 'Invalid or missing lang parameter (expected en|zh)' })
      return
    }
    const relativePath = readPathParam(request)
    if (!relativePath) {
      sendJson(response, 400, { error: 'Missing path parameter' })
      return
    }
    try {
      sendJson(response, 200, readAgent(lang, relativePath))
    } catch (error) {
      if (error instanceof MarketplaceNotFoundError) {
        sendJson(response, 404, { error: error.message })
        return
      }
      throw error
    }
  }),
]
