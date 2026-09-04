import { matchPath } from './route-helpers.js'
import type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
} from './route-types.js'
import { agentControlRoutes } from './routes-agent-control.js'
import { changelogRoutes } from './routes-changelog.js'
import { dispatchRoutes } from './routes-dispatches.js'
import { fsRoutes } from './routes-fs.js'
import { marketplaceRoutes } from './routes-marketplace.js'
import { metricsRoutes } from './routes-metrics.js'
import { openWorkspaceRoutes } from './routes-open-workspace.js'
import { prRoutes } from './routes-pr.js'
import { previewRoutes } from './routes-preview.js'
import { runtimeRoutes } from './routes-runtime.js'
import { settingsRoutes } from './routes-settings.js'
import { taskRoutes } from './routes-tasks.js'
import { teamRoutes } from './routes-team.js'
import { telegramRoutes } from './routes-telegram.js'
import { uiRoutes } from './routes-ui.js'
import { workspaceRoutes } from './routes-workspaces.js'

const routes: RouteDefinition[] = [
  ...workspaceRoutes,
  ...openWorkspaceRoutes,
  ...dispatchRoutes,
  ...uiRoutes,
  ...settingsRoutes,
  ...taskRoutes,
  ...prRoutes,
  ...previewRoutes,
  ...metricsRoutes,
  ...changelogRoutes,
  ...runtimeRoutes,
  ...agentControlRoutes,
  ...telegramRoutes,
  ...teamRoutes,
  ...fsRoutes,
  ...marketplaceRoutes,
]

export const matchRoute = (method: string, pathname: string) => {
  for (const routeDefinition of routes) {
    if (routeDefinition.method !== method) {
      continue
    }

    const params = matchPath(routeDefinition.path, pathname)
    if (!params) {
      continue
    }

    return {
      handler: routeDefinition.handler,
      params,
    }
  }

  return null
}

export type {
  ConfigureAgentLaunchBody,
  CreateWorkerBody,
  CreateWorkspaceBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  WorkerRole,
}
