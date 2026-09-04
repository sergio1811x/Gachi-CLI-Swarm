import crypto from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { seedExampleTask } from './example-task.js'
import { autostartAgent, autostartOrchestrator } from './orchestrator-autostart.js'
import { seedOrchestratorLaunchConfig } from './orchestrator-launch.js'
import { installSkillPackage } from './role-profiles.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CreateWorkerBody,
  CreateWorkspaceBody,
  RenameWorkspaceBody,
  RouteDefinition,
  UserInputBody,
} from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { findSkillPackage, skillCatalog } from './skill-catalog.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { validateWorkspacePath } from './workspace-path-validation.js'
import { getOrchestratorId } from './workspace-store-support.js'

const getSerializedWorker = async (workspaceId: string, workerId: string, store: RuntimeStore) => {
  const worker = store.listWorkers(workspaceId).find((item) => item.id === workerId)
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`)
  }
  const [enriched] = await enrichTeamList(workspaceId, store, [worker], {
    workspacePath: safeWorkspacePath(store, workspaceId),
  })
  if (!enriched) throw new Error(`Worker enrichment failed: ${workerId}`)
  return serializeTeamListItem(enriched)
}

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

/** Artifact-clock needs the workspace path; a missing workspace just means no diagnostics. */
const safeWorkspacePath = (store: RuntimeStore, workspaceId: string): string | null => {
  try {
    return store.getWorkspaceSnapshot(workspaceId).summary.path
  } catch {
    return null
  }
}

export const workspaceRoutes: RouteDefinition[] = [
  route('GET', '/api/skills', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, skillCatalog)
  }),
  route(
    'POST',
    '/api/workspaces/:workspaceId/skills/install',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      const body = await readJsonBody<{ name?: string; role?: string }>(request)
      const skillPackage = body.name ? findSkillPackage(body.name) : undefined
      if (!skillPackage) {
        sendJson(response, 404, { error: 'Skill package not found' })
        return
      }
      if (!['coder', 'reviewer', 'tester', 'custom', 'orchestrator'].includes(body.role ?? '')) {
        sendJson(response, 400, { error: 'A valid role is required' })
        return
      }
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const profile = installSkillPackage(
        workspace.summary.path,
        body.role as 'coder' | 'reviewer' | 'tester' | 'custom' | 'orchestrator',
        skillPackage
      )
      sendJson(response, 200, { profile, skill: skillPackage.name })
    }
  ),
  route('GET', '/api/workspaces', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, store.listWorkspaces())
  }),
  route('POST', '/api/workspaces', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const body = await readJsonBody<CreateWorkspaceBody>(request)
    const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
    const workspacePath = validateWorkspacePath(body.path)
    const workspace = store.createWorkspace(workspacePath, body.name)
    seedOrchestratorLaunchConfig(
      store,
      store.settings,
      workspace.id,
      body.command_preset_id ?? null,
      startupCommand
    )
    // R8 onboarding (opt-in): one safe orientation card in the backlog.
    if (body.example_task === true) {
      seedExampleTask(workspace.id)
    }

    const autostart = body.autostart_orchestrator !== false
    if (!autostart) {
      sendJson(response, 201, {
        ...workspace,
        orchestrator_start: { ok: false, error: null, run_id: null },
      })
      return
    }

    // Spawn failure must NOT block workspace creation — see AGENTS.md §1
    // (no try/catch fallbacks in production code, but `autostartOrchestrator`
    // captures the failure as a structured result instead of throwing).
    const orchestratorStart = await autostartOrchestrator(
      store,
      workspace.id,
      getOrchestratorId(workspace.id),
      getRuntimePort(request)
    )
    sendJson(response, 201, { ...workspace, orchestrator_start: orchestratorStart })
  }),
  route('PATCH', '/api/workspaces/:workspaceId', async ({ params, request, response, store }) => {
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
    const body = await readJsonBody<RenameWorkspaceBody>(request)
    const workspace = store.renameWorkspace(workspaceId, body.name)
    sendJson(response, 200, workspace)
  }),
  route('DELETE', '/api/workspaces/:workspaceId', async ({ params, request, response, store }) => {
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
    await store.deleteWorkspace(workspaceId)
    response.statusCode = 204
    response.end()
  }),
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/team',
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

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const activeOnly = url.searchParams.get('active_only') === '1'
      const enriched = await enrichTeamList(workspaceId, store, store.listWorkers(workspaceId), {
        workspacePath: safeWorkspacePath(store, workspaceId),
      })
      const visible = activeOnly
        ? enriched.filter((worker) => worker.hasActiveRun === true)
        : enriched

      sendJson(response, 200, visible.map(serializeTeamListItem))
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/team',
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

      const agentId = request.headers['x-gachi-agent-id']
      const token = request.headers['x-gachi-agent-token']
      const agent = authenticateCliAgent({
        fromAgentId: typeof agentId === 'string' ? agentId : undefined,
        getAgent: store.getAgent,
        token: typeof token === 'string' ? token : undefined,
        validateToken: store.validateAgentToken,
        workspaceId,
      })
      requireCommandForRole(agent, 'list')

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const activeOnly = url.searchParams.get('active_only') === '1'
      const enriched = await enrichTeamList(workspaceId, store, store.listWorkers(workspaceId), {
        workspacePath: safeWorkspacePath(store, workspaceId),
      })
      const visible = activeOnly
        ? enriched.filter((worker) => worker.hasActiveRun === true)
        : enriched

      sendJson(response, 200, visible.map(serializeTeamListItem))
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers',
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

      const body = await readJsonBody<CreateWorkerBody>(request)
      const presetId = body.command_preset_id ?? null
      const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
      const launchConfig = startupCommand?.trim()
        ? resolveStartupCommandLaunchConfig(store.settings, startupCommand, presetId)
        : presetId
          ? resolveCommandPresetLaunchConfig(store.settings, presetId)
          : undefined
      if (presetId && !startupCommand?.trim() && !launchConfig) {
        throw new Error(`Command preset not found: ${presetId}`)
      }
      const worker = store.addWorker(workspaceId, body)
      if (launchConfig) {
        try {
          store.configureAgentLaunch(workspaceId, worker.id, launchConfig)
        } catch (error) {
          store.deleteWorker(workspaceId, worker.id)
          throw error
        }
      }

      const agentStart =
        body.autostart === true
          ? await autostartAgent(store, workspaceId, worker.id, getRuntimePort(request), {
              missingConfigError: 'No worker launch config available',
            })
          : { ok: false, error: null, run_id: null }

      sendJson(response, 201, {
        ...(await getSerializedWorker(workspaceId, worker.id, store)),
        agent_start: agentStart,
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/workers/:workerId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      try {
        store.deleteWorker(workspaceId, workerId)
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'Failed to delete worker',
        })
        return
      }
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/workers/:workerId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<{ name?: string; description?: string }>(request)
      if (body.name !== undefined && typeof body.name !== 'string') {
        sendJson(response, 400, { error: 'name must be a string' })
        return
      }
      if (body.description !== undefined && typeof body.description !== 'string') {
        sendJson(response, 400, { error: 'description must be a string' })
        return
      }
      store.updateWorker(workspaceId, workerId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      })
      sendJson(response, 200, getSerializedWorker(workspaceId, workerId, store))
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/user-input',
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

      const body = await readJsonBody<UserInputBody>(request)
      store.recordUserInput(workspaceId, `${workspaceId}:orchestrator`, body.text)
      sendJson(response, 202, { ok: true })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/start',
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

      if (
        agentId === getOrchestratorId(workspaceId) &&
        !store.peekAgentLaunchConfig(workspaceId, agentId)
      ) {
        seedOrchestratorLaunchConfig(store, store.settings, workspaceId)
      }
      const run = await store.startAgent(workspaceId, agentId, {
        gachiPort: getRuntimePort(request),
      })
      sendJson(response, 201, { run_id: run.runId })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/pty/input',
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

      const body = await readJsonBody<{ data?: string; input?: string; text?: string }>(request)
      const rawInput = body.data ?? body.input ?? body.text ?? '\r'

      const activeRun = store.getActiveRunByAgentId(workspaceId, agentId)
      if (!activeRun) {
        sendJson(response, 404, { error: `No active PTY run for agent ${agentId}` })
        return
      }

      store.writeRunInput(activeRun.runId, rawInput)
      sendJson(response, 200, { ok: true, run_id: activeRun.runId, bytes_written: rawInput.length })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/attachments',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{
        filename?: string
        data_base64: string
      }>(request, { limitBytes: 25 * 1024 * 1024 }) // Allow up to 25MB for images

      if (!body.data_base64) {
        sendJson(response, 400, { error: 'data_base64 is required' })
        return
      }

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const attachDir = join(workspace.summary.path, '.gachi', 'attachments')
      mkdirSync(attachDir, { recursive: true })

      const cleanBase64 = body.data_base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
      const buffer = Buffer.from(cleanBase64, 'base64')

      const extMatch = body.filename?.match(/\.[a-zA-Z0-9]+$/)
      const ext = extMatch ? extMatch[0] : '.png'
      const fileId = crypto.randomUUID().slice(0, 8)
      const filename = `paste_${Date.now()}_${fileId}${ext}`
      const absolutePath = join(attachDir, filename)

      writeFileSync(absolutePath, buffer)

      const relativePath = `.gachi/attachments/${filename}`
      sendJson(response, 201, {
        ok: true,
        filename,
        relative_path: relativePath,
        absolute_path: absolutePath,
      })
    }
  ),
  route('POST', '/api/attachments', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)

    const body = await readJsonBody<{
      workspace_id?: string
      filename?: string
      data_base64: string
    }>(request, { limitBytes: 25 * 1024 * 1024 })

    if (!body.data_base64) {
      sendJson(response, 400, { error: 'data_base64 is required' })
      return
    }

    const workspaces = store.listWorkspaces()
    const firstWs = workspaces[0]
    const workspace = body.workspace_id
      ? store.getWorkspaceSnapshot(body.workspace_id)
      : firstWs
        ? store.getWorkspaceSnapshot(firstWs.id)
        : null

    const attachDir = workspace
      ? join(workspace.summary.path, '.gachi', 'attachments')
      : join(process.cwd(), '.gachi', 'attachments')
    mkdirSync(attachDir, { recursive: true })

    const cleanBase64 = body.data_base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
    const buffer = Buffer.from(cleanBase64, 'base64')

    const extMatch = body.filename?.match(/\.[a-zA-Z0-9]+$/)
    const ext = extMatch ? extMatch[0] : '.png'
    const fileId = crypto.randomUUID().slice(0, 8)
    const filename = `paste_${Date.now()}_${fileId}${ext}`
    const absolutePath = join(attachDir, filename)

    writeFileSync(absolutePath, buffer)

    const relativePath = `.gachi/attachments/${filename}`
    sendJson(response, 201, {
      ok: true,
      filename,
      relative_path: relativePath,
      absolute_path: absolutePath,
    })
  }),
]
