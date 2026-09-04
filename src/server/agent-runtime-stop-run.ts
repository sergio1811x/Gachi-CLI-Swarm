import type { AgentDriverRuntime } from './agent-driver-runtime.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const stopLiveRun = (
  driver: Pick<AgentDriverRuntime, 'captureState' | 'stop'> | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  runId: string
) => {
  if (!driver) {
    // No PTY driver (headless runtime) means there is no live process to stop.
    // A no-op here keeps stop/delete flows from hard-failing when no agent
    // manager is present. The run record itself is completed by the caller.
    return
  }

  const liveRun = registry.get(runId)
  if (liveRun) {
    const status = syncRun(liveRun).status
    if (status === 'exited' || status === 'error') {
      return
    }
  } else if (['error', 'exited'].includes(driver.captureState(runId).status)) {
    return
  }

  // Record that THIS side killed the run before the PTY exit event fires —
  // the exit handler must not treat a stop we initiated as evidence that the
  // CLI's session id is broken.
  registry.markStopRequested(runId)
  driver.stop(runId)
}
