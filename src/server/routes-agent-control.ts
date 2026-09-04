import type { AgentSummary } from '../shared/types.js'
import type { AgentCapabilityRecord } from './agent-capability-registry.js'
import type { AgentControlState, ContextAction } from './agent-control.js'
import { agentDiscoveryScanner, type DiscoveryReport } from './agent-discovery/scanner.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { taskStore } from './task-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const serializeDiscoveryReport = (report: DiscoveryReport) => ({
  agents: report.agents.map((agent) => ({
    authenticated: agent.auth.authenticated,
    auth_error: agent.auth.error ?? null,
    auth_method: agent.auth.method ?? null,
    installed: agent.installed,
    models: agent.models.map((model) => ({
      context_window: model.contextWindow ?? null,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
    })),
    name: agent.name,
    path: agent.path ?? null,
    version: agent.version ?? null,
  })),
  scanned_at: report.scannedAt,
})

/**
 * Unified agent control plane HTTP API (spec Part 2 §1/§2/§4/§5/§6/§7).
 * All request/response payloads are snake_case at the boundary.
 */

const serializeCapability = (record: AgentCapabilityRecord) => ({
  context_commands: record.contextCommands,
  display_name: record.displayName,
  features: {
    context_control: record.features.contextControl,
    model_switch: record.features.modelSwitch,
    reasoning_control: record.features.reasoningControl,
  },
  provider: record.provider,
  resume_supported: record.resumeSupported,
  suggested_models: record.suggestedModels,
  supported_reasoning_levels: record.supportedReasoningLevels.map((level) => level.toLowerCase()),
})

const serializeState = (workspaceId: string, agentId: string, state: AgentControlState) => ({
  agent_id: agentId,
  capability: state.capability ? serializeCapability(state.capability) : null,
  context_percent: state.contextPercent,
  model: state.model,
  provider: state.provider,
  reasoning_level: state.reasoningLevel ? state.reasoningLevel.toLowerCase() : null,
  running: state.running,
  tokens_used: state.tokensUsed,
  usage_updated_at: state.usageUpdatedAt,
  workspace_id: workspaceId,
})

const parseContextAction = (value: unknown): ContextAction | undefined =>
  value === 'clear' || value === 'compact' ? value : undefined

export const agentControlRoutes: RouteDefinition[] = [
  route('GET', '/api/agents/capabilities', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    sendJson(response, 200, {
      capabilities: store.listAgentCapabilities().map(serializeCapability),
    })
  }),
  route('GET', '/api/agents/discovery', async ({ request, response, store }) => {
    // Agent Discovery Layer (spec §1–§6): environment scan, TTL-cached.
    requireUiTokenFromRequest(request, store.validateUiToken)
    const report = await agentDiscoveryScanner.getReport()
    sendJson(response, 200, serializeDiscoveryReport(report))
  }),
  route('POST', '/api/agents/discovery/rescan', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)
    const report = await agentDiscoveryScanner.rescan()
    sendJson(response, 200, serializeDiscoveryReport(report))
  }),
  route(
    'GET',
    '/api/workspaces/:workspaceId/agents/:agentId/control',
    ({ params, request, response, store }) => {
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      sendJson(
        response,
        200,
        serializeState(workspaceId, agentId, store.getAgentControlState(workspaceId, agentId))
      )
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/model',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ model?: string }>(request)
      const result = await store.agentSwitchModel(workspaceId, agentId, body.model)
      sendJson(response, 200, { model: result.model, restarted: result.restarted })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/reasoning',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ level?: string }>(request)
      const result = await store.agentSetReasoning(workspaceId, agentId, body.level)
      sendJson(response, 200, { level: result.level.toLowerCase(), restarted: result.restarted })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/context',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ action?: string }>(request)
      const action = parseContextAction(body.action)
      if (!action) {
        sendJson(response, 400, { error: "Expected action: 'clear' or 'compact'" })
        return
      }
      const result = await store.agentContextAction(workspaceId, agentId, action)
      sendJson(response, 200, { action: result.action, ok: true })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/start',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const result = await store.agentStart(workspaceId, agentId, {
        gachi_port: String(request.socket?.localPort ?? ''),
      })
      sendJson(response, 200, { started: result.started })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/stop',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const result = await store.agentStop(workspaceId, agentId)
      sendJson(response, 200, { stopped: result.stopped })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/restart',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const result = await store.agentRestart(workspaceId, agentId, {
        gachi_port: String(request.socket?.localPort ?? ''),
      })
      sendJson(response, 200, { restarted: result.restarted })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/resume-session',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const result = await store.agentResumeSession(workspaceId, agentId, {
        gachi_port: String(request.socket?.localPort ?? ''),
      })
      sendJson(response, 200, { resumed: result.resumed, session_id: result.session_id })
    }
  ),
  // Swarm dashboard (roadmap Wave 2 / competitor parity): one call feeding the
  // whole control overview — every agent's live state plus task counters.
  route(
    'GET',
    '/api/workspaces/:workspaceId/control/summary',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      requireUiTokenFromRequest(request, store.validateUiToken)

      let agents: AgentSummary[]
      try {
        agents = store.getWorkspaceSnapshot(workspaceId).agents
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const tasks = taskStore.listTasks(workspaceId)
      const byStatus = {
        assigned: 0,
        backlog: 0,
        done: 0,
        failed: 0,
        ready: 0,
        review: 0,
        running: 0,
      }
      for (const task of tasks) {
        if (task.status in byStatus) byStatus[task.status as keyof typeof byStatus] += 1
      }

      sendJson(response, 200, {
        agents: agents.map((agent) => ({
          ...serializeState(
            workspaceId,
            agent.id,
            store.getAgentControlState(workspaceId, agent.id)
          ),
          name: agent.name,
          role: agent.role,
          status: agent.status,
        })),
        tasks: byStatus,
      })
    }
  ),
  // Follow-up prompt to a LIVE worker (Vibe-Kanban-style "prompt panel"):
  // types text into the running PTY without stopping or re-dispatching.
  route(
    'POST',
    '/api/workspaces/:workspaceId/agents/:agentId/control/input',
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
      if (!workspaceId || !agentId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ text?: string }>(request)
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        sendJson(response, 400, { error: 'text is required' })
        return
      }

      const active = store.getActiveRunByAgentId(workspaceId, agentId)
      if (!active || active.status !== 'running') {
        sendJson(response, 409, { error: 'Agent is not running' })
        return
      }
      if (!active.runId) {
        sendJson(response, 409, { error: 'Active run has no PTY attached' })
        return
      }

      try {
        // Dispatch seam (prompt-ready → paste → separate CR): a raw write can
        // be eaten by a mid-render TUI and never submits.
        const delivered = store.writeAgentInteractiveInput(workspaceId, agentId, body.text.trim())
        if (!delivered) {
          sendJson(response, 409, { error: 'Agent has no writable PTY' })
          return
        }
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : 'PTY write failed',
        })
        return
      }
      sendJson(response, 200, { delivered: true, run_id: active.runId })
    }
  ),
]
