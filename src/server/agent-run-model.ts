import type { AgentLifecycleStatus } from '../shared/types.js'

import type { AgentRunRecordStore } from './agent-run-record-store.js'

export type AgentRuntimeState = 'starting' | 'running' | 'exited' | 'error'

/**
 * Unified model of an agent runtime run. Aggregates the process-level state
 * (PTY snapshot), the orchestration lifecycle, heartbeat freshness, task
 * binding and the last PTY output into a single object so the rest of the
 * runtime never has to merge five stores by hand.
 */
export interface AgentRun {
  id: string
  taskId: string | null
  agentId: string
  workspaceId: string
  pid: number | null
  runtimeState: AgentRuntimeState
  lifecycleState: AgentLifecycleStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  lastHeartbeat: number | null
  lastOutput: string
  error: string | null
}

interface RegisterAgentRunInput {
  agentId: string
  id: string
  pid: number | null
  runtimeState: AgentRuntimeState
  startedAt: number
  workspaceId: string
}

const isActive = (run: AgentRun) =>
  run.runtimeState === 'starting' || run.runtimeState === 'running'

export interface AgentRunModel {
  bindTask: (runId: string, taskId: string) => void
  complete: (runId: string, exitCode: number | null, endedAt: number) => void
  get: (runId: string) => AgentRun | undefined
  getActiveForAgent: (workspaceId: string, agentId: string) => AgentRun | undefined
  listActive: () => AgentRun[]
  listAll: () => AgentRun[]
  recordHeartbeat: (runId: string, at: number) => void
  recordOutput: (runId: string, chunk: string) => void
  register: (input: RegisterAgentRunInput) => AgentRun
  remove: (runId: string) => void
  updateError: (runId: string, error: string | null) => void
  updateRuntimeState: (runId: string, state: AgentRuntimeState) => void
}

const MAX_LAST_OUTPUT_LENGTH = 10_000

interface AgentRunModelOptions {
  /** When provided the model hydrates active runs on startup and persists every mutation. */
  recordStore?: AgentRunRecordStore
}

export const createAgentRunModel = (options: AgentRunModelOptions = {}): AgentRunModel => {
  const recordStore = options.recordStore
  const runs = new Map<string, AgentRun>()

  const hydrate = () => {
    if (!recordStore) return
    for (const record of recordStore.listActive()) {
      runs.set(record.id, {
        id: record.id,
        taskId: record.taskId,
        agentId: record.agentId,
        workspaceId: record.workspaceId,
        pid: record.pid,
        runtimeState: record.runtimeState,
        lifecycleState: record.lifecycleState,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        lastHeartbeat: record.lastHeartbeat,
        lastOutput: record.lastOutput,
        error: record.error,
      })
    }
  }
  hydrate()

  const get = (runId: string) => {
    const run = runs.get(runId)
    return run ? { ...run } : undefined
  }

  const persist = (run: AgentRun, patch: Partial<AgentRun>) => {
    if (!recordStore) return
    recordStore.updateRun(run.id, { ...patch, updatedAt: Date.now() })
  }

  return {
    bindTask(runId, taskId) {
      const run = runs.get(runId)
      if (!run) return
      run.taskId = taskId
      persist(run, { taskId })
    },
    complete(runId, exitCode, endedAt) {
      const run = runs.get(runId)
      if (!run) return
      run.runtimeState = exitCode === 0 ? 'exited' : 'error'
      run.exitCode = exitCode
      run.endedAt = endedAt
      persist(run, { runtimeState: run.runtimeState, exitCode, endedAt })
    },
    get,
    getActiveForAgent(workspaceId, agentId) {
      for (const run of runs.values()) {
        if (run.agentId === agentId && run.workspaceId === workspaceId && isActive(run)) {
          return { ...run }
        }
      }
      return undefined
    },
    listActive() {
      return Array.from(runs.values())
        .filter(isActive)
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((run) => ({ ...run }))
    },
    listAll() {
      return Array.from(runs.values())
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((run) => ({ ...run }))
    },
    recordHeartbeat(runId, at) {
      const run = runs.get(runId)
      if (!run) return
      run.lastHeartbeat = at
      persist(run, { lastHeartbeat: at })
    },
    recordOutput(runId, chunk) {
      const run = runs.get(runId)
      if (!run) return
      run.lastOutput = `${run.lastOutput}${chunk}`.slice(-MAX_LAST_OUTPUT_LENGTH)
      persist(run, { lastOutput: run.lastOutput })
    },
    register(input) {
      const run: AgentRun = {
        id: input.id,
        taskId: null,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        pid: input.pid,
        runtimeState: input.runtimeState,
        lifecycleState: 'starting',
        startedAt: input.startedAt,
        endedAt: null,
        exitCode: null,
        lastHeartbeat: null,
        lastOutput: '',
        error: null,
      }
      runs.set(run.id, run)
      if (recordStore) {
        recordStore.upsertRun({ ...run, createdAt: run.startedAt, updatedAt: run.startedAt })
      }
      return { ...run }
    },
    remove(runId) {
      runs.delete(runId)
      recordStore?.deleteRun(runId)
    },
    updateError(runId, error) {
      const run = runs.get(runId)
      if (!run) return
      run.error = error
      persist(run, { error })
    },
    updateRuntimeState(runId, state) {
      const run = runs.get(runId)
      if (!run) return
      run.runtimeState = state
      persist(run, { runtimeState: state })
    },
  }
}

export type { RegisterAgentRunInput }
