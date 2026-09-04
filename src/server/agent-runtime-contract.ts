import type { WorkspaceSummary } from '../shared/types.js'

import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface StartAgentOptions {
  gachiPort: string
}

export interface AgentRuntime {
  close: () => Promise<void>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: import('./agent-run-store.js').AgentLaunchConfigInput
  ) => void
  deleteAgentLaunchConfig: (workspaceId: string, agentId: string) => void
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => import('./agent-run-store.js').AgentLaunchConfigInput | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  getPtyOutputBus: () => PtyOutputBus
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  pauseRun: (runId: string) => void
  pauseRunOutput?: (runId: string) => void
  peekAgentToken: (agentId: string) => string | undefined
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  resumeRunOutput?: (runId: string) => void
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  stopAgentRun: (runId: string) => void
  waitForAgentRunExit: (runId: string) => Promise<void>
  validateAgentToken: AgentTokenRegistry['validate']
  writeReportPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean; taskId?: string }
  ) => void
  writeStatusPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean }
  ) => void
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    fromAgentName: string,
    workerDescription: string,
    text: string,
    onDelivered?: () => void
  ) => void
  writeCancelPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    reason: string,
    input?: { requireActiveRun?: boolean }
  ) => void
  writeUserInputPrompt: (workspaceId: string, text: string) => boolean
  writeHeartbeatPrompt: (workspaceId: string) => boolean
  writeWorkerReportNudge: (workspaceId: string, workerId: string, payload?: string) => void
  /**
   * Engine-aware interactive write (prompt-ready wait → bracketed paste →
   * delayed separate CR submit) — the dispatch seam. False when the agent has
   * no writable run.
   */
  writeInteractiveInput: (workspaceId: string, agentId: string, text: string) => boolean
  /** Best-effort raw orchestrator injection; false when there is no writable run. */
  writeOrchestratorPrompt?: (workspaceId: string, payload: string) => boolean
  writeTaskQueueUpdatePrompt: (
    workspaceId: string,
    action: string,
    task: {
      id: string
      title: string
      status: string
      assignedWorkerName?: string | undefined
      details?: string | undefined
    }
  ) => void
}

export type { StartAgentOptions }
