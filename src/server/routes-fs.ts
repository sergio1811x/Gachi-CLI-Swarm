import { browseDirectory, probeDirectory, resolveFolderByName } from './fs-browse.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const readPathParam = (request: { url?: string | undefined }): string => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  return url.searchParams.get('path') ?? ''
}

export const fsRoutes: RouteDefinition[] = [
  route('GET', '/api/fs/browse', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await browseDirectory(readPathParam(request))
    sendJson(response, body.ok ? 200 : 400, body)
  }),
  route('GET', '/api/fs/probe', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await probeDirectory(readPathParam(request))
    sendJson(response, 200, body)
  }),
  route('POST', '/api/fs/pick-folder', async ({ pickFolderService, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await pickFolderService()
    sendJson(response, 200, body)
  }),
  route('POST', '/api/fs/resolve-folder', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<{ name?: string }>(request)
    const result = await resolveFolderByName(body.name ?? '')
    if (result.path) {
      sendJson(response, 200, result)
      return
    }
    if (result.matches.length > 0) {
      sendJson(response, 200, result)
      return
    }
    sendJson(response, 404, result)
  }),
]
