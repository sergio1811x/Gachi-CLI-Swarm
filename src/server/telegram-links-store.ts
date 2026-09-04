import type { Database } from 'better-sqlite3'

/**
 * Telegram accounts paired with this runtime (spec Part 3 §Security).
 * Roles: owner > operator > viewer. `workspace_id` NULL = every workspace.
 */

export type TelegramRole = 'owner' | 'operator' | 'viewer'

export const TELEGRAM_ROLES: readonly TelegramRole[] = ['owner', 'operator', 'viewer']

export interface TelegramLink {
  chatId: string
  userId: string
  username: string | null
  role: TelegramRole
  /** Workspace scope; null = all workspaces. */
  workspaceId: string | null
  linkedAt: number
}

interface LinkRow {
  chat_id: string
  user_id: string
  username: string | null
  role: TelegramRole
  workspace_id: string | null
  linked_at: number
}

const toRecord = (row: LinkRow): TelegramLink => ({
  chatId: row.chat_id,
  linkedAt: row.linked_at,
  role: row.role,
  userId: row.user_id,
  username: row.username,
  workspaceId: row.workspace_id,
})

const roleRank: Record<TelegramRole, number> = { owner: 0, operator: 1, viewer: 2 }

export const parseTelegramRole = (value: unknown): TelegramRole | undefined =>
  typeof value === 'string'
    ? TELEGRAM_ROLES.find((role) => role === value.trim().toLowerCase())
    : undefined

/** Whether `actor` may perform actions reserved for `required` or weaker roles. */
export const roleSatisfies = (actor: TelegramRole, required: TelegramRole): boolean =>
  roleRank[actor] <= roleRank[required]

export const createTelegramLinksStore = (db: Database) => ({
  upsert(link: {
    chatId: string
    userId: string
    username?: string | null
    role?: TelegramRole
    workspaceId?: string | null
  }): TelegramLink {
    db.prepare(
      `INSERT INTO telegram_links (chat_id, user_id, username, role, workspace_id, linked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET
         username = excluded.username,
         linked_at = excluded.linked_at`
    ).run(
      link.chatId,
      link.userId,
      link.username ?? null,
      link.role ?? 'viewer',
      link.workspaceId ?? null,
      Date.now()
    )
    return this.get(link.chatId, link.userId) as TelegramLink
  },

  get(chatId: string, userId: string): TelegramLink | undefined {
    const row = db
      .prepare('SELECT * FROM telegram_links WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as LinkRow | undefined
    return row ? toRecord(row) : undefined
  },

  list(): TelegramLink[] {
    return (
      db.prepare('SELECT * FROM telegram_links ORDER BY linked_at ASC').all() as LinkRow[]
    ).map(toRecord)
  },

  remove(chatId: string, userId: string): boolean {
    const result = db
      .prepare('DELETE FROM telegram_links WHERE chat_id = ? AND user_id = ?')
      .run(chatId, userId)
    return result.changes > 0
  },
})

export type TelegramLinksStore = ReturnType<typeof createTelegramLinksStore>
