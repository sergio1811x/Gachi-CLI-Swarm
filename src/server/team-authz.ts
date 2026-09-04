import type { AgentSummary } from '../shared/types.js'
import { ForbiddenError, UnauthorizedError } from './http-errors.js'

export type TeamCommand =
  | 'send'
  | 'list'
  | 'report'
  | 'request'
  | 'status'
  | 'cancel'
  | 'engine'
  | 'accept'
  | 'approve'
  | 'rework'
  | 'reject'
  | 'events'
  | 'help'
  | 'workers'
  | 'pr'
  | 'model'

const ORCHESTRATOR_COMMANDS = new Set<TeamCommand>([
  'send',
  'list',
  'cancel',
  'engine',
  'accept',
  'approve',
  'rework',
  'reject',
  'events',
  'help',
  // Orchestrator-only workforce management (add/start/stop/remove workers).
  'workers',
  // Publishing branches / opening pull requests is a remote-visible action.
  'pr',
  // Switching an agent's model changes what it can see and spend.
  'model',
])
// Workers are told in their startup instructions that `team list` shows workspace
// members and status — it's a harmless read of already-workspace-local data, so the
// permission model should actually grant what the docs promise instead of 403ing it.
// `request` asks a human for permission before a risky action (Telegram approval flow).
const WORKER_COMMANDS = new Set<TeamCommand>([
  'report',
  'status',
  'list',
  'events',
  'help',
  'send',
  'request',
])

export const commandAllowedForRole = (role: AgentSummary['role'], command: TeamCommand) => {
  if (role === 'orchestrator') return ORCHESTRATOR_COMMANDS.has(command)
  return WORKER_COMMANDS.has(command)
}

interface AuthenticateInput {
  fromAgentId: string | undefined
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  token: string | undefined
  validateToken: (agentId: string, token: string | undefined) => boolean
  workspaceId: string
}

export const authenticateCliAgent = ({
  fromAgentId,
  getAgent,
  token,
  validateToken,
  workspaceId,
}: AuthenticateInput): AgentSummary => {
  if (!fromAgentId) {
    throw new UnauthorizedError('Missing agent identity')
  }
  if (!validateToken(fromAgentId, token)) {
    throw new UnauthorizedError('Invalid or missing agent token')
  }
  let agent: AgentSummary
  try {
    agent = getAgent(workspaceId, fromAgentId)
  } catch {
    throw new UnauthorizedError('Agent not found in workspace')
  }
  return agent
}

export const requireCommandForRole = (agent: AgentSummary, command: TeamCommand) => {
  if (!commandAllowedForRole(agent.role, command)) {
    throw new ForbiddenError(`Role '${agent.role}' is not allowed to run team ${command}`)
  }
}
