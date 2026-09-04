import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RuntimeEventBus } from './runtime-event-bus.js'
import type { RuntimeEventPayload } from './tasks-websocket-server.js'

/**
 * A durable, bounded, append-only per-workspace event log fed by the central
 * `RuntimeEventBus`. It turns the in-memory fan-out that already drives the UI
 * WebSocket into two real consumers:
 *
 *  - **Audit**: every emitted event is appended to `<workspace>/.gachi/events/<workspaceId>.ndjson`
 *    so the stream survives restarts and can be reviewed or debugged offline.
 *  - **Agent mailbox**: `tail(..., { agentId })` filters the same stream to the
 *    events that concern a specific agent (its own status/task events plus
 *    workspace-wide queue/task transitions), which is what `team events` reads
 *    to give an agent a live, compact-tolerant view of the system.
 *
 * This is the unification point: UI WebSocket, audit trail, and agent mailbox
 * all subscribe to the SAME `emit` seam, so there is a single source of truth.
 */
export interface EventLogRecord {
  /** Process-local monotonically increasing sequence (ordering + dedupe). */
  seq: number
  /** Wall-clock time of emission. */
  at: number
  workspaceId: string
  type: RuntimeEventPayload['type']
  payload: Record<string, unknown>
}

export interface TailEventLogOptions {
  /** Return only the most recent `limit` records. */
  limit?: number
  /** Return only records emitted at or after this timestamp. */
  since?: number
  /** Return only records relevant to this agent (see `AGENT_KEYS` + board events). */
  agentId?: string
}

export interface EventLog {
  /** Subscribes the log to the bus; returns an unsubscribe function. */
  attach: (bus: RuntimeEventBus) => () => void
  /** Reads recent records for a workspace, newest-last, optionally filtered. */
  tail: (workspaceId: string, options?: TailEventLogOptions) => EventLogRecord[]
  /** Flushes any in-memory tail to disk and releases resources. */
  close: () => void
}

export interface EventLogOptions {
  /** Lazy resolution of a workspace's on-disk root; `null` keeps events memory-only. */
  getWorkspacePath: (workspaceId: string) => string | null
  /** Max records retained per workspace (in memory and on disk). */
  maxLines?: number
}

/** Payload keys that carry an agent id; used to filter an agent's mailbox. */
const AGENT_KEYS = ['agentId', 'toAgentId', 'assignedAgentId', 'reviewerAgentId'] as const

/** Workspace-wide board events are relevant to every agent (they mirror the Kanban). */
const BOARD_EVENT_TYPES: readonly RuntimeEventPayload['type'][] = [
  'QUEUE_UPDATED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_UPDATED',
]

export const createEventLog = ({
  getWorkspacePath,
  maxLines = 2_000,
}: EventLogOptions): EventLog => {
  const rings = new Map<string, EventLogRecord[]>()
  let seq = 0
  let attached = false
  let unsubscribe: (() => void) | null = null

  const fileFor = (workspaceId: string): string | null => {
    const root = getWorkspacePath(workspaceId)
    return root ? `${root}/.gachi/events/${workspaceId}.ndjson` : null
  }

  const hydrate = (workspaceId: string): EventLogRecord[] => {
    const ring: EventLogRecord[] = []
    const file = fileFor(workspaceId)
    if (file && existsSync(file)) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const record = JSON.parse(trimmed) as EventLogRecord
            ring.push(record)
            if (record.seq > seq) seq = record.seq
          } catch {
            // Skip a single corrupt line rather than losing the whole stream.
          }
        }
      } catch {
        // Best-effort hydration; a missing/unreadable file just starts empty.
      }
      if (ring.length > maxLines) ring.splice(0, ring.length - maxLines)
    }
    return ring
  }

  const ringFor = (workspaceId: string): EventLogRecord[] => {
    let ring = rings.get(workspaceId)
    if (!ring) {
      ring = hydrate(workspaceId)
      rings.set(workspaceId, ring)
    }
    return ring
  }

  const persist = (workspaceId: string, record: EventLogRecord) => {
    const file = fileFor(workspaceId)
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      console.warn(
        `[EVENT-LOG] append failed for ${workspaceId}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  const trimFile = (workspaceId: string) => {
    const file = fileFor(workspaceId)
    const ring = rings.get(workspaceId)
    if (!file || !ring) return
    try {
      writeFileSync(
        file,
        ring.map((record) => JSON.stringify(record)).join('\n') + (ring.length ? '\n' : ''),
        'utf8'
      )
    } catch (error) {
      console.warn(
        `[EVENT-LOG] trim failed for ${workspaceId}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  const listener = (workspaceId: string, event: RuntimeEventPayload) => {
    const ring = ringFor(workspaceId)
    const record: EventLogRecord = {
      seq: ++seq,
      at: event.updatedAt,
      workspaceId,
      type: event.type,
      payload: event.payload,
    }
    ring.push(record)
    // Keep the in-memory ring capped and the file bounded: rewrite only when the
    // ring doubles past the cap so we don't rewrite on every event.
    if (ring.length > maxLines * 2) {
      ring.splice(0, ring.length - maxLines)
      trimFile(workspaceId)
    } else {
      persist(workspaceId, record)
    }
  }

  const matchesAgent = (record: EventLogRecord, agentId: string): boolean => {
    const payload = record.payload ?? {}
    for (const key of AGENT_KEYS) {
      if (payload[key] === agentId) return true
    }
    return BOARD_EVENT_TYPES.includes(record.type)
  }

  return {
    attach(bus) {
      if (attached) return () => {}
      attached = true
      unsubscribe = bus.subscribe(listener)
      return () => {
        unsubscribe?.()
        unsubscribe = null
        attached = false
      }
    },
    tail(workspaceId, options: TailEventLogOptions = {}) {
      let records = rings.get(workspaceId) ?? ringFor(workspaceId)
      if (options.since !== undefined) {
        records = records.filter((record) => record.at >= (options.since as number))
      }
      if (options.agentId !== undefined) {
        records = records.filter((record) => matchesAgent(record, options.agentId as string))
      }
      if (options.limit !== undefined && records.length > options.limit) {
        records = records.slice(records.length - options.limit)
      }
      return records
    },
    close() {
      unsubscribe?.()
      unsubscribe = null
      for (const workspaceId of rings.keys()) trimFile(workspaceId)
      rings.clear()
      attached = false
    },
  }
}
