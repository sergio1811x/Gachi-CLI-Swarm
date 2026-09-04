import type { AgentHeartbeatStore } from './agent-heartbeat-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { taskStore } from './task-store.js'
import { TerminalStateMirror } from './terminal-state-mirror.js'

interface TrackedRun {
  acked: boolean
  lastActivityAt: number
  lastSpontaneousActivityAt: number
  mirror: TerminalStateMirror
  runId: string
  unsubscribe: () => void
}

/**
 * After an injected system prompt (worker report nudge / orchestrator
 * heartbeat) an agent will typically answer with a short acknowledgement.
 * That reply is not real work — it only keeps the heartbeat fresh and defeats
 * idle recovery. Output produced within this window of an injection is treated
 * as a prompted reply, so it must NOT reset the "last spontaneous activity"
 * timestamp used by the recovery watchdog to detect a hung `working` agent.
 */
export const PROMPT_REPLY_WINDOW_MS = 90_000

export interface WorkerOutputTracker {
  attach: (workspaceId: string, agentId: string, runId: string, initialOutput: string) => void
  closeAll: () => void
  detach: (workspaceId: string, agentId: string) => void
  getLastPtyActivityAt: (workspaceId: string, agentId: string) => number | null
  /**
   * Timestamp of the last output that was NOT a prompted reply to an injected
   * nudge/heartbeat. This is the signal for "the agent is actually doing work",
   * used by idle recovery instead of raw output.
   */
  getLastSpontaneousActivityAt: (workspaceId: string, agentId: string) => number | null
  getLastPtyLine: (workspaceId: string, agentId: string) => string | null
  /**
   * Records that a system prompt (nudge / heartbeat) was just written to the
   * agent's PTY, so a subsequent acknowledgement does not count as real work.
   */
  notePromptInjection: (workspaceId: string, agentId: string) => void
}

const trackerKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

/**
 * Maintains a headless terminal mirror per active agent run so the team-list
 * endpoint can report each worker's last output line without requiring a
 * connected UI viewer. Created on run start (via `attach`) and torn down on
 * run exit (via `detach`).
 */
const TASK_ACK_RE = /^\s*(?:\[?TASK_ACK\]?)\s*:?\s*([a-zA-Z0-9:._-]+)?\s*$/i

/**
 * Markers printed by coding CLIs when they compress the conversation
 * (`/compact`, auto-compact on a full context window, low-context warnings).
 * After compaction the worker has lost its protocol memory — including the
 * current task binding and the `team report` instruction — so the runtime must
 * re-inject the task context.
 */
const CONTEXT_COMPACTION_RE =
  /(compacting conversation|auto-compact(?:ed|ing)?|conversation (?:was )?compacted|context (?:window is )?(?:low|full)|low on context)/i

/** Re-injection throttled per agent so a flapping marker cannot spam the PTY. */
const COMPACTION_REINJECT_COOLDOWN_MS = 5 * 60_000

export const createWorkerOutputTracker = (
  outputBus: PtyOutputBus,
  heartbeats?: AgentHeartbeatStore,
  onProgress?: (workspaceId: string, agentId: string, line: string) => void,
  onTaskAck?: (workspaceId: string, agentId: string, taskId: string | undefined) => void,
  onContextCompacted?: (workspaceId: string, agentId: string) => void,
  /** Every raw chunk, for consumers like usage telemetry (best-effort scraping). */
  onChunk?: (workspaceId: string, agentId: string, chunk: string) => void,
  /** Explicit task-scoped progress markers ([PROGRESS] / [TASK:LOG]). */
  onTaskProgress?: (workspaceId: string, agentId: string, message: string) => void
): WorkerOutputTracker => {
  const tracked = new Map<string, TrackedRun>()
  const lastInjectionAt = new Map<string, number>()
  const lastProgressAt = new Map<string, number>()
  const lastHeartbeatAt = new Map<string, number>()
  const lastCompactionAt = new Map<string, number>()
  const PROGRESS_THROTTLE_MS = 1_000
  const HEARTBEAT_THROTTLE_MS = 1_000

  const disposeEntry = (entry: TrackedRun) => {
    entry.unsubscribe()
    entry.mirror.dispose()
  }

  return {
    attach(workspaceId, agentId, runId, initialOutput) {
      const key = trackerKey(workspaceId, agentId)
      const existing = tracked.get(key)
      if (existing) {
        if (existing.runId === runId) return
        disposeEntry(existing)
      }
      const mirror = new TerminalStateMirror()
      if (initialOutput.length > 0) mirror.write(initialOutput)
      const entry: TrackedRun = {
        acked: false,
        lastActivityAt: Date.now(),
        lastSpontaneousActivityAt: Date.now(),
        mirror,
        runId,
        unsubscribe: () => {},
      }
      entry.unsubscribe = outputBus.subscribe(runId, (chunk) => {
        const now = Date.now()
        entry.lastActivityAt = now
        const key = trackerKey(workspaceId, agentId)
        onChunk?.(workspaceId, agentId, chunk)
        // Output arriving within the reply window of an injected system prompt
        // is a prompted acknowledgement, not real work — don't let it defeat
        // idle recovery (a zombie that only answers nudges must still be caught).
        const lastInjection = lastInjectionAt.get(key) ?? 0
        if (now - lastInjection >= PROMPT_REPLY_WINDOW_MS) {
          entry.lastSpontaneousActivityAt = now
        }
        mirror.write(chunk)
        // Throttle the heartbeat write — recording on every chunk issues two
        // synchronous SQLite queries per output chunk during streaming, which
        // saturates the event loop. Once per second is plenty for staleness.
        const lastHeartbeat = lastHeartbeatAt.get(key) ?? 0
        if (heartbeats && now - lastHeartbeat >= HEARTBEAT_THROTTLE_MS) {
          lastHeartbeatAt.set(key, now)
          heartbeats.record(workspaceId, agentId, {
            currentAction: mirror.lastPtyLine(120),
            lastSeen: now,
          })
        }

        if (onProgress) {
          const last = lastProgressAt.get(key) ?? 0
          if (now - last >= PROGRESS_THROTTLE_MS) {
            lastProgressAt.set(key, now)
            const line = mirror.lastPtyLine(160)
            if (line) onProgress(workspaceId, agentId, line)
          }
        }

        const lines = chunk.split(/[\r\n]+/)
        for (const line of lines) {
          const ackMatch = line.match(TASK_ACK_RE)
          if (ackMatch) {
            const entry = tracked.get(key)
            if (entry && !entry.acked) {
              entry.acked = true
              onTaskAck?.(workspaceId, agentId, ackMatch[1] || undefined)
            }
            continue
          }
          if (/\[(?:TASK[-:]LOG|PROGRESS)\]|task:log:/i.test(line)) {
            const match = line.match(/(?:\[(?:TASK[-:]LOG|PROGRESS)\]|task:log:)\s*(.+)/i)
            if (match?.[1]) {
              const assignedTask = taskStore.getAssignedTaskForWorker(workspaceId, agentId)
              if (assignedTask) {
                taskStore.addLog(workspaceId, assignedTask.id, match[1].trim())
              }
              onTaskProgress?.(workspaceId, agentId, match[1].trim())
            }
            continue
          }
          if (!CONTEXT_COMPACTION_RE.test(line)) continue
          const lastCompaction = lastCompactionAt.get(key)
          if (
            lastCompaction !== undefined &&
            now - lastCompaction < COMPACTION_REINJECT_COOLDOWN_MS
          )
            continue
          lastCompactionAt.set(key, now)
          // The CLI just dropped its conversation history — the worker lost
          // the task binding and the report protocol with it.
          onContextCompacted?.(workspaceId, agentId)
        }
      })
      tracked.set(key, entry)
    },
    closeAll() {
      for (const entry of tracked.values()) disposeEntry(entry)
      tracked.clear()
      lastInjectionAt.clear()
      lastProgressAt.clear()
      lastHeartbeatAt.clear()
    },
    detach(workspaceId, agentId) {
      const key = trackerKey(workspaceId, agentId)
      const entry = tracked.get(key)
      if (!entry) return
      disposeEntry(entry)
      tracked.delete(key)
      lastInjectionAt.delete(key)
      lastProgressAt.delete(key)
      lastHeartbeatAt.delete(key)
    },
    getLastPtyActivityAt(workspaceId, agentId) {
      const entry = tracked.get(trackerKey(workspaceId, agentId))
      return entry ? entry.lastActivityAt : null
    },
    getLastSpontaneousActivityAt(workspaceId, agentId) {
      const entry = tracked.get(trackerKey(workspaceId, agentId))
      return entry ? entry.lastSpontaneousActivityAt : null
    },
    getLastPtyLine(workspaceId, agentId) {
      const entry = tracked.get(trackerKey(workspaceId, agentId))
      return entry ? entry.mirror.lastPtyLine() : null
    },
    notePromptInjection(workspaceId, agentId) {
      lastInjectionAt.set(trackerKey(workspaceId, agentId), Date.now())
    },
  }
}
