import type { AgentSummary, TaskStatus } from '../shared/types.js'
import { taskStore } from './task-store.js'

/**
 * #18 Reviewer Agent pipeline.
 *
 * Review-задачи (status `review`) автоматически маршрутизируются свободному
 * воркеру с ролью `reviewer`. Воркеру создаётся отдельная задача
 * "Review: <title>" (reviewRequired=false), через которую он получает
 * чек-лист (diff / tests / architecture / security) и отвечает `team report`.
 *
 * Вердикт ревьюера парсится в `team-operations.reportTask`:
 *  - approve → исходная review-задача переводится в `done`
 *  - request_changes / rework → исходная задача возвращается в `ready`
 *    с фидбеком, и её снова подхватит dispatcher.
 *
 * Связь «ревьюерская задача → исходная» ведётся по названию (префикс
 * `Review: `) — этот способ не требует новых полей схемы.
 */

export const REVIEW_TASK_PREFIX = 'Review: '

/** Стабильная связь «ревьюерская задача → исходная» по ID, а не по названию. */
export interface ReviewTask {
  id: string
  parentTaskId: string
  reviewerAgentId: string
  status: TaskStatus
}

/** Возвращает review-задачу по её ID, если она реально является review-задачей. */
export const getReviewTask = (workspaceId: string, taskId: string): ReviewTask | undefined => {
  const task = taskStore.getTask(workspaceId, taskId)
  if (!task?.parentTaskId || !task.reviewerAgentId) return undefined
  return {
    id: task.id,
    parentTaskId: task.parentTaskId,
    reviewerAgentId: task.reviewerAgentId,
    status: task.status,
  }
}

/** Возвращает открытую review-задачу для воркера (по reviewerAgentId). */
export const getOpenReviewTaskForWorker = (
  workspaceId: string,
  workerIdOrName: string
): ReviewTask | undefined => {
  const task = taskStore.listTasks(workspaceId).find((item) => {
    if (item.parentTaskId === undefined || item.reviewerAgentId === undefined) return false
    if (item.status === 'done' || item.status === 'canceled') return false
    return (
      item.reviewerAgentId === workerIdOrName ||
      item.reviewerAgentId.endsWith(workerIdOrName) ||
      workerIdOrName.endsWith(item.reviewerAgentId)
    )
  })
  if (!task || task.parentTaskId === undefined || task.reviewerAgentId === undefined) {
    return undefined
  }
  return {
    id: task.id,
    parentTaskId: task.parentTaskId,
    reviewerAgentId: task.reviewerAgentId,
    status: task.status,
  }
}

export const findAvailableReviewer = (
  agents: AgentSummary[],
  excludedAgentId: string | undefined
): AgentSummary | undefined =>
  agents.find(
    (agent) =>
      agent.role === 'reviewer' &&
      agent.id !== excludedAgentId &&
      agent.status !== 'stopped' &&
      agent.status !== 'working'
  )

export const buildReviewPrompt = (
  task: {
    artifacts?: string[] | undefined
    result?: string | undefined
    title: string
  },
  workerName: string
): string =>
  [
    `Ты — Reviewer. Проверь результат задачи "${task.title}" от @${workerName}.`,
    '',
    'Проверь по чек-листу:',
    '- diff — изменения соответствуют задаче, нет мусора/секретов',
    '- tests — покрытие реально проверяет поведение',
    '- architecture — изменения не ломают слои и контракты',
    '- security — нет инъекций, утечек токенов, широких привилегий',
    '',
    `Результат: ${task.result?.slice(0, 1500) ?? '(не предоставлен)'}`,
    task.artifacts && task.artifacts.length > 0
      ? `Артефакты: ${task.artifacts.slice(0, 20).join(', ')}`
      : 'Артефакты: нет',
    '',
    'Ответь одним из двух маркеров:',
    'APPROVE — работа принята',
    'REQUEST_CHANGES — нужно переделать (укажи, что именно).',
  ].join('\n')

export const routeReviewTaskToReviewer = ({
  dispatch,
  getAgents,
  onRouted,
  taskId,
  workspaceId,
}: {
  dispatch: (workspaceId: string, reviewerId: string, text: string) => Promise<unknown>
  getAgents: (workspaceId: string) => AgentSummary[]
  onRouted?: (workspaceId: string, taskId: string) => void
  taskId: string
  workspaceId: string
}): boolean => {
  const task = taskStore.getTask(workspaceId, taskId)
  if (!task || task.status !== 'review') return false
  // Dedupe by an OPEN child card, not by a log marker: the task journal is
  // capped, so the `[REVIEWER] sent to` marker used to scroll out and every
  // dispatch tick stamped a fresh `Review: <title>` card. A settled
  // (`done`/`canceled`) child never blocks — a reworked task can be re-reviewed.
  const hasOpenReviewChild = taskStore
    .listTasks(workspaceId)
    .some(
      (child) =>
        child.parentTaskId === task.id && child.status !== 'done' && child.status !== 'canceled'
    )
  if (hasOpenReviewChild) return false

  const reviewer = findAvailableReviewer(getAgents(workspaceId), task.assignedAgentId)
  if (!reviewer) return false

  taskStore.createTask(workspaceId, {
    assignedAgentId: reviewer.id,
    description: buildReviewPrompt(task, task.assignedAgentId?.split(':').pop() ?? 'worker'),
    parentTaskId: task.id,
    priority: task.priority,
    requiredSkills: task.requiredSkills,
    reviewerAgentId: reviewer.id,
    reviewRequired: false,
    role: 'reviewer',
    status: 'assigned',
    title: `${REVIEW_TASK_PREFIX}${task.title}`,
  })
  taskStore.addLog(workspaceId, task.id, `[REVIEWER] sent to @${reviewer.name}`)

  // Fire-and-forget, but a failed reviewer launch must not become an
  // unhandled rejection (it would take the whole daemon down on Node ≥22).
  dispatch(
    workspaceId,
    reviewer.id,
    buildReviewPrompt(task, task.assignedAgentId?.split(':').pop() ?? 'worker')
  ).catch((error: unknown) => {
    console.error('[REVIEWER] dispatch failed:', error)
  })
  onRouted?.(workspaceId, task.id)
  return true
}

/** Роутит ВСЕ review-задачи, у которых ещё нет активного ревьюера. */
export const routeReadyReviewTasks = ({
  dispatch,
  getAgents,
  onRouted,
  workspaceId,
}: {
  dispatch: (workspaceId: string, reviewerId: string, text: string) => Promise<unknown>
  getAgents: (workspaceId: string) => AgentSummary[]
  onRouted?: (workspaceId: string, taskId: string) => void
  workspaceId: string
}): number => {
  let routed = 0
  for (const task of taskStore.listTasks(workspaceId)) {
    const callbacks = onRouted ? { onRouted } : {}
    if (
      routeReviewTaskToReviewer({
        ...callbacks,
        dispatch,
        getAgents,
        taskId: task.id,
        workspaceId,
      })
    ) {
      routed++
    }
  }
  return routed
}

/**
 * Разбирает вердикт ревьюера из его отчёта. Возвращает `approve`, `rework`
 * или `null` когда отчёт не содержит явного маркера.
 */
export const parseReviewVerdict = (text: string): 'approve' | 'rework' | null => {
  const normalized = text.trim().toLocaleUpperCase()
  if (normalized.startsWith('APPROVE')) return 'approve'
  if (normalized.startsWith('REQUEST_CHANGES')) return 'rework'
  return null
}
