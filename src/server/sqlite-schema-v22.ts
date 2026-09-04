import type { Database } from 'better-sqlite3'

export const applySchemaVersion22 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_heartbeats (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT,
      phase TEXT,
      current_action TEXT,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, agent_id)
    );
  `)
}
