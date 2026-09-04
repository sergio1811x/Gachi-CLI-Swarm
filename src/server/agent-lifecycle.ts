import {
  type AgentLifecycleStatus,
  agentLifecycleStatuses as agentLifecycleStates,
} from '../shared/types.js'

export { agentLifecycleStates }
export type AgentLifecycleState = AgentLifecycleStatus

const allowedTransitions: Readonly<Record<AgentLifecycleState, readonly AgentLifecycleState[]>> = {
  created: ['starting', 'stopped'],
  starting: ['ready', 'stopping', 'stopped', 'failed'],
  ready: [
    'working',
    'waiting',
    'waiting_input',
    'stuck',
    'handoff',
    'stopping',
    'stopped',
    'failed',
  ],
  working: [
    'ready',
    'waiting',
    'waiting_input',
    'stuck',
    'handoff',
    'stopping',
    'stopped',
    'failed',
  ],
  waiting: ['ready', 'working', 'stopping', 'stopped', 'failed'],
  waiting_input: ['ready', 'working', 'stopping', 'stopped', 'failed'],
  stuck: ['working', 'ready', 'stopping', 'stopped', 'failed'],
  handoff: ['starting', 'stopping', 'stopped', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['starting'],
  // A failed worker may be brought back to the ready pool by the dispatcher
  // or an operator restart — without this, one crash permanently benched the
  // agent (dispatcher hit `failed -> ready` and threw).
  failed: ['ready', 'starting', 'stopped'],
}

export const canTransitionAgentLifecycle = (
  from: AgentLifecycleState,
  to: AgentLifecycleState
): boolean => from === to || allowedTransitions[from].includes(to)

export const assertAgentLifecycleTransition = (
  from: AgentLifecycleState,
  to: AgentLifecycleState
): void => {
  if (!canTransitionAgentLifecycle(from, to)) {
    throw new Error(`Invalid agent lifecycle transition: ${from} -> ${to}`)
  }
}
