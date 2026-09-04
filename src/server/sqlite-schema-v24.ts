import type { Database } from 'better-sqlite3'

/**
 * Schema v24 — Telegram interface (spec Part 3) + agent approval requests.
 *
 * - `telegram_links`: Telegram accounts paired with this runtime. Roles mirror
 *   the spec: owner > operator > viewer. `workspace_id` is NULL for accounts
 *   that may see every workspace.
 * - `approval_requests`: durable record of an agent asking permission for a
 *   potentially dangerous action (e.g. `npm install`), routed to Telegram with
 *   Approve/Deny buttons and decided by a human.
 */
export const applySchemaVersion24 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_links (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      workspace_id TEXT,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT,
      dispatch_id TEXT,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_status
      ON approval_requests (workspace_id, status);
  `)
}
