import type { AgentSummary } from '../shared/types.js'
import { hasWorkerCapacity } from './resource-manager.js'
import { selectWorkerForTask } from './task-assignment.js'

/**
 * Queue Engine — чистый слой «что выполнить дальше».
 *
 * Отвечает только за выбор упорядоченного списка решений (task -> worker)
 * для готовых задач, учитывая приоритет, capacity пула и занятость воркеров.
 * НЕ меняет состояние: claim, markAssigned и сам спавн PTY делает Dispatcher
 * (`kanban-dispatcher.ts`). Отделение даёт возможность тестировать политику
 * очереди без моков БД и вводить backpressure/гейты в одном месте.
 */

export interface QueuedTask {
  id: string
  status: string
  priority: string
  assignedAgentId?: string | undefined
  description: string
  title: string
  role?: string | undefined
  requiredSkills: string[]
}

export interface DispatchCandidate {
  taskId: string
  workerId: string
}

export interface QueueEngineDeps {
  canStartWorker: (workspaceId: string, workerId: string) => boolean
  getAgents: (workspaceId: string) => AgentSummary[]
  /** True when the worker already owns a live process (so it cannot take another task). */
  isWorkerActive?: (workspaceId: string, workerId: string) => boolean
  /** Rolling success-rate per worker (ROADMAP R3.2); null = neutral. */
  getWorkerHealth?: (workspaceId: string, workerId: string) => number | null
  maxConcurrentWorkers?: number
}

const priorityRank: Record<string, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
}

export const planNextDispatch = (
  workspaceId: string,
  tasks: QueuedTask[],
  deps: QueueEngineDeps
): DispatchCandidate[] => {
  const ordered = tasks
    .filter((task) => task.status === 'ready')
    .filter((task) => {
      // R3 failure policy: a backoff window blocks redispatch until it lapses.
      const retryAt = (task as { nextRetryAt?: number }).nextRetryAt
      return retryAt === undefined || retryAt <= Date.now()
    })
    .sort((left, right) => (priorityRank[right.priority] ?? 0) - (priorityRank[left.priority] ?? 0))

  const agents = deps.getAgents(workspaceId)

  // Strict single-flight by task state: a worker that still holds an in-flight
  // task (`claimed`/`assigned`/`running`) must not be handed a new one. Relying
  // only on `isWorkerActive` (a live PTY) is not enough — when a task is stuck
  // in `running` but its process already exited, the worker looks free and gets
  // a second task, piling up "dead" kanban tasks that keep reviving agents.
  const inFlightStatuses = new Set(['assigned', 'claimed', 'running'])
  const inFlightCount = new Map<string, number>()
  for (const t of tasks) {
    if (t.assignedAgentId && inFlightStatuses.has(t.status)) {
      inFlightCount.set(t.assignedAgentId, (inFlightCount.get(t.assignedAgentId) ?? 0) + 1)
    }
  }
  const hasInFlightTask = (workerId: string) => (inFlightCount.get(workerId) ?? 0) > 0

  // Worker ids already handed a task this tick. A worker owns at most one live
  // process, so handing it a second task in the same tick would strand it in
  // `assigned` with no delivery (the dispatcher only re-processes `ready`).
  const claimed = new Set<string>()
  const candidates: DispatchCandidate[] = []

  for (const task of ordered) {
    if (task.assignedAgentId) {
      const targetAgentId = task.assignedAgentId
      if (
        claimed.has(targetAgentId) ||
        hasInFlightTask(targetAgentId) ||
        !deps.canStartWorker(workspaceId, targetAgentId) ||
        deps.isWorkerActive?.(workspaceId, targetAgentId)
      ) {
        continue
      }
      claimed.add(targetAgentId)
      candidates.push({ taskId: task.id, workerId: targetAgentId })
      continue
    }

    // Нет назначенного воркера — автовыбор. Freed (stopped) workers with a
    // launch config are eligible so the execution loop continues autonomously.
    // Workers still holding an in-flight task are excluded entirely so the
    // strict single-flight rule also holds for auto-selection.
    if (!hasWorkerCapacity(agents, deps.maxConcurrentWorkers)) break
    const worker = selectWorkerForTask(
      task as Parameters<typeof selectWorkerForTask>[0],
      agents.filter((agent) => !hasInFlightTask(agent.id)),
      (workerId) => deps.canStartWorker(workspaceId, workerId),
      (agentId) => deps.getWorkerHealth?.(workspaceId, agentId) ?? null
    )
    if (
      !worker ||
      claimed.has(worker.id) ||
      hasInFlightTask(worker.id) ||
      !deps.canStartWorker(workspaceId, worker.id) ||
      deps.isWorkerActive?.(workspaceId, worker.id)
    ) {
      // The selected worker is already busy on another run; leave this task
      // ready so a later tick (after that run settles) can claim it.
      continue
    }
    claimed.add(worker.id)
    candidates.push({ taskId: task.id, workerId: worker.id })
  }

  return candidates
}
