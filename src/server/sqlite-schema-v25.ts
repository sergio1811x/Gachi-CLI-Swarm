import type { Database } from 'better-sqlite3'

/**
 * Schema v25 — usage history for swarm observability (ROADMAP R1).
 *
 * - `agent_usage_samples`: throttled telemetry samples per agent run
 *   (context %, tokens). The telemetry scraper is latest-wins in memory;
 *   this table gives the metrics API a durable timeline that survives
 *   runtime restarts.
 */
export const applySchemaVersion25 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      context_percent INTEGER,
      tokens_used INTEGER,
      sampled_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_usage_ws_time
      ON agent_usage_samples (workspace_id, sampled_at);

    CREATE INDEX IF NOT EXISTS idx_agent_usage_agent_time
      ON agent_usage_samples (agent_id, sampled_at);
  `)
}
