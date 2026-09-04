import { existsSync } from 'node:fs'
import { DEPLOY_HOOK_KEY_PREFIX } from './deploy-hook.js'
import { BREAKER_STAGE_KEY_PREFIX, BREAKER_UNTIL_KEY_PREFIX } from './error-budget-breaker.js'
import {
  checkGhStatus,
  createBranchPr,
  type GhCommandRunner,
  GhError,
  listOpenPrs,
} from './github-pr.js'
import {
  MEMORY_WATCHDOG_FREE_PERCENT_KEY,
  readMemoryWatchdogConfig,
  WORKER_MEM_ROTATION_KEY_PREFIX,
} from './memory-watchdog.js'
import {
  DISPATCH_PAUSED_KEY_PREFIX,
  MEMORY_PAUSE_KEY,
  readPermissionMode,
  writePermissionMode,
} from './permission-mode.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { PrService, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { getAgentWorktreePath, resolveWorkerBranchName } from './worktree-manager.js'

/**
 * GitHub PR flow (roadmap Wave 2): publish a worker branch as a pull request
 * and inspect open PRs for the workspace repo. UI-token authed; the gh/git
 * execution is injected through RouteContext.prService (default: real gh
 * binary) so tests cross the real HTTP boundary without the real `gh`.
 */

export const createDefaultPrService = (runner?: GhCommandRunner): PrService => ({
  checkStatus: (cwd) => checkGhStatus(cwd, runner),
  create: (input) => createBranchPr(input, runner),
  list: (cwd) => listOpenPrs(cwd, runner),
})

const MAX_PR_BODY_LEN = 16_000

export const prRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/pr/status',
    ({ params, prService, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      let workspacePath: string
      try {
        workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const status = prService.checkStatus(workspacePath)
      const openPrs = status.installed && status.authed ? prService.list(workspacePath) : []
      sendJson(response, 200, {
        auto_pr_enabled:
          store.settings.getAppState(`auto_pr_after_merge_${workspaceId}`)?.value === '1',
        deploy_hook_command:
          store.settings.getAppState(`${DEPLOY_HOOK_KEY_PREFIX}${workspaceId}`)?.value?.trim() ||
          null,
        worker_permission_mode: readPermissionMode(store.settings, workspaceId),
        dispatch_paused:
          store.settings.getAppState(`dispatch_paused_${workspaceId}`)?.value === '1',
        dispatch_paused_memory: store.settings.getAppState(MEMORY_PAUSE_KEY)?.value === '1',
        memory_watchdog: readMemoryWatchdogConfig(store.settings, workspaceId),
        error: status.error,
        installed: status.installed,
        open_prs: openPrs.map((pr) => ({
          head: pr.head,
          number: pr.number,
          state: pr.state,
          title: pr.title,
          url: pr.url,
        })),
      })
    }
  ),

  route(
    'POST',
    '/api/workspaces/:workspaceId/pr',
    async ({ params, prService, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      let workspacePath: string
      try {
        workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const body = await readJsonBody<{
        agent_id?: string
        base?: string
        body?: string
        branch?: string
        title?: string
      }>(request)

      // Branch resolution order: explicit branch → worker's gachi/<agent> branch.
      let branch = typeof body.branch === 'string' ? body.branch.trim() : ''
      if (!branch && typeof body.agent_id === 'string' && body.agent_id.trim()) {
        const worktree = getAgentWorktreePath(workspacePath, body.agent_id.trim())
        if (existsSync(worktree))
          branch = resolveWorkerBranchName(workspacePath, body.agent_id.trim())
      }
      if (!branch) {
        sendJson(response, 400, { error: 'branch or agent_id is required' })
        return
      }

      try {
        const created = prService.create({
          base: typeof body.base === 'string' && body.base.trim() ? body.base.trim() : undefined,
          body:
            typeof body.body === 'string' && body.body.trim()
              ? body.body.slice(0, MAX_PR_BODY_LEN)
              : undefined,
          branch,
          cwd: workspacePath,
          title:
            typeof body.title === 'string' && body.title.trim()
              ? body.title.trim().slice(0, 200)
              : `PR for ${branch}`,
        })
        sendJson(response, 201, { number: created.number, ok: true, url: created.url })
        return
      } catch (error) {
        if (error instanceof GhError) {
          sendJson(response, 409, { error: error.message, kind: error.kind, ok: false })
          return
        }
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        })
      }
    }
  ),
  // Opt-in auto-PR toggle: when enabled, a clean worker merge publishes the
  // branch and journals the PR link automatically.
  route(
    'POST',
    '/api/workspaces/:workspaceId/auto-pr',
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

      const body = await readJsonBody<{ enabled?: boolean }>(request)
      const enabled = body.enabled === true
      store.settings.setAppState(`auto_pr_after_merge_${workspaceId}`, enabled ? '1' : '0')
      sendJson(response, 200, { auto_pr_enabled: enabled, ok: true })
    }
  ),
  // R4 deploy hook config: set/clear the post-merge command for a workspace.
  route(
    'PUT',
    '/api/workspaces/:workspaceId/deploy-hook',
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

      const body = await readJsonBody<{ command?: string | null }>(request)
      const command = typeof body.command === 'string' ? body.command.trim().slice(0, 2000) : ''
      const key = `${DEPLOY_HOOK_KEY_PREFIX}${workspaceId}`
      if (command) {
        store.settings.setAppState(key, command)
      } else {
        store.settings.setAppState(key, '')
      }
      sendJson(response, 200, { deploy_hook_command: command || null, ok: true })
    }
  ),
  // R10 permission mode: `ask` stops the runtime from answering TUI dialogs
  // on behalf of workers and suppresses blanket opencode grants.
  route(
    'PUT',
    '/api/workspaces/:workspaceId/permissions',
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

      const body = await readJsonBody<{ mode?: string }>(request)
      const mode = body.mode === 'ask' ? 'ask' : 'allow-all'
      writePermissionMode(store.settings, workspaceId, mode)
      sendJson(response, 200, { ok: true, worker_permission_mode: mode })
    }
  ),
  // R10 error budget resume: clear the dispatch-pause flag set when a
  // workspace burned its consecutive-failure budget. Resuming kicks the
  // dispatcher so queued `ready` tasks flow again.
  route(
    'PUT',
    '/api/workspaces/:workspaceId/dispatch-pause',
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

      const body = await readJsonBody<{ paused?: boolean }>(request)
      const paused = body.paused === true
      store.settings.setAppState(`${DISPATCH_PAUSED_KEY_PREFIX}${workspaceId}`, paused ? '1' : '0')
      if (!paused) {
        // Manual resume fully closes the breaker: drop the cooldown deadline,
        // reset the escalation stage and halve the failure streak so the next
        // burn-down starts from an armed breaker, not a disarmed one.
        store.settings.setAppState(`${BREAKER_UNTIL_KEY_PREFIX}${workspaceId}`, '0')
        store.settings.setAppState(`${BREAKER_STAGE_KEY_PREFIX}${workspaceId}`, '0')
        store.softenErrorBudget(workspaceId)
      }
      sendJson(response, 200, { dispatch_paused: paused, ok: true })
    }
  ),
  // Memory watchdog: per-workspace configuration (threshold % + rotation RSS)
  // plus visibility into the global memory hold in the status payload.
  route(
    'PUT',
    '/api/workspaces/:workspaceId/memory-watchdog',
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

      const body = await readJsonBody<{
        enabled?: boolean
        free_percent?: number
        rotation_rss_mb?: number | null
      }>(request)

      if (typeof body.free_percent === 'number' && Number.isFinite(body.free_percent)) {
        const percent = Math.min(90, Math.max(1, Math.round(body.free_percent)))
        store.settings.setAppState(MEMORY_WATCHDOG_FREE_PERCENT_KEY, String(percent))
      }
      if (body.enabled === false) {
        store.settings.setAppState(MEMORY_WATCHDOG_FREE_PERCENT_KEY, '0')
      }
      if (body.rotation_rss_mb !== undefined) {
        const raw = body.rotation_rss_mb
        const value =
          typeof raw === 'number' && Number.isFinite(raw) && raw > 0
            ? Math.min(65_536, Math.max(256, Math.round(raw)))
            : 0
        store.settings.setAppState(`${WORKER_MEM_ROTATION_KEY_PREFIX}${workspaceId}`, String(value))
      }
      sendJson(response, 200, {
        ok: true,
        memory_watchdog: readMemoryWatchdogConfig(store.settings, workspaceId),
      })
    }
  ),
]
