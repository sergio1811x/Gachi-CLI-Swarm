import type { AgentUsageTotals, UsageSampleRow } from './agent-usage-store.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { taskStore } from './task-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * Swarm metrics (ROADMAP R1): durable usage aggregates for a workspace —
 * per-agent token totals/peaks, the sampled timeline, plus success-rate and
 * average task duration derived from the dispatch/task stores.
 */

const HOUR_MS = 60 * 60_000

export const metricsRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces/:workspaceId/metrics', ({ params, request, response, store }) => {
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
    const windowHours = Math.min(
      24 * 14,
      Math.max(1, Number(url.searchParams.get('window_hours')) || 24)
    )
    const windowMs = windowHours * HOUR_MS

    const usage = store.workspaceMetrics(workspaceId, windowMs)

    // Success-rate + duration from the task store (terminal states only).
    const tasks = taskStore.listTasks(workspaceId)
    const done = tasks.filter((t) => t.status === 'done')
    const failed = tasks.filter((t) => t.status === 'failed')
    const durations = done
      .filter((t) => typeof t.startedAt === 'number' && typeof t.finishedAt === 'number')
      .map((t) => (t.finishedAt as number) - (t.startedAt as number))
      .filter((ms) => ms >= 0)
    const avgTaskDurationMs =
      durations.length > 0
        ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length
        : null

    // Token totals within the window: per-agent max scraped counters.
    const totalTokens = usage.agents.reduce(
      (acc: number, agent: AgentUsageTotals) => acc + (agent.lastTokensUsed ?? 0),
      0
    )

    sendJson(response, 200, {
      window_hours: windowHours,
      generated_at: Date.now(),
      tasks: {
        done: done.length,
        failed: failed.length,
        success_rate:
          done.length + failed.length > 0
            ? Math.round((done.length / (done.length + failed.length)) * 100)
            : null,
        avg_task_duration_ms: avgTaskDurationMs === null ? null : Math.round(avgTaskDurationMs),
      },
      tokens_total: totalTokens,
      agents: usage.agents as AgentUsageTotals[],
      samples: usage.samples.slice(-500) as Array<UsageSampleRow & { tokensDelta: number | null }>,
    })
  }),
]
