import type { AgentSummary } from '../shared/types.js'
import { planNextDispatch } from './queue-engine.js'
import { taskStore } from './task-store.js'

export interface KanbanDispatcherDeps {
  canStartWorker: (workspaceId: string, workerId: string) => boolean
  dispatch: (workspaceId: string, workerId: string, text: string) => Promise<unknown>
  getAgents: (workspaceId: string) => AgentSummary[]
  /** True when the worker already owns a live process (so it cannot take another task). */
  isWorkerActive?: (workspaceId: string, workerId: string) => boolean
  /** Rolling success-rate per worker (ROADMAP R3.2); neutral when omitted. */
  getWorkerHealth?: (workspaceId: string, workerId: string) => number | null
  /** R10 error budget: when true, dispatch is paused for the workspace. */
  isDispatchPaused?: (workspaceId: string) => boolean
  maxConcurrentWorkers?: number
}

/**
 * Dispatcher — оркестрация «как выполнить» для решений, выбранных Queue Engine.
 *
 * Принимает список кандидатов (`planNextDispatch`) и для каждого: claim,
 * markAssigned, спавн через PTY и, при сбое, releaseTask. Сама политика
 * «что дальше» (приоритет, capacity, занятость) вынесена в `queue-engine.ts`.
 *
 * Задачи в `assigned` намеренно НЕ перезапускаются здесь — их подхватывает
 * worker-report-nudge через retrigger если агент молчит дольше 1 мин.
 *
 * Tick сериализуется через `activeTicks`: параллельные вызовы для одного
 * воркспейса возвращаются сразу, чтобы claim/диспатч не гонялись друг за другом.
 */
const activeTicks = new Set<string>()

export const isDispatcherBusy = (workspaceId: string): boolean => activeTicks.has(workspaceId)

export const dispatchReadyKanbanTasks = async (workspaceId: string, deps: KanbanDispatcherDeps) => {
  if (activeTicks.has(workspaceId)) return []
  // R10 error budget: a paused workspace dispatches nothing until resumed.
  if (deps.isDispatchPaused?.(workspaceId)) {
    console.log(`[DISPATCH] paused for ws ${workspaceId.slice(0, 8)} (error budget)`)
    return []
  }
  activeTicks.add(workspaceId)
  const dispatched: string[] = []
  try {
    // Heal orphaned sticky bindings before planning: a card the reaper/nudge
    // released AFTER its worker was deleted lands in `ready` still bound to a
    // ghost — the sticky path would then skip it forever (no such worker can
    // ever start). Deleting the worker is exactly the documented unbind event,
    // so drop the stale binding here and let the card dispatch normally.
    const liveAgentIds = new Set(deps.getAgents(workspaceId).map((agent) => agent.id))
    for (const task of taskStore.listTasks(workspaceId)) {
      if (task.status !== 'ready' || !task.assignedAgentId) continue
      if (liveAgentIds.has(task.assignedAgentId)) continue
      // Capture before updateTask — the store mutates the card in place.
      const ghostId = task.assignedAgentId
      taskStore.updateTask(workspaceId, task.id, { assignedAgentId: null })
      console.log(
        `[DISPATCH] Unbound task #${task.id.slice(0, 8)} from deleted worker @` +
          ghostId.split(':').pop()
      )
    }
    const candidates = planNextDispatch(workspaceId, taskStore.listTasks(workspaceId), deps)
    for (const candidate of candidates) {
      const task = taskStore.getTask(workspaceId, candidate.taskId)
      if (!task) continue

      const claimed = taskStore.claimTask(workspaceId, task.id, candidate.workerId)
      if (!claimed) continue

      taskStore.markTaskAssigned(workspaceId, task.id)
      const label = candidate.workerId.split(':').pop()
      console.log(
        `[DISPATCH] Task #${task.id.slice(0, 8)} claimed by worker @${label}` +
          (task.assignedAgentId ? ' (pre-assigned)' : '')
      )
      try {
        await deps.dispatch(workspaceId, candidate.workerId, task.description || task.title)
        dispatched.push(task.id)
      } catch (err) {
        console.error(
          `[DISPATCH] Failed to dispatch task #${task.id.slice(0, 8)} to @${label}:`,
          err
        )
        taskStore.releaseTask(
          workspaceId,
          task.id,
          err instanceof Error ? err.message : 'Dispatch failed'
        )
      }
    }
    return dispatched
  } finally {
    activeTicks.delete(workspaceId)
  }
}
