import type { Database } from 'better-sqlite3'

import type { AgentLifecycleStatus } from '../shared/types.js'
import type { AgentRuntimeState } from './agent-run-model.js'

/**
 * Persisted view of an AgentRun record. Shares the `agent_runs` table with the
 * legacy run-persistence helpers in `agent-run-store.ts`; the supervisor model
 * writes through UPSERT so both writers can coexist safely.
 */
export interface PersistedAgentRunRecord {
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
  createdAt: number
  updatedAt: number
}

export type AgentRunRecordPatch = Partial<Omit<PersistedAgentRunRecord, 'id' | 'createdAt'>>

export interface AgentRunRecordStore {
  deleteRun: (runId: string) => void
  getActiveForAgent: (workspaceId: string, agentId: string) => PersistedAgentRunRecord | undefined
  getRun: (runId: string) => PersistedAgentRunRecord | undefined
  listActive: () => PersistedAgentRunRecord[]
  listAll: () => PersistedAgentRunRecord[]
  listRecent: (limit: number) => PersistedAgentRunRecord[]
  updateRun: (runId: string, patch: AgentRunRecordPatch) => void
  upsertRun: (record: PersistedAgentRunRecord) => void
}

interface AgentRunRow {
  run_id: string
  agent_id: string
  workspace_id: string | null
  task_id: string | null
  pid: number | null
  status: string
  lifecycle_state: string | null
  started_at: number
  ended_at: number | null
  exit_code: number | null
  last_heartbeat: number | null
  last_output: string | null
  error: string | null
  created_at: number
  updated_at: number
}

const normalizeRuntimeState = (status: string): AgentRuntimeState => {
  if (status === 'running' || status === 'starting' || status === 'exited' || status === 'error') {
    return status
  }
  return 'starting'
}

const mapRow = (row: AgentRunRow): PersistedAgentRunRecord => ({
  id: row.run_id,
  taskId: row.task_id,
  agentId: row.agent_id,
  workspaceId: row.workspace_id ?? '',
  pid: row.pid,
  runtimeState: normalizeRuntimeState(row.status),
  lifecycleState: (row.lifecycle_state ?? 'starting') as AgentLifecycleStatus,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  exitCode: row.exit_code,
  lastHeartbeat: row.last_heartbeat,
  lastOutput: row.last_output ?? '',
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const COLUMN_BY_PATCH_KEY: Record<string, string> = {
  taskId: 'task_id',
  pid: 'pid',
  runtimeState: 'status',
  lifecycleState: 'lifecycle_state',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  exitCode: 'exit_code',
  lastHeartbeat: 'last_heartbeat',
  lastOutput: 'last_output',
  error: 'error',
  updatedAt: 'updated_at',
}

export const createAgentRunRecordStore = (db: Database): AgentRunRecordStore => {
  const upsertStatement = db.prepare(`
    INSERT INTO agent_runs (
      run_id, agent_id, workspace_id, task_id, pid, status, lifecycle_state,
      started_at, ended_at, exit_code, last_heartbeat, last_output, error,
      created_at, updated_at
    ) VALUES (
      @run_id, @agent_id, @workspace_id, @task_id, @pid, @status, @lifecycle_state,
      @started_at, @ended_at, @exit_code, @last_heartbeat, @last_output, @error,
      @created_at, @updated_at
    )
    ON CONFLICT(run_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      workspace_id = excluded.workspace_id,
      task_id = excluded.task_id,
      pid = excluded.pid,
      status = excluded.status,
      lifecycle_state = excluded.lifecycle_state,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      exit_code = excluded.exit_code,
      last_heartbeat = excluded.last_heartbeat,
      last_output = excluded.last_output,
      error = excluded.error,
      updated_at = excluded.updated_at
  `)

  const getStatement = db.prepare('SELECT * FROM agent_runs WHERE run_id = ?')
  const activeStatement = db.prepare(
    `SELECT * FROM agent_runs WHERE status IN ('starting', 'running') ORDER BY started_at DESC`
  )
  const allStatement = db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC')
  const recentStatement = db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?')
  const deleteStatement = db.prepare('DELETE FROM agent_runs WHERE run_id = ?')
  const updateStatements = new Map<string, ReturnType<Database['prepare']>>()

  const getUpdateStatement = (patch: AgentRunRecordPatch) => {
    const keys = Object.keys(patch).filter((key) => COLUMN_BY_PATCH_KEY[key] !== undefined)
    if (keys.length === 0) return undefined
    const sql = `UPDATE agent_runs SET ${keys
      .map((key) => `${COLUMN_BY_PATCH_KEY[key]} = @${key}`)
      .join(', ')} WHERE run_id = @run_id`
    let statement = updateStatements.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      updateStatements.set(sql, statement)
    }
    return statement
  }

  return {
    deleteRun(runId) {
      deleteStatement.run(runId)
    },
    getActiveForAgent(workspaceId, agentId) {
      for (const row of activeStatement.all() as AgentRunRow[]) {
        if (row.workspace_id === workspaceId && row.agent_id === agentId) {
          return mapRow(row)
        }
      }
      return undefined
    },
    getRun(runId) {
      const row = getStatement.get(runId) as AgentRunRow | undefined
      return row ? mapRow(row) : undefined
    },
    listActive() {
      return (activeStatement.all() as AgentRunRow[]).map(mapRow)
    },
    listAll() {
      return (allStatement.all() as AgentRunRow[]).map(mapRow)
    },
    listRecent(limit) {
      return (recentStatement.all(limit) as AgentRunRow[]).map(mapRow)
    },
    updateRun(runId, patch) {
      const statement = getUpdateStatement(patch)
      if (!statement) return
      statement.run({ ...patch, run_id: runId })
    },
    upsertRun(record) {
      upsertStatement.run({
        run_id: record.id,
        agent_id: record.agentId,
        workspace_id: record.workspaceId,
        task_id: record.taskId,
        pid: record.pid,
        status: record.runtimeState,
        lifecycle_state: record.lifecycleState,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        exit_code: record.exitCode,
        last_heartbeat: record.lastHeartbeat,
        last_output: record.lastOutput,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
    },
  }
}
