import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { ConfigureAgentLaunchBody, RouteDefinition } from './route-types.js'
import { getSubscriptionLimits } from './subscription-service.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

export const runtimeRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/runs', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(response, 200, store.listTerminalRuns(workspaceId))
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/shell/start',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const run = await store.startWorkspaceShell(workspaceId)
      const summary = store
        .listTerminalRuns(workspaceId)
        .find((terminalRun) => terminalRun.run_id === run.runId)
      sendJson(response, 201, {
        agent_id: getWorkspaceShellAgentId(workspaceId),
        agent_name: summary?.agent_name ?? 'Shell',
        run_id: run.runId,
        status: run.status,
        terminal_input_profile: summary?.terminal_input_profile ?? 'default',
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/shell/:runId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and run id are required'
      )
      const runId = getRequiredParam(
        response,
        params,
        'runId',
        'Workspace id and run id are required'
      )
      if (!workspaceId || !runId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      if (!store.closeWorkspaceShell(workspaceId, runId)) {
        sendJson(response, 404, { error: 'Shell run not found' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/config',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and agent id are required'
      )
      const agentId = getRequiredParam(
        response,
        params,
        'agentId',
        'Workspace id and agent id are required'
      )
      if (!workspaceId || !agentId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<ConfigureAgentLaunchBody>(request)
      const startupCommand =
        typeof body.startup_command === 'string' ? body.startup_command.trim() : ''
      if (startupCommand) {
        const launchConfig = resolveStartupCommandLaunchConfig(
          store.settings,
          startupCommand,
          body.command_preset_id ?? null
        )
        if (!launchConfig) {
          sendJson(response, 400, { error: 'Invalid startup command' })
          return
        }
        store.configureAgentLaunch(workspaceId, agentId, launchConfig)
      } else if (body.command_preset_id) {
        const launchConfig = resolveCommandPresetLaunchConfig(
          store.settings,
          body.command_preset_id
        )
        if (!launchConfig) {
          sendJson(response, 400, { error: `Command preset not found: ${body.command_preset_id}` })
          return
        }
        store.configureAgentLaunch(workspaceId, agentId, launchConfig)
      } else if (typeof body.command === 'string' && body.command.trim()) {
        store.configureAgentLaunch(workspaceId, agentId, {
          command: body.command,
          commandPresetId: null,
          ...(body.args ? { args: body.args } : {}),
        })
      } else {
        sendJson(response, 400, { error: 'A command or command preset is required' })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route('POST', '/api/runtime/runs/:runId/stop', async ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    await store.stopAgentRun(runId)
    sendJson(response, 202, { ok: true })
  }),
  route('POST', '/api/runtime/runs/:runId/pause', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    store.pauseTerminalRun(runId)
    sendJson(response, 200, { ok: true })
  }),
  route('POST', '/api/runtime/runs/:runId/resume', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    store.resumeTerminalRun(runId)
    sendJson(response, 200, { ok: true })
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers/:workerId/reset',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const workerId = getRequiredParam(response, params, 'workerId', 'Worker id is required')
      if (!workspaceId || !workerId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      // Reset worker's pending/working state to idle. Not-found (worker or
      // workspace gone) maps to an honest 404; everything else surfaces as a
      // 500 instead of a silent ok.
      try {
        store.resetWorker(workspaceId, workerId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/^(Worker|Agent|Workspace) not found/.test(message)) {
          sendJson(response, 404, { error: message })
          return
        }
        throw error
      }

      sendJson(response, 200, { ok: true })
    }
  ),
  route('GET', '/api/runtime/runs/:runId', ({ params, request, response, store }) => {
    const runId = getRequiredParam(response, params, 'runId', 'Run id is required')
    if (!runId) {
      return
    }

    requireUiTokenFromRequest(request, store.validateUiToken)

    sendJson(response, 200, store.getLiveRun(runId))
  }),
  route('GET', '/api/subscription-limits', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, { limits: getSubscriptionLimits() })
  }),
]
