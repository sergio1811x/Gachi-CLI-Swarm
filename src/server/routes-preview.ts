import { DEFAULT_PREVIEW_PORTS, discoverPreviewServers } from './preview-discovery.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * Dev-server preview (roadmap Wave 2): discover live HTTP servers on the
 * runtime host so the UI can open QA previews in one click. Probing hits
 * real sockets — tests pass an explicit `ports` list with a server they
 * control (real-boundary coverage without injection plumbing).
 */

const DEFAULT_TIMEOUT_MS = 400

const parsePortList = (raw: string | null): number[] | undefined => {
  if (!raw) return undefined
  const ports = raw
    .split(',')
    .map((part) => Number.parseInt(part, 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536)
  return ports.length > 0 ? ports : undefined
}

export const previewRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/preview/discover',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      try {
        store.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const requestedPorts = parsePortList(url.searchParams.get('ports'))

      // Preferred ports remembered per workspace in app-state.
      let preferred: number[] | undefined
      const savedRaw = store.settings.getAppState(`preview_ports_${workspaceId}`)?.value
      if (typeof savedRaw === 'string') preferred = parsePortList(savedRaw)

      const candidates = await discoverPreviewServers({
        ports: requestedPorts ?? DEFAULT_PREVIEW_PORTS,
        preferred,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      sendJson(response, 200, { candidates })
    }
  ),
]
