import type { Database } from 'better-sqlite3'

export const applySchemaVersion19 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workers_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}
