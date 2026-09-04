import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WorkerRole } from '../shared/types.js'
import type { PickFolderResponse } from './fs-pick-folder.js'
import type { BranchPrInput, CreatedPr, GhStatus, OpenPrSummary } from './github-pr.js'
import type {
  OpenCommandResult,
  OpenWorkspaceInput as OpenWorkspaceServiceInput,
} from './open-target-commands.js'
import type { RuntimeStore } from './runtime-store.js'
import type { TasksFileService } from './tasks-file.js'

export interface SendTaskBody {
  gachi_port?: string
  project_id: string
  from_agent_id: string
  token?: string
  to: string
  text: string
}

export interface ReportTaskBody {
  dispatch_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  result: string
  status?: string
  artifacts?: unknown[]
}

export interface CancelTaskBody {
  dispatch_id?: string
  task_id?: string
  project_id: string
  from_agent_id: string
  token?: string
  reason?: string
}

export interface CreateWorkspaceBody {
  path: string
  name: string
  /** Default true. When false, skip orchestrator PTY spawn after creation. */
  autostart_orchestrator?: boolean
  /** Optional command preset. With startup_command, this selects the CLI interaction driver. */
  command_preset_id?: string | null
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
  /**
   * R8 onboarding (opt-in): seed one safe orientation card into the backlog
   * so a brand-new workspace has a concrete first task.
   */
  example_task?: boolean
}

export interface RenameWorkspaceBody {
  name: string
}

export interface CreateWorkerBody {
  autostart?: boolean
  command_preset_id?: string | null
  description?: string
  name: string
  role: WorkerRole
  /** Optional full startup command. When set, it overrides the executable only. */
  startup_command?: string | null
}

export interface UserInputBody {
  text: string
}

export interface ConfigureAgentLaunchBody {
  command: string
  args?: string[]
  command_preset_id?: string | null
  /** Optional full startup command. When set, it overrides `command`/`args` and runs through the user's login shell. */
  startup_command?: string | null
}

export interface OpenWorkspaceBody {
  target_id: string
}

export type OpenWorkspaceService = (input: OpenWorkspaceServiceInput) => Promise<OpenCommandResult>

/** GitHub PR operations, injectable so tests fake the gh CLI (roadmap Wave 2). */
export interface PrService {
  checkStatus(cwd: string): GhStatus
  create(input: BranchPrInput): CreatedPr
  list(cwd: string): OpenPrSummary[]
}

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  store: RuntimeStore
  tasksFileService: TasksFileService
  pickFolderService: () => Promise<PickFolderResponse>
  openWorkspaceService: OpenWorkspaceService
  prService: PrService
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: (context: RouteContext) => Promise<void> | void
}

export type { WorkerRole }
