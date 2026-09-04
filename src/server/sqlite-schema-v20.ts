import type { Database } from 'better-sqlite3'

export const applySchemaVersion20 = (db: Database) => {
  // Prevent the same physical directory being added as multiple workspaces,
  // which would otherwise spawn two orchestrators/watchers over one tasks.md.
  // Workspace paths are canonicalized via realpath before insert, so the path
  // column holds a canonical form; enforce uniqueness on that canonical path.
  //
  // Pre-existing databases may already hold duplicate paths; collapse them to
  // a single row each before adding the unique index so the migration applies
  // cleanly. Keep the oldest row, re-parent its messages/configs if needed.
  const duplicates = db
    .prepare(`SELECT path, COUNT(*) AS count FROM workspaces GROUP BY path HAVING COUNT(*) > 1`)
    .all() as Array<{ path: string }>
  const deleteDuplicate = db.prepare('DELETE FROM workspaces WHERE id = ?')
  const findKeep = db.prepare(
    'SELECT id FROM workspaces WHERE path = ? ORDER BY created_at ASC LIMIT 1'
  )
  const keep = db.prepare(
    'SELECT id FROM workspaces WHERE path = ? AND id NOT IN (SELECT id FROM workspaces WHERE path = ? ORDER BY created_at ASC LIMIT 1)'
  )
  const reparent = db.prepare('UPDATE messages SET workspace_id = ? WHERE workspace_id = ?')

  db.transaction(() => {
    for (const { path } of duplicates) {
      const keptRow = findKeep.get(path) as { id: string } | undefined
      if (!keptRow) continue
      const dupRows = keep.all(path, path) as Array<{ id: string }>
      for (const dup of dupRows) {
        reparent.run(keptRow.id, dup.id)
        deleteDuplicate.run(dup.id)
      }
    }
  })()

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_path_unique
      ON workspaces (path);
  `)
}
