import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { readEnv } from './env.js'

const expandHome = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

const getDefaultOpenCodeDbPath = () =>
  readEnv('OPENCODE_DB_PATH') ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')

export const getOpenCodeDbPath = (pattern?: string) =>
  pattern === '~/.local/share/opencode/opencode.db' || !pattern
    ? getDefaultOpenCodeDbPath()
    : expandHome(pattern)

const listSessionIds = (cwd: string, dbPath = getDefaultOpenCodeDbPath()) => {
  if (!existsSync(dbPath)) return []
  const candidates = [...new Set([cwd, cwd.replaceAll('\\', '/')])]
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true })
    const placeholders = candidates.map(() => '?').join(', ')
    return (
      db
        .prepare(
          `SELECT id FROM session
           WHERE directory IN (${placeholders}) AND time_archived IS NULL
           ORDER BY rowid ASC`
        )
        .all(...candidates) as Array<{ id: string }>
    ).map((row) => row.id)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

export const hasOpenCodeSession = (cwd: string, sessionId: string, pattern?: string) =>
  listSessionIds(cwd, getOpenCodeDbPath(pattern)).includes(sessionId)

export const snapshotOpenCodeSessionIds = (cwd: string, dbPath = getDefaultOpenCodeDbPath()) =>
  new Set(listSessionIds(cwd, dbPath))

export const captureOpenCodeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  dbPath = getDefaultOpenCodeDbPath()
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, dbPath),
    onCapture,
    projectKey: `${dbPath}:${cwd}`,
    timeoutMs,
  })
}
