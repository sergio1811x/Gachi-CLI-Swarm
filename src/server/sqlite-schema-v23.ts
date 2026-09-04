import type { Database } from 'better-sqlite3'

/**
 * Schema v23 — persistent AgentRun records.
 *
 * The supervisor's AgentRun model needs workspace/task bindings, the lifecycle
 * state, heartbeat freshness, the last PTY output and an error reason so a
 * restart can restore (or cleanly fail) active runs instead of losing them.
 */
export const applySchemaVersion23 = (db: Database) => {
  const runColumns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (runColumns.size > 0) {
    if (!runColumns.has('workspace_id')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN workspace_id TEXT')
    }
    if (!runColumns.has('task_id')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN task_id TEXT')
    }
    if (!runColumns.has('lifecycle_state')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN lifecycle_state TEXT')
    }
    if (!runColumns.has('last_heartbeat')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN last_heartbeat INTEGER')
    }
    if (!runColumns.has('last_output')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN last_output TEXT')
    }
    if (!runColumns.has('error')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN error TEXT')
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_status
      ON agent_runs (workspace_id, status);
  `)
}
