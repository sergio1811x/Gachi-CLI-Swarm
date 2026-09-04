import type { Database } from 'better-sqlite3'

import type { AgentLifecycleStatus, AgentStatus } from '../shared/types.js'

export type HeartbeatAgentStatus = AgentStatus | AgentLifecycleStatus

export interface AgentHeartbeat {
  agentId: string
  status: HeartbeatAgentStatus | null
  phase: string | null
  currentAction: string | null
  lastSeen: number
}

interface AgentHeartbeatRow {
  agent_id: string
  current_action: string | null
  last_seen: number
  phase: string | null
  status: string | null
}

const toAgentHeartbeat = (row: AgentHeartbeatRow): AgentHeartbeat => ({
  agentId: row.agent_id,
  currentAction: row.current_action,
  lastSeen: row.last_seen,
  phase: row.phase,
  status: (row.status ?? null) as HeartbeatAgentStatus | null,
})

export interface AgentHeartbeatStore {
  /**
   * Records (or refreshes) the latest heartbeat for an agent. Only the
   * provided fields are overwritten; omitted fields keep their previous
   * values. `lastSeen` is always bumped to the current time.
   */
  record: (
    workspaceId: string,
    agentId: string,
    input?: {
      currentAction?: string | null
      phase?: string | null
      status?: HeartbeatAgentStatus | null
      lastSeen?: number
    }
  ) => void
  /** Returns the latest heartbeat for an agent, or `undefined` when never seen. */
  get: (workspaceId: string, agentId: string) => AgentHeartbeat | undefined
  /**
   * True when the agent has no recorded heartbeat at all or its `lastSeen`
   * is older than `maxAgeMs`. Non-blocking: no stdout sampling.
   */
  isStale: (workspaceId: string, agentId: string, maxAgeMs: number, now?: number) => boolean
  delete: (workspaceId: string, agentId: string) => void
}

const selectHeartbeat = (
  db: Database,
  workspaceId: string,
  agentId: string
): AgentHeartbeat | undefined => {
  const row = db
    .prepare(
      `SELECT agent_id, status, phase, current_action, last_seen
       FROM agent_heartbeats
       WHERE workspace_id = ? AND agent_id = ?`
    )
    .get(workspaceId, agentId) as AgentHeartbeatRow | undefined
  return row ? toAgentHeartbeat(row) : undefined
}

export const createAgentHeartbeatStore = (db: Database): AgentHeartbeatStore => {
  const upsert = db.prepare(
    `INSERT INTO agent_heartbeats (
       workspace_id, agent_id, status, phase, current_action, last_seen
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
       status = COALESCE(excluded.status, agent_heartbeats.status),
       phase = COALESCE(excluded.phase, agent_heartbeats.phase),
       current_action = COALESCE(excluded.current_action, agent_heartbeats.current_action),
       last_seen = excluded.last_seen`
  )
  const remove = db.prepare('DELETE FROM agent_heartbeats WHERE workspace_id = ? AND agent_id = ?')

  return {
    delete(workspaceId, agentId) {
      remove.run(workspaceId, agentId)
    },
    get(workspaceId, agentId) {
      return selectHeartbeat(db, workspaceId, agentId)
    },
    isStale(workspaceId, agentId, maxAgeMs, now = Date.now()) {
      const heartbeat = selectHeartbeat(db, workspaceId, agentId)
      if (!heartbeat) return true
      return now - heartbeat.lastSeen > maxAgeMs
    },
    record(workspaceId, agentId, input = {}) {
      const previous = selectHeartbeat(db, workspaceId, agentId)
      upsert.run(
        workspaceId,
        agentId,
        input.status === undefined ? (previous?.status ?? null) : input.status,
        input.phase === undefined ? (previous?.phase ?? null) : input.phase,
        input.currentAction === undefined ? (previous?.currentAction ?? null) : input.currentAction,
        input.lastSeen ?? Date.now()
      )
    },
  }
}
