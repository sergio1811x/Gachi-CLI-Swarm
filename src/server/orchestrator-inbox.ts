/**
 * Durable-ish push channel from the runtime to a workspace orchestrator.
 *
 * Worker reports used to reach the orchestrator only through the heartbeat
 * fingerprint poll (up to one interval late, and lost entirely when the
 * orchestrator's PTY was unwritable at tick time). The inbox flips this to
 * push-first: report settlement submits a payload here, an immediate flush
 * tries to inject it into the orchestrator's PTY, and whatever could not be
 * written stays queued so the next heartbeat tick retries it. The queue is
 * bounded — a dead orchestrator must not accumulate unbounded memory.
 */
export interface OrchestratorInbox {
  submit: (workspaceId: string, payload: string) => void
  /**
   * Drains the queue head-first. `write` must return `true` only when the
   * payload was actually handed to the PTY; on `false` (or a throw) flushing
   * stops and the remaining payloads stay queued in order.
   */
  flush: (workspaceId: string, write: (payload: string) => boolean) => number
  pendingCount: (workspaceId: string) => number
}

export const createOrchestratorInbox = ({
  capacity = 20,
}: {
  capacity?: number
} = {}): OrchestratorInbox => {
  const queues = new Map<string, string[]>()

  return {
    submit(workspaceId, payload) {
      const queue = queues.get(workspaceId) ?? []
      if (queue.length >= capacity) {
        const dropped = queue.shift()
        console.warn(
          `[ORCHESTRATOR INBOX] ${workspaceId}: capacity ${capacity} exceeded, dropped oldest notification: ${dropped?.slice(0, 80)}...`
        )
      }
      queue.push(payload)
      queues.set(workspaceId, queue)
    },

    flush(workspaceId, write) {
      const queue = queues.get(workspaceId)
      if (!queue || queue.length === 0) return 0
      let delivered = 0
      while (queue.length > 0) {
        const payload = queue[0] as string
        let accepted = false
        try {
          accepted = write(payload)
        } catch {
          accepted = false
        }
        if (!accepted) break
        queue.shift()
        delivered += 1
      }
      if (queue.length === 0) queues.delete(workspaceId)
      return delivered
    },

    pendingCount(workspaceId) {
      return queues.get(workspaceId)?.length ?? 0
    },
  }
}
