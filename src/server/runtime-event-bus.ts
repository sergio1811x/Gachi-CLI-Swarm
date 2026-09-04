import type { RuntimeEventPayload } from './tasks-websocket-server.js'

export type RuntimeEventListener = (workspaceId: string, event: RuntimeEventPayload) => void

/**
 * In-memory fan-out for runtime UI events (AGENT_STATUS_CHANGED, QUEUE_UPDATED,
 * RUN_PROGRESS, task transitions, ...). This is the single emission seam: every
 * producer calls `emit`, every consumer (WebSocket publisher, ...) calls
 * `subscribe`.
 *
 * The bus owns the envelope fields: `entityVersion` is a process-local
 * monotonically increasing counter (guaranteed distinct and ordered, unlike the
 * previous per-site `Date.now()` / max-task-version mix) and `updatedAt` is
 * stamped centrally. Producers only supply `type` and `payload`.
 */
export interface RuntimeEventBus {
  emit: (
    workspaceId: string,
    event: Omit<RuntimeEventPayload, 'entityVersion' | 'updatedAt'>
  ) => void
  subscribe: (listener: RuntimeEventListener) => () => void
}

export const createRuntimeEventBus = (): RuntimeEventBus => {
  const listeners = new Set<RuntimeEventListener>()
  let version = 0

  return {
    emit(workspaceId, event) {
      const payload: RuntimeEventPayload = {
        ...event,
        entityVersion: ++version,
        updatedAt: Date.now(),
      }
      for (const listener of listeners) listener(workspaceId, payload)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
