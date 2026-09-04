import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

const clearResumedSessionOnFailure = (
  context: Pick<
    AgentRunExitContext,
    'agentId' | 'registry' | 'sessionStore' | 'startConfig' | 'workspace'
  >,
  { exitCode, runId }: { exitCode: number | null; runId: string }
) => {
  if (exitCode === 0 || !context.startConfig.resumedSessionId) return
  // A stop we initiated (manual stop, supervisor restart, app shutdown) says
  // nothing about the session id — the CLI never got a chance to live. Wiping
  // the stored id here is how every app restart used to send workers into a
  // fresh session. Only a CLI that died on its own right after failing to open
  // the session counts; genuinely stale ids are also re-verified at the next
  // launch (doesCapturedSessionExist).
  if (context.registry.wasStopRequested(runId)) return
  context.sessionStore.clearLastSessionId(context.workspace.id, context.agentId)
}

export const handleAgentRunExit = (
  context: AgentRunExitContext,
  { exitCode, endedAt, runId }: HandleRunExitInput
) => {
  context.registry.setPendingExitCode(runId, exitCode)
  const liveRun = context.registry.get(runId)
  if (!liveRun) {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    return false
  }
  if (context.handledRunExits.has(runId)) {
    context.registry.clearPendingExitCode(runId)
    return false
  }

  completeLiveRun(liveRun, exitCode, endedAt, context.store)
  clearResumedSessionOnFailure(context, { exitCode, runId })
  context.handledRunExits.add(runId)
  context.onRunExited?.(runId, context.agentId, context.workspace.id, exitCode, endedAt)
  context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
  context.onAgentExit(context.workspace.id, context.agentId)
  context.registry.resolveExit(runId)
  context.registry.clearPendingExitCode(runId)
  return true
}
