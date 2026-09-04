import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'

import { type AgentLifecycleState, assertAgentLifecycleTransition } from './agent-lifecycle.js'

interface AgentLifecycleRow {
  last_error: string | null
  run_id: string | null
  state: AgentLifecycleState
  updated_at: number
}

export interface AgentLifecycleRecord {
  lastError: string | null
  runId: string | null
  state: AgentLifecycleState
  updatedAt: number
}

export interface AgentLifecycleStore {
  get: (workspaceId: string, agentId: string) => AgentLifecycleRecord | undefined
  markUnfinishedAsStopped: (reason?: string) => void
  transition: (
    workspaceId: string,
    agentId: string,
    state: AgentLifecycleState,
    input?: { error?: string | null; reason?: string; runId?: string | null }
  ) => AgentLifecycleRecord
}

export const createAgentLifecycleStore = (db: Database): AgentLifecycleStore => {
  const get = (workspaceId: string, agentId: string): AgentLifecycleRecord | undefined => {
    const row = db
      .prepare(
        'SELECT state, run_id, last_error, updated_at FROM agent_lifecycles WHERE workspace_id = ? AND agent_id = ?'
      )
      .get(workspaceId, agentId) as AgentLifecycleRow | undefined
    if (!row) return undefined
    return {
      state: row.state,
      runId: row.run_id,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }
  }

  const transition = (
    workspaceId: string,
    agentId: string,
    state: AgentLifecycleState,
    input: { error?: string | null; reason?: string; runId?: string | null } = {}
  ): AgentLifecycleRecord => {
    const current = get(workspaceId, agentId)
    const fromState = current?.state ?? 'created'
    assertAgentLifecycleTransition(fromState, state)
    const updatedAt = Date.now()
    const runId = input.runId === undefined ? (current?.runId ?? null) : input.runId
    const lastError = input.error === undefined ? (current?.lastError ?? null) : input.error

    db.transaction(() => {
      db.prepare(
        `INSERT INTO agent_lifecycles (workspace_id, agent_id, state, run_id, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
           state = excluded.state,
           run_id = excluded.run_id,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      ).run(workspaceId, agentId, state, runId, lastError, updatedAt)
      db.prepare(
        `INSERT INTO agent_lifecycle_events (
           id, workspace_id, agent_id, from_state, to_state, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        workspaceId,
        agentId,
        current?.state ?? null,
        state,
        input.reason ?? null,
        updatedAt
      )
    })()

    return { state, runId, lastError, updatedAt }
  }

  /**
   * Boot-time sweep after a daemon crash/restart. The WORKER did not fail —
   * the runtime died under it (OOM, native ConPTY crash), so `failed` here
   * lied to the orchestrator ("failed вообще у всех"). `stopped` is the
   * honest terminal state and matches the summary status the exit path sets.
   * Genuine failures still reach `failed` via the exit/watchdog paths.
   */
  const markUnfinishedAsStopped = (reason = 'runtime_restarted') => {
    const rows = db
      .prepare(
        `SELECT workspace_id, agent_id
         FROM agent_lifecycles
         WHERE state IN ('starting', 'ready', 'working', 'waiting', 'waiting_input', 'stuck', 'handoff', 'stopping')`
      )
      .all() as Array<{ agent_id: string; workspace_id: string }>
    for (const row of rows) {
      transition(row.workspace_id, row.agent_id, 'stopped', {
        error: 'Daemon restarted while the worker was up — process ended with the runtime',
        reason,
        runId: null,
      })
    }
  }

  return { get, markUnfinishedAsStopped, transition }
}
