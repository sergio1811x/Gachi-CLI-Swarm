import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { waitForStopEscalations } from './process-tree-kill.js'

export const closeAgentRuntime = async (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun
) => {
  const runs = registry.list()
  for (const run of runs) {
    syncRun(run)
    // A shutdown kill is not a CLI failure — the exit handler relies on this
    // flag to keep the workers' stored session ids intact for the next boot.
    registry.markStopRequested(run.runId)
    agentManager?.stopRun(run.runId)
  }

  await Promise.all(registry.listExitEntries().map((entry) => entry.promise))

  // Give pending tree-kill escalations (Windows ConPTY survivors) a bounded
  // chance to finish before the daemon exits.
  await waitForStopEscalations()

  for (const run of registry.list()) {
    agentManager?.removeRun(run.runId)
    registry.remove(run.runId)
  }
}
