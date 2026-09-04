import { changelogForWorkspace } from './changelog.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { taskStore } from './task-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * Release notes (ROADMAP R4): git commits within the window merged with the
 * swarm's PR journal from done tasks. Markdown-first for easy paste.
 */

export const changelogRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces/:workspaceId/changelog', ({ params, request, response, store }) => {
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

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const daysRaw = Number.parseInt(url.searchParams.get('days') ?? '30', 10)
    const sinceDays = Number.isInteger(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30

    const result = changelogForWorkspace(
      workspacePath,
      workspaceId,
      (wsId, sinceMs) =>
        taskStore
          .listTasks(wsId)
          .filter((t) => t.status === 'done' && (t.finishedAt ?? 0) >= sinceMs)
          .map((t) => ({
            id: t.id,
            title: t.title,
            finishedAt: t.finishedAt ?? null,
            logs: t.logs ?? [],
          })),
      sinceDays
    )
    sendJson(response, 200, {
      commits: result.commits,
      generated_at: result.generatedAt,
      is_git_repo: result.isGitRepo,
      markdown: result.markdown,
      pull_requests: result.pullRequests.map((pr) => ({
        task_id: pr.taskId,
        title: pr.title,
        url: pr.url,
      })),
      since_days: result.sinceDays,
    })
  }),
]
