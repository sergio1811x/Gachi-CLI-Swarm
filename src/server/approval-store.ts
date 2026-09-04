import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

/**
 * Durable agent permission requests (Telegram spec: approval flow).
 *
 * A worker asks before running something potentially dangerous
 * (`team request "npm install"`); the request is stored here, pushed to
 * Telegram with Approve/Deny buttons, and the decision is recorded so the
 * answer survives a runtime restart while the worker waits.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ApprovalRequest {
  id: string
  workspaceId: string
  taskId: string | null
  dispatchId: string | null
  agentId: string
  command: string
  reason: string | null
  status: ApprovalStatus
  createdAt: number
  decidedAt: number | null
  decidedBy: string | null
}

interface ApprovalRow {
  id: string
  workspace_id: string
  task_id: string | null
  dispatch_id: string | null
  agent_id: string
  command: string
  reason: string | null
  status: ApprovalStatus
  created_at: number
  decided_at: number | null
  decided_by: string | null
}

const toRecord = (row: ApprovalRow): ApprovalRequest => ({
  id: row.id,
  workspaceId: row.workspace_id,
  taskId: row.task_id,
  dispatchId: row.dispatch_id,
  agentId: row.agent_id,
  command: row.command,
  reason: row.reason,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
})

export interface CreateApprovalInput {
  workspaceId: string
  agentId: string
  command: string
  reason?: string | null
  taskId?: string | null
  dispatchId?: string | null
}

/** Default TTL for pending requests; overridable via settings (`approval_ttl_ms`). */
export const APPROVAL_TTL_MS = 30 * 60_000

export interface ApprovalStoreHooks {
  /**
   * Called with the requests that just flipped to `expired`. The wiring layer
   * uses it to deliver a `PERMISSION EXPIRED` verdict to the waiting worker —
   * without it the worker would sit blocked until its own watchdog fires.
   */
  onExpired?: (requests: ApprovalRequest[]) => void
}

export const createApprovalStore = (
  db: Database,
  hooks: ApprovalStoreHooks = {},
  getTtlMs: () => number = () => APPROVAL_TTL_MS
) => {
  const expireStale = () => {
    // No floor here: the settings layer enforces a production-safe minimum;
    // tests drive expiry with deliberately tiny TTLs.
    const cutoff = Date.now() - getTtlMs()
    const staleRows = db
      .prepare(`SELECT * FROM approval_requests WHERE status = 'pending' AND created_at < ?`)
      .all(cutoff) as ApprovalRow[]
    if (staleRows.length === 0) return
    const placeholders = staleRows.map(() => '?').join(', ')
    db.prepare(
      `UPDATE approval_requests SET status = 'expired', decided_at = ?
       WHERE id IN (${placeholders})`
    ).run(Date.now(), ...staleRows.map((row) => row.id))
    hooks.onExpired?.(staleRows.map(toRecord))
  }

  return {
    create(input: CreateApprovalInput): ApprovalRequest {
      const record: ApprovalRequest = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        command: input.command,
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        dispatchId: input.dispatchId ?? null,
        reason: input.reason ?? null,
        status: 'pending',
        taskId: input.taskId ?? null,
      }
      db.prepare(
        `INSERT INTO approval_requests (
           id, workspace_id, task_id, dispatch_id, agent_id, command, reason,
           status, created_at, decided_at, decided_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.workspaceId,
        record.taskId,
        record.dispatchId,
        record.agentId,
        record.command,
        record.reason,
        record.status,
        record.createdAt,
        record.decidedAt,
        record.decidedBy
      )
      return record
    },

    get(id: string): ApprovalRequest | undefined {
      expireStale()
      const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
        | ApprovalRow
        | undefined
      return row ? toRecord(row) : undefined
    },

    /** Atomically moves a pending request to the requested terminal state. */
    decide(
      id: string,
      status: Extract<ApprovalStatus, 'approved' | 'denied'>,
      decidedBy: string
    ): ApprovalRequest | undefined {
      expireStale()
      const decidedAt = Date.now()
      const update = db
        .prepare(
          `UPDATE approval_requests
           SET status = ?, decided_at = ?, decided_by = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(status, decidedAt, decidedBy, id)
      if (update.changes === 0) return undefined
      const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
        | ApprovalRow
        | undefined
      return row ? toRecord(row) : undefined
    },

    listPending(workspaceId?: string): ApprovalRequest[] {
      expireStale()
      const rows = (
        workspaceId
          ? db
              .prepare(
                `SELECT * FROM approval_requests WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at ASC`
              )
              .all(workspaceId)
          : db
              .prepare(
                `SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC`
              )
              .all()
      ) as ApprovalRow[]
      return rows.map(toRecord)
    },

    listRecent(workspaceId: string, limit = 20): ApprovalRequest[] {
      expireStale()
      const rows = db
        .prepare(
          `SELECT * FROM approval_requests WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(workspaceId, limit) as ApprovalRow[]
      return rows.map(toRecord)
    },
  }
}

export type ApprovalStore = ReturnType<typeof createApprovalStore>
