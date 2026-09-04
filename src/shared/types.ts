export const agentStatuses = ['idle', 'working', 'waiting_decision', 'stopped'] as const

export type AgentStatus = (typeof agentStatuses)[number]

export const agentLifecycleStatuses = [
  'created',
  'starting',
  'ready',
  'working',
  'waiting',
  'waiting_input',
  'stuck',
  'handoff',
  'stopping',
  'stopped',
  'failed',
] as const

export type AgentLifecycleStatus = (typeof agentLifecycleStatuses)[number]

export type WorkerRole = 'coder' | 'reviewer' | 'tester' | 'custom'

export interface WorkspaceSummary {
  id: string
  name: string
  path: string
}

export interface AgentSummary {
  id: string
  workspaceId: string
  name: string
  description: string
  role: WorkerRole | 'orchestrator'
  status: AgentStatus
  pendingTaskCount: number
}

export interface TeamListItem {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pendingTaskCount: number
  /** Classified reason the last run died (e.g. `[rate-limit] 429 …`). */
  lastFailure?: string
  /** Freshest artifact mtime in the workspace (busy workers only). */
  lastArtifactAt?: number | null
  minutesSinceLastArtifact?: number | null
  changedFiles?: number
  /**
   * ID задачи, которую в данный момент обрабатывает воркер.
   */
  currentTaskId?: string
  currentTaskTitle?: string
  currentTaskStatus?: TaskStatus
  /**
   * Worker role instructions / skill text, injected into the agent session.
   */
  description?: string
  /**
   * Last raw line printed to the worker's PTY. Surfaced on the worker card for UI hints only —
   * not a worker reply. Real replies arrive as [Gachi system message] entries on orchestrator stdin.
   */
  lastPtyLine?: string
  /**
   * Built-in command preset this worker was launched with (`claude` / `codex` /
   * `opencode` / `gemini`). Drives the worker card's CLI logo (§6.4). Undefined
   * when the worker was created without picking a preset, or when the launch
   * config row references a custom command — in that case the UI falls back to
   * the role-letter avatar.
   */
  commandPresetId?: string
  /**
   * Raw launch command + args of the worker's launch config. Present for
   * workers whose config does not map to a command preset (e.g. a custom
   * startup command), so the UI can surface what CLI actually runs.
   */
  command?: string
  args?: string[]
  /**
   * Timestamp (ms) when this worker's PTY last emitted output.
   */
  lastPtyOutputAt?: number
  /**
   * Timestamp (ms) of the latest dispatch sent to this worker.
   */
  lastDispatchedAt?: number
  /**
   * Timestamp (ms) when the latest dispatch was actually delivered to the worker's PTY.
   */
  lastDeliveredAt?: number
  /**
   * Whether an active running PTY process currently exists for this agent.
   */
  hasActiveRun?: boolean
  /**
   * True when the agent's OS process is suspended by an explicit user pause.
   * Distinct from `working`: a paused agent owns no live execution, so the
   * recovery watchdog must leave it alone and the UI must show ⏸ instead of
   * an active spinner.
   */
  paused?: boolean
  lifecycleStatus?: AgentLifecycleStatus
  /**
   * Live worker engine RSS in MB, sampled by the memory watchdog (60s tick).
   * Null when the sample is stale or the engine has no live pid.
   */
  rssMb?: number | null
}

/**
 * Wire payload shape for /api/workspaces/:id/team and worker-creation responses.
 * Per AGENTS.md §8 + spec §3.3 line 162-179, HTTP JSON is snake_case.
 * Internal TS code uses TeamListItem (camelCase); serializers/deserializers convert.
 */
export interface TeamListItemPayload {
  id: string
  name: string
  role: WorkerRole
  status: AgentStatus
  pending_task_count: number
  last_pty_line: string | null
  command_preset_id: string | null
  command: string | null
  args: string[] | null
  description: string | null
  last_pty_output_at?: number | null
  last_dispatched_at?: number | null
  last_delivered_at?: number | null
  has_active_run?: boolean
  paused?: boolean
  current_task_id?: string | null
  current_task_title?: string | null
  current_task_status?: TaskStatus | null
  lifecycle_status?: AgentLifecycleStatus | null
  last_failure?: string | null
  last_artifact_at?: number | null
  minutes_since_last_artifact?: number | null
  changed_files?: number | null
  rss_mb?: number | null
}

export const taskStatuses = [
  'backlog',
  'ready',
  'claimed',
  'assigned',
  'running',
  'review',
  'blocked',
  'failed',
  'done',
  'canceled',
] as const
export type TaskStatus = (typeof taskStatuses)[number]

export interface Task {
  id: string
  title: string
  description: string
  createdAt: number
  assignedAgentId?: string
  dependencies?: string[]
  priority?: 'low' | 'normal' | 'high' | 'critical'
  requiredSkills?: string[]
  reviewRequired?: boolean
  role?: WorkerRole
  status: TaskStatus
  logs: string[]
}
