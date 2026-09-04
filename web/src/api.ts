import type { OpenTargetId, OpenWorkspaceErrorCode } from '../../src/shared/open-targets.js'
import type {
  AgentSummary,
  TaskStatus,
  TeamListItem,
  TeamListItemPayload,
  WorkerRole,
  WorkspaceSummary,
} from '../../src/shared/types.js'

export type { OpenTargetId, OpenWorkspaceErrorCode }

const fromPayload = (payload: TeamListItemPayload): TeamListItem => ({
  id: payload.id,
  name: payload.name,
  role: payload.role,
  status: payload.status,
  pendingTaskCount: payload.pending_task_count,
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.command_preset_id ? { commandPresetId: payload.command_preset_id } : {}),
  ...(payload.description ? { description: payload.description } : {}),
  ...(payload.command ? { command: payload.command } : {}),
  ...(payload.args ? { args: payload.args } : {}),
  ...(payload.current_task_id ? { currentTaskId: payload.current_task_id } : {}),
  ...(payload.current_task_title ? { currentTaskTitle: payload.current_task_title } : {}),
  ...(payload.current_task_status ? { currentTaskStatus: payload.current_task_status } : {}),
  ...(payload.lifecycle_status ? { lifecycleStatus: payload.lifecycle_status } : {}),
  ...(payload.has_active_run ? { hasActiveRun: true } : {}),
  ...(payload.paused ? { paused: true } : {}),
  ...(payload.rss_mb ? { rssMb: payload.rss_mb } : {}),
})

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Keep the original fallback when the server did not send a JSON error body.
  }
  return fallback
}

const isStaleUiSession = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return body.error === 'UI endpoint requires valid UI token'
  } catch {
    return false
  }
}

export const initializeUiSession = async (): Promise<void> => {
  const response = await fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to initialize UI session')
  }
  await response.json()
}

export const getUiSessionToken = async (): Promise<string> => {
  const response = await fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to fetch UI session token')
  }
  const body = (await response.json()) as { token: string }
  return body.token
}

export const regenerateUiSessionToken = async (): Promise<string> => {
  const response = await apiFetch('/api/ui/session/regenerate', {
    method: 'POST',
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error('Failed to regenerate UI session token')
  }
  const body = (await response.json()) as { token: string }
  return body.token
}

let uiSessionRefreshPromise: Promise<void> | null = null

const refreshUiSession = (): Promise<void> => {
  uiSessionRefreshPromise ??= initializeUiSession().finally(() => {
    uiSessionRefreshPromise = null
  })
  return uiSessionRefreshPromise
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!(await isStaleUiSession(response))) return response

  await refreshUiSession()
  return fetch(input, init)
}

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await apiFetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

export interface CommandPreset {
  args: string[]
  available: boolean
  command: string
  displayName: string
  id: string
}

export interface RoleTemplate {
  description: string
  id: string
  isBuiltin: boolean
  name: string
  roleType: WorkerRole | 'orchestrator'
}

export interface RoleTemplateInput {
  description: string
  name: string
  roleType: WorkerRole | 'orchestrator'
}

interface CommandPresetPayload {
  args: string[]
  available: boolean
  command: string
  display_name: string
  id: string
}

interface RoleTemplatePayload {
  description: string
  id: string
  is_builtin: boolean
  name: string
  role_type: WorkerRole | 'orchestrator'
}

const fromRoleTemplatePayload = (payload: RoleTemplatePayload): RoleTemplate => ({
  description: payload.description,
  id: payload.id,
  isBuiltin: payload.is_builtin,
  name: payload.name,
  roleType: payload.role_type,
})

const toRoleTemplateBody = (input: RoleTemplateInput) => ({
  name: input.name,
  role_type: input.roleType,
  description: input.description,
  default_command: '',
  default_args: [],
  default_env: {},
})

export interface AgentStartResult {
  error: string | null
  ok: boolean
  runId: string | null
}

interface AgentStartPayload {
  error: string | null
  ok: boolean
  run_id: string | null
}

export interface CreateWorkerResult {
  agentStart: AgentStartResult
  worker: TeamListItem
}

type CreateWorkerPayload = TeamListItemPayload & { agent_start?: AgentStartPayload }

export interface CreateWorkspaceResponse extends WorkspaceSummary {
  orchestrator_start: OrchestratorStartResult
}

export const createWorkspace = async (input: {
  name: string
  path: string
  autostart_orchestrator?: boolean
  command_preset_id?: string | null
  startup_command?: string | null
  example_task?: boolean
}): Promise<CreateWorkspaceResponse> => {
  const response = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create workspace'))
  }

  return (await response.json()) as CreateWorkspaceResponse
}

export const renameWorkspace = async (
  workspaceId: string,
  name: string
): Promise<WorkspaceSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rename workspace'))
  }

  return (await response.json()) as WorkspaceSummary
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete workspace'))
  }
}

export const startAgentRun = async (
  workspaceId: string,
  agentId: string
): Promise<{ runId: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start agent run'))
  }
  const body = (await response.json()) as { run_id: string }
  return { runId: body.run_id }
}

export const stopAgentRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/stop`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error('Failed to stop agent run')
  }
}

export interface ConfigureAgentLaunchInput {
  command?: string
  args?: string[]
  command_preset_id?: string | null
  startup_command?: string | null
}

export const configureAgentLaunch = async (
  workspaceId: string,
  agentId: string,
  input: ConfigureAgentLaunchInput
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update agent configuration'))
  }
}

export const restartAgentRun = async (
  workspaceId: string,
  agentId: string,
  runId: string
): Promise<{ runId: string }> => {
  // Best-effort stop: a 404 here often means the run already exited on its
  // own; either way we proceed to start a fresh one. Swallowed errors land in
  // the dev console for diagnosis.
  await stopAgentRun(runId).catch((error: unknown) => {
    console.error('[gachi] swallowed:restartAgentRun.stop', error)
  })
  return startAgentRun(workspaceId, agentId)
}

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id')

  if (!response.ok) {
    throw new Error('Failed to load active workspace')
  }

  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value
}

export const saveActiveWorkspaceId = async (workspaceId: string | null): Promise<void> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: workspaceId }),
  })

  if (!response.ok) {
    throw new Error('Failed to save active workspace')
  }
}

const HEARTBEAT_INTERVAL_APP_STATE_KEY = 'orchestrator_heartbeat_interval_ms'

export const getHeartbeatIntervalMs = async (): Promise<number | null> => {
  const response = await apiFetch(`/api/settings/app-state/${HEARTBEAT_INTERVAL_APP_STATE_KEY}`)
  if (!response.ok) {
    throw new Error('Failed to load heartbeat interval')
  }
  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value ? Number(payload.value) : null
}

export const saveHeartbeatIntervalMs = async (intervalMs: number): Promise<void> => {
  const response = await apiFetch(`/api/settings/app-state/${HEARTBEAT_INTERVAL_APP_STATE_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: String(intervalMs) }),
  })
  if (!response.ok) {
    throw new Error('Failed to save heartbeat interval')
  }
}

export const listWorkers = async (workspaceId: string): Promise<TeamListItem[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/team`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  const payload = (await response.json()) as TeamListItemPayload[]
  return payload.map(fromPayload)
}

export const listCommandPresets = async (): Promise<CommandPreset[]> => {
  const response = await apiFetch('/api/settings/command-presets')

  if (!response.ok) {
    throw new Error('Failed to load command presets')
  }

  return ((await response.json()) as CommandPresetPayload[]).map((preset) => ({
    args: preset.args,
    available: preset.available,
    command: preset.command,
    displayName: preset.display_name,
    id: preset.id,
  }))
}

export type TerminalInputProfile = 'default' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  terminal_input_profile?: TerminalInputProfile
}

export const workspaceShellAgentId = (workspaceId: string): string => `${workspaceId}:shell`

export const isWorkspaceShellRun = (run: TerminalRunSummary, workspaceId: string): boolean =>
  run.agent_id === workspaceShellAgentId(workspaceId)

export const startWorkspaceShell = async (workspaceId: string): Promise<TerminalRunSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/start`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start workspace terminal'))
  }

  return (await response.json()) as TerminalRunSummary
}

export const closeWorkspaceShell = async (workspaceId: string, runId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/${runId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to close workspace terminal'))
  }
}

export const listRoleTemplates = async (): Promise<RoleTemplate[]> => {
  const response = await apiFetch('/api/settings/role-templates', {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load role templates')
  }

  const payload = (await response.json()) as RoleTemplatePayload[]
  return payload.map(fromRoleTemplatePayload)
}

export const createRoleTemplate = async (input: RoleTemplateInput): Promise<RoleTemplate> => {
  const response = await apiFetch('/api/settings/role-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const updateRoleTemplate = async (
  templateId: string,
  input: RoleTemplateInput
): Promise<RoleTemplate> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const deleteRoleTemplate = async (templateId: string): Promise<void> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete role template'))
  }
}

export interface TeamTemplateWorker {
  name: string
  role: WorkerRole
  description: string
  commandPresetId: string | null
}

export interface TeamTemplate {
  id: string
  name: string
  workers: TeamTemplateWorker[]
}

interface TeamTemplateWorkerPayload {
  name: string
  role: WorkerRole
  description: string
  command_preset_id: string | null
}

interface TeamTemplatePayload {
  id: string
  name: string
  workers: TeamTemplateWorkerPayload[]
}

const fromTeamTemplatePayload = (payload: TeamTemplatePayload): TeamTemplate => ({
  id: payload.id,
  name: payload.name,
  workers: payload.workers.map((worker) => ({
    name: worker.name,
    role: worker.role,
    description: worker.description,
    commandPresetId: worker.command_preset_id,
  })),
})

export const listTeamTemplates = async (): Promise<TeamTemplate[]> => {
  const response = await apiFetch('/api/settings/team-templates', { mode: 'same-origin' })

  if (!response.ok) {
    throw new Error('Failed to load team templates')
  }

  const payload = (await response.json()) as TeamTemplatePayload[]
  return payload.map(fromTeamTemplatePayload)
}

export const createTeamTemplate = async (
  name: string,
  workers: TeamTemplateWorker[]
): Promise<TeamTemplate> => {
  const response = await apiFetch('/api/settings/team-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      workers: workers.map((worker) => ({
        name: worker.name,
        role: worker.role,
        description: worker.description,
        command_preset_id: worker.commandPresetId,
      })),
    }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save team template'))
  }

  return fromTeamTemplatePayload((await response.json()) as TeamTemplatePayload)
}

export const deleteTeamTemplate = async (templateId: string): Promise<void> => {
  const response = await apiFetch(`/api/settings/team-templates/${templateId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete team template'))
  }
}

export type MarketplaceLanguage = 'en'

export interface MarketplaceAgentEntry {
  path: string
  category: string
  name: string
  displayName?: string
  nameOverflows?: boolean
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
}

export interface MarketplaceManifest {
  source: {
    repo: string
    commit: string
    fetched_at: string
  }
  language: MarketplaceLanguage
  categories: string[]
  agents: MarketplaceAgentEntry[]
}

export interface MarketplaceAgentDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

export interface SkillPackage {
  description: string
  name: string
  rules: string[]
  skills: string[]
}

export const listSkillPackages = async (): Promise<SkillPackage[]> => {
  const response = await apiFetch('/api/skills', { mode: 'same-origin' })
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load skill packages'))
  return (await response.json()) as SkillPackage[]
}

export const installSkillPackage = async (
  workspaceId: string,
  name: string,
  role: 'coder' | 'reviewer' | 'tester' | 'custom' | 'orchestrator'
) => {
  const response = await apiFetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skills/install`,
    {
      method: 'POST',
      body: JSON.stringify({ name, role }),
      headers: { 'content-type': 'application/json' },
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to install skill package'))
  return (await response.json()) as { skill: string }
}

export const fetchMarketplaceManifest = async (
  lang: MarketplaceLanguage
): Promise<MarketplaceManifest> => {
  const response = await apiFetch(`/api/marketplace/manifest?lang=${lang}`, {
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace manifest'))
  }
  return (await response.json()) as MarketplaceManifest
}

export const fetchMarketplaceAgent = async (
  lang: MarketplaceLanguage,
  path: string
): Promise<MarketplaceAgentDetail> => {
  const response = await apiFetch(
    `/api/marketplace/agent?lang=${lang}&path=${encodeURIComponent(path)}`,
    { mode: 'same-origin' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace agent'))
  }
  return (await response.json()) as MarketplaceAgentDetail
}

export const listTerminalRuns = async (workspaceId: string): Promise<TerminalRunSummary[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/runs`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load terminal runs')
  }

  return (await response.json()) as TerminalRunSummary[]
}

export const createWorker = async (
  workspaceId: string,
  input: Pick<AgentSummary, 'name'> & {
    autostart?: boolean
    command_preset_id?: string | null
    description?: string
    role: WorkerRole
    startup_command?: string | null
  }
): Promise<CreateWorkerResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create worker'))
  }

  const payload = (await response.json()) as CreateWorkerPayload
  return {
    agentStart: {
      error: payload.agent_start?.error ?? null,
      ok: payload.agent_start?.ok ?? false,
      runId: payload.agent_start?.run_id ?? null,
    },
    worker: fromPayload(payload),
  }
}

export const deleteWorker = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete worker'))
  }
}

export const renameWorker = async (
  workspaceId: string,
  workerId: string,
  name: string
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rename worker'))
  }
}

export const updateWorker = async (
  workspaceId: string,
  workerId: string,
  input: { name?: string; description?: string }
): Promise<TeamListItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update worker'))
  }

  return fromPayload((await response.json()) as TeamListItemPayload)
}

export interface WorkspaceTasksResponse {
  content: string
  revision: string
}

export class TasksConflictError extends Error {
  readonly current: WorkspaceTasksResponse
  constructor(current: WorkspaceTasksResponse) {
    super('tasks.md was modified by someone else since you last loaded it')
    this.name = 'TasksConflictError'
    this.current = current
  }
}

export const getWorkspaceTasks = async (workspaceId: string): Promise<WorkspaceTasksResponse> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`)

  if (!response.ok) {
    throw new Error('Failed to load tasks')
  }

  return (await response.json()) as WorkspaceTasksResponse
}

export const saveWorkspaceTasks = async (
  workspaceId: string,
  input: { content: string; expectedRevision?: string }
): Promise<WorkspaceTasksResponse> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (response.status === 409) {
    throw new TasksConflictError((await response.json()) as WorkspaceTasksResponse)
  }
  if (!response.ok) {
    throw new Error('Failed to save tasks')
  }

  return (await response.json()) as WorkspaceTasksResponse
}

export interface FsBrowseEntryPayload {
  is_dir: true
  is_git_repository: boolean
  name: string
  path: string
}

export interface FsBrowseResponse {
  current_path: string
  entries: FsBrowseEntryPayload[]
  error: string | null
  ok: boolean
  parent_path: string | null
  root_path: string
}

export interface FsProbeResponse {
  current_branch: string | null
  exists: boolean
  is_dir: boolean
  is_git_repository: boolean
  ok: boolean
  path: string
  suggested_name: string
}

export const browseFs = async (path: string): Promise<FsBrowseResponse> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await apiFetch(`/api/fs/browse${query}`, { mode: 'same-origin' })
  const body = (await response.json()) as FsBrowseResponse
  return body
}

export const probeFs = async (path: string): Promise<FsProbeResponse> => {
  const response = await apiFetch(`/api/fs/probe?path=${encodeURIComponent(path)}`, {
    mode: 'same-origin',
  })
  return (await response.json()) as FsProbeResponse
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

export const pickFolder = async (): Promise<PickFolderResponse> => {
  const response = await apiFetch('/api/fs/pick-folder', {
    method: 'POST',
    mode: 'same-origin',
  })
  return (await response.json()) as PickFolderResponse
}

export interface ResolveFolderResponse {
  /** Unique matching directory, when exactly one candidate was found. */
  path: string | null
  /** Candidate absolute paths when the name is ambiguous (multiple matches). */
  matches: string[]
  error: string | null
}

/**
 * The browser's native folder picker only exposes the chosen folder's name,
 * so the server resolves that name back to a real path inside the browse root.
 */
export const resolveFolder = async (name: string): Promise<ResolveFolderResponse> => {
  const response = await apiFetch('/api/fs/resolve-folder', {
    method: 'POST',
    mode: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = (await response.json()) as ResolveFolderResponse
  if (!response.ok && !body.error && body.matches.length === 0) {
    return { path: null, matches: [], error: 'Failed to locate the selected folder.' }
  }
  return body
}

export type OpenWorkspaceResult =
  | { ok: true; effectiveTargetId: OpenTargetId }
  | { ok: false; effectiveTargetId: OpenTargetId; errorCode: OpenWorkspaceErrorCode }

interface OpenWorkspaceSuccessPayload {
  ok: true
  effective_target_id: OpenTargetId
}

interface OpenWorkspaceFailurePayload {
  ok: false
  effective_target_id: OpenTargetId
  error_code: OpenWorkspaceErrorCode
}

export const openWorkspaceInEditor = async (
  workspaceId: string,
  targetId: OpenTargetId
): Promise<OpenWorkspaceResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/open`, {
    body: JSON.stringify({ target_id: targetId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  // 200 success and 502 service failure both return structured JSON we can
  // surface; only true transport / 4xx failures (workspace gone, target id
  // tampered) throw.
  if (response.status === 200) {
    const body = (await response.json()) as OpenWorkspaceSuccessPayload
    return { ok: true, effectiveTargetId: body.effective_target_id }
  }
  if (response.status === 502) {
    const body = (await response.json()) as OpenWorkspaceFailurePayload
    return {
      ok: false,
      effectiveTargetId: body.effective_target_id,
      errorCode: body.error_code,
    }
  }
  throw new Error(await readErrorMessage(response, 'Failed to open workspace'))
}

export interface TaskCommentItem {
  id: string
  author: string
  authorRole?: string
  message: string
  timestamp: number
  /** Diff anchor for inline review comments (repo-relative path). */
  path?: string
  /** 1-based line in the new file version. */
  line?: number
}

export interface TaskRecordItem {
  id: string
  workspaceId: string
  title: string
  description: string
  /** Lineage: this card replaces/duplicates the referenced one. */
  supersededFrom?: string | null
  possibleDupOf?: string | null
  status: TaskStatus
  priority?: 'low' | 'normal' | 'high' | 'critical'
  assignedAgentId?: string
  result?: string
  artifacts?: string[]
  comments?: TaskCommentItem[]
  logs: string[]
  createdAt: number
  updatedAt: number
  /** Draft-plan grouping (ROADMAP R2). */
  planGroupId?: string
  plannedAt?: number
}

export const listTasks = async (workspaceId: string): Promise<TaskRecordItem[]> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks?format=store`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch tasks'))
  }
  const body = (await response.json()) as { tasks?: TaskRecordItem[] }
  return body.tasks ?? []
}

export const getTask = async (workspaceId: string, taskId: string): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch task'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export interface TaskDiffResponse {
  ok: true
  branch: string | null
  clean: boolean
  diff: string
  truncated: boolean
  untrackedFiles: string[]
}

export interface TaskDiffUnavailableResponse {
  ok: false
  error: string
}

export type TaskDiffResult = TaskDiffResponse | TaskDiffUnavailableResponse

export const getTaskDiff = async (workspaceId: string, taskId: string): Promise<TaskDiffResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}/diff`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch diff'))
  }
  return (await response.json()) as TaskDiffResult
}

export const addCommentToTask = async (
  workspaceId: string,
  taskId: string,
  author: string,
  message: string,
  authorRole?: string,
  anchor?: { path: string; line: number }
): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}/comments`, {
    body: JSON.stringify({
      author,
      message,
      author_role: authorRole,
      path: anchor?.path,
      line: anchor?.line,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to add comment'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export const createTask = async (
  workspaceId: string,
  input: { title: string; description?: string; assigned_worker_id?: string }
): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`, {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create task'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export const updateTask = async (
  workspaceId: string,
  taskId: string,
  updates: {
    title?: string
    description?: string
    status?: TaskStatus
    assigned_worker_id?: string | null
  }
): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, {
    body: JSON.stringify(updates),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update task'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export const logTask = async (
  workspaceId: string,
  taskId: string,
  message: string
): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}/logs`, {
    body: JSON.stringify({ message }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to log task'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export const deleteTask = async (workspaceId: string, taskId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete task'))
  }
}

export const dispatchTaskToWorker = async (
  workspaceId: string,
  taskId: string,
  workerId?: string
): Promise<TaskRecordItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}/dispatch`, {
    body: JSON.stringify({ worker_id: workerId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to dispatch task'))
  }
  const body = (await response.json()) as { task: TaskRecordItem }
  return body.task
}

export const pauseAgentRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/pause`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to pause agent run'))
  }
}

export const resumeAgentRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/resume`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to resume agent run'))
  }
}

export const resetWorkerStatus = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}/reset`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to reset worker status'))
  }
}

export const uploadWorkspaceAttachment = async (
  workspaceId: string,
  dataBase64: string,
  filename?: string
): Promise<{ ok: boolean; filename: string; relative_path: string; absolute_path: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/attachments`, {
    body: JSON.stringify({ filename, data_base64: dataBase64 }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to upload attachment'))
  }
  return response.json()
}

export interface ProviderSubscriptionLimit {
  id: 'claude' | 'codex' | 'agy' | 'opencode'
  name: string
  icon: string
  tier: string
  status: 'active' | 'unconfigured' | 'error'
  authStatus: string
  availability: string
  details: string
  lastCheckedAt: number
}

export const fetchSubscriptionLimits = async (): Promise<ProviderSubscriptionLimit[]> => {
  const response = await apiFetch('/api/subscription-limits')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch subscription limits'))
  }
  const data = (await response.json()) as { limits: ProviderSubscriptionLimit[] }
  return data.limits
}

export interface TelegramLinkItem {
  chat_id: string
  user_id: string
  username: string | null
  role: 'owner' | 'operator' | 'viewer'
  workspace_id: string | null
  linked_at: number
}

export interface TelegramSettings {
  config: {
    enabled: boolean
    tokenSet: boolean
    botUsername: string | null
    lastError: string | null
    /** Effective proxy in use (masked), null = direct connection. */
    proxy: string | null
    apiRoot: string
  }
  links: TelegramLinkItem[]
  available_events: string[]
}

export const fetchTelegramSettings = async (): Promise<TelegramSettings> => {
  const response = await apiFetch('/api/settings/telegram')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch Telegram settings'))
  }
  return (await response.json()) as TelegramSettings
}

export const updateTelegramSettings = async (input: {
  enabled?: boolean
  token?: string | null
  proxy_url?: string | null
  api_root?: string | null
}): Promise<TelegramSettings['config']> => {
  const response = await apiFetch('/api/settings/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update Telegram settings'))
  }
  const data = (await response.json()) as { config: TelegramSettings['config'] }
  return data.config
}

export const verifyTelegramToken = async (token: string): Promise<string> => {
  const response = await apiFetch('/api/settings/telegram/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Token verification failed'))
  }
  const data = (await response.json()) as { bot_username: string }
  return data.bot_username
}

/** Verifies the STORED token — works after saving, no re-typing needed. */
export const testTelegramConnection = async (): Promise<{
  ok: boolean
  bot_username?: string
  error?: string
}> => {
  const response = await apiFetch('/api/settings/telegram/test', { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Connection test failed'))
  }
  return (await response.json()) as { ok: boolean; bot_username?: string; error?: string }
}

export interface PrStatus {
  auto_pr_enabled: boolean
  deploy_hook_command: string | null
  worker_permission_mode?: 'allow-all' | 'ask'
  dispatch_paused?: boolean
  error: string | null
  installed: boolean
  open_prs: Array<{
    head: string
    number: number | null
    state: string
    title: string
    url: string
  }>
}

/** R10 risky-automation registry: per-workspace post-merge automations. */
export const fetchPrStatus = async (workspaceId: string): Promise<PrStatus> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/pr/status`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch PR status'))
  }
  return (await response.json()) as PrStatus
}

export const setAutoPr = async (workspaceId: string, enabled: boolean): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/auto-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update auto-PR'))
  }
}

export const setDeployHook = async (workspaceId: string, command: string | null): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/deploy-hook`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update deploy hook'))
  }
}

/** R10: `ask` keeps TUI dialogs for the human instead of auto-answering. */
export const setPermissionMode = async (
  workspaceId: string,
  mode: 'allow-all' | 'ask'
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/permissions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update permission mode'))
  }
}

/** R10: resume dispatch after the error budget paused it. */
export const setDispatchPaused = async (workspaceId: string, paused: boolean): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/dispatch-pause`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update dispatch pause'))
  }
}

export interface AgentDiscoveryModel {
  context_window: number | null
  id: string
  name: string
  reasoning: boolean
}

export interface AgentDiscoveryItem {
  authenticated: boolean
  auth_error: string | null
  auth_method: 'api-key' | 'oauth' | null
  installed: boolean
  models: AgentDiscoveryModel[]
  name: string
  path: string | null
  version: string | null
}

export interface AgentDiscoveryReport {
  agents: AgentDiscoveryItem[]
  scanned_at: number
}

export const fetchAgentDiscovery = async (): Promise<AgentDiscoveryReport> => {
  const response = await apiFetch('/api/agents/discovery')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch discovery'))
  }
  return (await response.json()) as AgentDiscoveryReport
}

export const rescanAgentDiscovery = async (): Promise<AgentDiscoveryReport> => {
  const response = await apiFetch('/api/agents/discovery/rescan', { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rescan'))
  }
  return (await response.json()) as AgentDiscoveryReport
}

// --- Agent control plane (spec Part 2, Wave 2.9 dashboard) ---

export interface AgentCapabilityFeatures {
  context_control: boolean
  model_switch: boolean
  reasoning_control: boolean
}

export interface AgentControlStateItem {
  agent_id: string
  capability: {
    context_commands: { clear: string | null; compact: string | null }
    display_name: string
    features: AgentCapabilityFeatures
    provider: string
    resume_supported: boolean
    suggested_models: string[]
    supported_reasoning_levels: string[]
  } | null
  context_percent: number | null
  model: string | null
  provider: string | null
  reasoning_level: string | null
  running: boolean
  tokens_used: number | null
  usage_updated_at: number | null
  workspace_id: string
}

export interface AgentControlSummary {
  agents: Array<AgentControlStateItem & { name: string; role: string; status: string }>
  tasks: Record<'assigned' | 'backlog' | 'done' | 'failed' | 'ready' | 'review' | 'running', number>
}

export const fetchControlSummary = async (workspaceId: string): Promise<AgentControlSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/control/summary`)
  if (!response.ok) throw await parseControlError(response, 'Failed to fetch swarm summary')
  return (await response.json()) as AgentControlSummary
}

export const sendAgentInput = async (
  workspaceId: string,
  agentId: string,
  text: string
): Promise<{ delivered: boolean; run_id: string }> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/control/input`,
    {
      body: JSON.stringify({ text }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) throw await parseControlError(response, 'Follow-up delivery failed')
  return (await response.json()) as { delivered: boolean; run_id: string }
}

export interface WorkspaceMetricsItem {
  window_hours: number
  generated_at: number
  tasks: {
    done: number
    failed: number
    success_rate: number | null
    avg_task_duration_ms: number | null
  }
  tokens_total: number
  agents: Array<{
    agentId: string
    lastTokensUsed: number | null
    peakContextPercent: number | null
  }>
  samples: Array<{
    agentId: string
    contextPercent: number | null
    tokensUsed: number | null
    sampledAt: number
    tokensDelta: number | null
  }>
}

export const fetchWorkspaceMetrics = async (
  workspaceId: string,
  windowHours?: number
): Promise<WorkspaceMetricsItem> => {
  const query = windowHours ? `?window_hours=${windowHours}` : ''
  const response = await apiFetch(`/api/workspaces/${workspaceId}/metrics${query}`)
  if (!response.ok) throw await parseControlError(response, 'Failed to fetch metrics')
  return (await response.json()) as WorkspaceMetricsItem
}

export const approvePlan = async (
  workspaceId: string,
  planGroupId: string
): Promise<{ approved: number; total: number }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/plans/${planGroupId}/approve`, {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw await parseControlError(response, 'Plan approval failed')
  return (await response.json()) as { approved: number; total: number }
}

export const discardPlan = async (
  workspaceId: string,
  planGroupId: string
): Promise<{ deleted: number; kept: number }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/plans/${planGroupId}`, {
    method: 'DELETE',
  })
  if (!response.ok) throw await parseControlError(response, 'Plan discard failed')
  return (await response.json()) as { deleted: number; kept: number }
}

const parseControlError = async (response: Response, fallback: string): Promise<Error> => {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new Error(body?.error ?? fallback)
}

export const fetchAgentControl = async (
  workspaceId: string,
  agentId: string
): Promise<AgentControlStateItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/control`)
  if (!response.ok) throw await parseControlError(response, 'Failed to fetch control state')
  return (await response.json()) as AgentControlStateItem
}

export const setAgentReasoning = async (
  workspaceId: string,
  agentId: string,
  level: 'high' | 'low' | 'medium'
): Promise<AgentControlStateItem> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/control/reasoning`,
    {
      body: JSON.stringify({ level }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) throw await parseControlError(response, 'Reasoning switch failed')
  return (await response.json()) as AgentControlStateItem
}

export const runAgentContextAction = async (
  workspaceId: string,
  agentId: string,
  action: 'clear' | 'compact'
): Promise<void> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/control/context`,
    {
      body: JSON.stringify({ action }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) throw await parseControlError(response, 'Context action failed')
}

/** Hard-restarts the agent run (stop → start with the same launch config). */
export const restartAgentControl = async (workspaceId: string, agentId: string): Promise<void> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/control/restart`,
    { body: JSON.stringify({}), headers: { 'content-type': 'application/json' }, method: 'POST' }
  )
  if (!response.ok) throw await parseControlError(response, 'Restart failed')
}

/** Starts a NEW run resuming the last captured session id for this agent. */
export const resumeAgentSession = async (workspaceId: string, agentId: string): Promise<void> => {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agents/${agentId}/control/resume-session`,
    { body: JSON.stringify({}), headers: { 'content-type': 'application/json' }, method: 'POST' }
  )
  if (!response.ok) throw await parseControlError(response, 'Session resume failed')
}

export const createTelegramPairingCode = async (): Promise<{
  code: string
  expires_at: number
}> => {
  const response = await apiFetch('/api/settings/telegram/pairing', { method: 'POST' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create pairing code'))
  }
  return (await response.json()) as { code: string; expires_at: number }
}

export const removeTelegramLink = async (chatId: string, userId: string): Promise<void> => {
  const response = await apiFetch(
    `/api/settings/telegram/links/${encodeURIComponent(userId)}?chat_id=${encodeURIComponent(chatId)}`,
    { method: 'DELETE' }
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(await readErrorMessage(response, 'Failed to remove Telegram link'))
  }
}
