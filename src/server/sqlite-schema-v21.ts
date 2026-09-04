import type { Database } from 'better-sqlite3'

export const applySchemaVersion21 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_lifecycles (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      state TEXT NOT NULL,
      run_id TEXT,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_lifecycles_workspace_state
      ON agent_lifecycles (workspace_id, state);

    CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_agent_created_at
      ON agent_lifecycle_events (workspace_id, agent_id, created_at);
  `)
}
