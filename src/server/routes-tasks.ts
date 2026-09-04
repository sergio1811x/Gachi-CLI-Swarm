import type { TaskStatus, WorkerRole } from '../shared/types.js'
import {
  type AgentSnapshot,
  buildAgentHandoffPrompt,
  loadLatestAgentSnapshot,
} from './agent-handoff.js'
import { decomposeEngineeringTask } from './planner-decomposition.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { selectWorkerForTask } from './task-assignment.js'
import { buildTaskDiff } from './task-diff.js'
import { TaskDependencyError, type TaskPriority, type TaskRecord, taskStore } from './task-store.js'

const ACTIVE_DUP_STATUSES = new Set(['backlog', 'ready', 'assigned', 'claimed', 'running'])

const normalizeTitleForDupCheck = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim()

/**
 * Orchestrator feedback #1: surface probable duplicate cards programmatically.
 * Explicit lineage stays authoritative (`supersededFrom`); this adds a soft
 * `possibleDupOf` hint when two ACTIVE cards normalize to the same title, so
 * nobody has to eyeball-compare titles in tasks.md.
 */
const annotatePossibleDuplicates = (
  tasks: TaskRecord[]
): Array<TaskRecord & { possibleDupOf: string | null }> =>
  tasks.map((task) => {
    if (!ACTIVE_DUP_STATUSES.has(task.status)) return { ...task, possibleDupOf: null }
    const normalized = normalizeTitleForDupCheck(task.title)
    if (!normalized) return { ...task, possibleDupOf: null }
    const other = tasks.find(
      (candidate) =>
        candidate.id !== task.id &&
        candidate.status !== 'done' &&
        candidate.status !== 'canceled' &&
        normalizeTitleForDupCheck(candidate.title) === normalized
    )
    return { ...task, possibleDupOf: other?.id.slice(0, 8) ?? null }
  })

import { syncTasksMarkdownFile, TasksRevisionConflictError } from './tasks-file.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * Формирует полный пакет контекста задачи для любой нейросети / воркера:
 * - Заголовок и детальное описание
 * - Указания по передаче задачи (если сменился исполнитель)
 * - Предыдущие отчёты, результаты и артефакты
 * - Комментарии и история правок
 * - Недавние логи прогресса
 */
export const buildTaskDispatchPrompt = (
  task: TaskRecord,
  note?: string,
  handoff?: AgentSnapshot
): string => {
  const parts: string[] = [
    `# ЗАДАЧА #${task.id.slice(0, 8)}: ${task.title}`,
    '',
    `## 📋 Описание:`,
    task.description ? task.description.trim() : 'Нет описания.',
  ]

  if (note?.trim()) {
    parts.push('', `## ⚠️ Указания по передаче задачи:`, note.trim())
  }

  if (handoff) {
    parts.push('', '## 🔄 Контекст передачи между AI:', buildAgentHandoffPrompt(handoff))
  }

  if (task.result?.trim()) {
    parts.push('', `## 🔍 Предыдущий результат / отчёт исполнителя:`, task.result.trim())
  }

  if (task.comments && task.comments.length > 0) {
    parts.push(
      '',
      `## 💬 История комментариев и правок:`,
      ...task.comments.map((c) => {
        const anchor = c.path && c.line ? ` [${c.path}:${c.line}]` : ''
        return `- [${c.author}${c.authorRole ? ` (${c.authorRole})` : ''}]${anchor}: ${c.message}`
      })
    )
  }

  if (task.artifacts && task.artifacts.length > 0) {
    parts.push('', `## 📁 Артефакты и созданные файлы:`, ...task.artifacts.map((a) => `- ${a}`))
  }

  if (task.logs && task.logs.length > 0) {
    const recentLogs = task.logs.slice(-5)
    parts.push('', `## 📜 Недавний журнал выполнения:`, ...recentLogs.map((l) => `- ${l}`))
  }

  parts.push(
    '',
    '---',
    'Инструкция: выполните именно эту задачу с учётом требований выше. Для JSON, кода или длинных отчётов сохраните результат в файл и вызовите `team report --file <путь>` (рекомендуется) либо `team report "<отчёт>" --dispatch <id>`. Не путайте данную задачу с предыдущими сессиями.'
  )

  return parts.join('\n')
}

export const taskRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/workspaces/:workspaceId/tasks/plan',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      requireUiTokenFromRequest(request, store.validateUiToken)
      const body = await readJsonBody<{ description?: string; title: string }>(request)
      if (!body.title || typeof body.title !== 'string') {
        sendJson(response, 400, { error: 'Task title is required' })
        return
      }
      const planned = decomposeEngineeringTask(body.title, body.description)
      // R2: draft plans share a group id so the board can Approve/Discard the
      // whole set; tasks stay in backlog until explicitly approved.
      const planGroupId = crypto.randomUUID()
      const plannedAt = Date.now()
      const created = planned.map((item) =>
        taskStore.createTask(workspaceId, {
          description: item.description,
          priority: item.priority,
          requiredSkills: item.requiredSkills,
          reviewRequired: item.reviewRequired,
          role: item.role,
          title: item.title,
          planGroupId,
          plannedAt,
        })
      )
      const titleToId = new Map(created.map((task) => [task.title, task.id]))
      const tasks = created.map(
        (task, index) =>
          taskStore.updateTask(workspaceId, task.id, {
            dependencies: planned[index]?.dependencies
              .map((dependencyIndex) => titleToId.get(planned[dependencyIndex]?.title ?? '') ?? '')
              .filter(Boolean),
          }) ?? task
      )
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(workspaceId))
      sendJson(response, 201, { plan_group_id: planGroupId, tasks })
    }
  ),
  // R2.2 LLM decomposition: asks the live orchestrator to draft a plan; the
  // reply is captured asynchronously and lands as a backlog group (approve
  // via /plans/:id/approve). Deterministic template lives in POST /tasks/plan.
  route(
    'POST',
    '/api/workspaces/:workspaceId/plan/draft',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const body = await readJsonBody<{ goal?: string }>(request)
      if (!body.goal || typeof body.goal !== 'string' || body.goal.trim().length < 8) {
        sendJson(response, 400, { error: 'goal is required (min 8 chars)' })
        return
      }

      const result = store.draftPlanFromGoal(workspaceId, body.goal)
      if (!result.accepted) {
        sendJson(response, 409, { error: result.reason, ok: false })
        return
      }
      sendJson(response, 202, {
        ok: true,
        plan_group_id: result.groupId,
        message:
          'Planner prompt sent to the orchestrator. Tasks appear in backlog when the draft lands.',
      })
    }
  ),
  // R2: approve a draft plan — the whole group moves backlog → ready so the
  // dispatcher can pick it up. Only backlog cards are promoted; anything a
  // human already moved keeps its state.
  route(
    'POST',
    '/api/workspaces/:workspaceId/plans/:planGroupId/approve',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const planGroupId = getRequiredParam(
        response,
        params,
        'planGroupId',
        'Plan group id is required'
      )
      if (!workspaceId || !planGroupId) return

      const group = taskStore.listTasks(workspaceId).filter((t) => t.planGroupId === planGroupId)
      if (group.length === 0) {
        sendJson(response, 404, { error: 'Plan not found' })
        return
      }

      let approved = 0
      for (const task of group) {
        if (task.status !== 'backlog') continue
        const updated = taskStore.updateTask(workspaceId, task.id, { status: 'ready' })
        if (updated?.status === 'ready') approved += 1
      }

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(workspaceId))
      sendJson(response, 200, { approved, ok: true, total: group.length })
    }
  ),
  // R2: discard a draft plan — deletes every still-backlog card in the group.
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/plans/:planGroupId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      const planGroupId = getRequiredParam(
        response,
        params,
        'planGroupId',
        'Plan group id is required'
      )
      if (!workspaceId || !planGroupId) return

      const group = taskStore.listTasks(workspaceId).filter((t) => t.planGroupId === planGroupId)
      if (group.length === 0) {
        sendJson(response, 404, { error: 'Plan not found' })
        return
      }

      let deleted = 0
      for (const task of group) {
        if (task.status !== 'backlog') continue
        try {
          taskStore.deleteTask(workspaceId, task.id)
          deleted += 1
        } catch {
          // A card that already left backlog stays — discard only touches drafts.
        }
      }

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(workspaceId))
      sendJson(response, 200, { deleted, ok: true, kept: group.length - deleted })
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks/items',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      store.reconcileTasksFromDispatches(workspaceId)
      const tasks = taskStore.listTasks(workspaceId)
      sendJson(response, 200, { tasks })
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const url = new URL(request.url ?? '', 'http://127.0.0.1')
      const format = url.searchParams.get('format')

      if (format === 'store' || format === 'tasks' || format === 'json') {
        store.reconcileTasksFromDispatches(workspaceId)
        // Keep the board's first paint small. Full reports, comments and logs
        // are fetched only after the user opens an individual card.
        const tasks = taskStore.listTasks(workspaceId).map((task) => ({
          ...task,
          comments: [],
          logs: [],
          result: undefined,
        }))
        sendJson(response, 200, { tasks: annotatePossibleDuplicates(tasks) })
        return
      }

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const { content, revision } = tasksFileService.readTasks(workspace.summary.path)
      sendJson(response, 200, { content, revision })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{
        title: string
        description?: string
        assigned_worker_id?: string
        assigned_agent_id?: string
        dependencies?: string[]
        priority?: TaskPriority
        required_skills?: string[]
        review_required?: boolean
        role?: WorkerRole
        auto_assign?: boolean
        superseded_from?: string | null
      }>(request)

      if (!body.title || typeof body.title !== 'string') {
        sendJson(response, 400, { error: 'Task title is required' })
        return
      }

      let task = taskStore.createTask(workspaceId, {
        title: body.title,
        description: body.description,
        assignedAgentId: body.assigned_worker_id ?? body.assigned_agent_id,
        dependencies: body.dependencies,
        priority: body.priority,
        requiredSkills: body.required_skills,
        reviewRequired: body.review_required,
        role: body.role,
        supersededFrom: body.superseded_from ?? undefined,
      })

      if (!task.assignedAgentId && body.auto_assign !== false) {
        // Strict single-flight (same rule as queue-engine): a worker still
        // holding a `claimed`/`assigned`/`running` card must not be handed a
        // second one — the new card would stall next to the poked old card.
        const inFlightStatuses = new Set(['claimed', 'assigned', 'running'])
        const inFlightWorkers = new Set(
          taskStore
            .listTasks(workspaceId)
            .filter((item) => item.assignedAgentId && inFlightStatuses.has(item.status))
            .map((item) => item.assignedAgentId as string)
        )
        const worker = selectWorkerForTask(
          task,
          store
            .getWorkspaceSnapshot(workspaceId)
            .agents.filter((agent) => !inFlightWorkers.has(agent.id)),
          (workerId) => store.peekAgentLaunchConfig(workspaceId, workerId) !== undefined
        )
        if (worker) {
          task =
            taskStore.updateTask(workspaceId, task.id, {
              assignedAgentId: worker.id,
              status: 'assigned',
            }) ?? task
          taskStore.addLog(
            workspaceId,
            task.id,
            `[AUTO-ASSIGN] Оркестратор назначил @${worker.name} по роли/навыкам/загрузке`
          )
        }
      }

      // Если к задаче сразу прикреплен воркер — триггерим и запускаем его в работу
      if (task.assignedAgentId) {
        const workers = store.listWorkers(workspaceId)
        const worker = workers.find((w) => w.id === task.assignedAgentId)
        if (worker) {
          task =
            taskStore.updateTask(workspaceId, task.id, {
              status: 'assigned',
            }) ?? task
          taskStore.addLog(
            workspaceId,
            task.id,
            `[СТАРТ] Задача назначена и отправлена воркеру @${worker.name}`
          )
          const prompt = buildTaskDispatchPrompt(task)
          try {
            await store.dispatchTask(workspaceId, worker.id, prompt, {
              fromAgentId: `${workspaceId}:orchestrator`,
              gachiPort: String(request.socket.localPort ?? ''),
            })
          } catch (err) {
            console.error('[gachi] auto-dispatch on task create failed', err)
          }
        }
      }

      // Синхронизируем TASK.md файл в .gachi/
      try {
        const workspace = store.getWorkspaceSnapshot(workspaceId)
        syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(workspaceId))
      } catch {}

      sendJson(response, 201, { task })
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks/:taskId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const task = taskStore.getTask(workspaceId, taskId)
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      sendJson(response, 200, { task })
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks/:taskId/diff',
    async ({ params, request, response, store }) => {
      // Review diff (roadmap Wave 1): the worker's actual changes in the
      // workspace checkout — working tree vs HEAD plus untracked files.
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      if (!taskStore.getTask(workspaceId, taskId)) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      let workspacePath: string
      try {
        workspacePath = store.getWorkspaceSnapshot(workspaceId).summary.path
      } catch {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }

      const result = await buildTaskDiff(workspacePath)
      if (!result.ok) {
        sendJson(response, 200, result)
        return
      }
      sendJson(response, 200, result)
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/tasks/:taskId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{
        title?: string
        description?: string
        status?: TaskStatus
        assigned_worker_id?: string | null
        assigned_agent_id?: string | null
        dependencies?: string[]
        priority?: TaskPriority
        required_skills?: string[]
        review_required?: boolean
        role?: WorkerRole
        superseded_from?: string | null
      }>(request)

      const previous = taskStore.getTask(workspaceId, taskId)
      const targetWorkerId = body.assigned_worker_id ?? body.assigned_agent_id
      const workerChanged = targetWorkerId && targetWorkerId !== previous?.assignedAgentId

      let task: TaskRecord | undefined
      try {
        task = taskStore.updateTask(workspaceId, taskId, {
          title: body.title,
          description: body.description,
          status: workerChanged ? 'assigned' : body.status,
          assignedAgentId: targetWorkerId,
          dependencies: body.dependencies,
          priority: body.priority,
          requiredSkills: body.required_skills,
          reviewRequired: body.review_required,
          role: body.role,
          supersededFrom: body.superseded_from,
        })
      } catch (error) {
        if (error instanceof TaskDependencyError) {
          sendJson(response, 409, { error: error.message, dependency_ids: error.dependencyIds })
          return
        }
        throw error
      }

      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      // Если воркер переназначен или задача переведена в in_progress — триггерим воркера
      if (workerChanged && task.assignedAgentId) {
        const workers = store.listWorkers(workspaceId)
        const worker = workers.find((w) => w.id === task.assignedAgentId)
        if (worker) {
          taskStore.addLog(
            workspaceId,
            task.id,
            `[ПЕРЕДАЧА ИИ] Задача передана воркеру @${worker.name} с полным контекстом`
          )
          const prompt = buildTaskDispatchPrompt(
            task,
            `Задача передана новому исполнителю (@${worker.name}). Ознакомьтесь с предыдущими отчётами, комментариями и продолжите выполнение.`,
            previous?.assignedAgentId
              ? loadLatestAgentSnapshot(
                  store.getWorkspaceSnapshot(workspaceId).summary.path,
                  previous.assignedAgentId
                )
              : undefined
          )
          try {
            await store.dispatchTask(workspaceId, worker.id, prompt, {
              fromAgentId: `${workspaceId}:orchestrator`,
              gachiPort: String(request.socket.localPort ?? ''),
            })
          } catch (err) {
            console.error('[gachi] auto-dispatch on task reassign failed', err)
          }
        }
      }

      // Если статус задачи изменился (например, перешла в review) — уведомляем оркестратора
      if (body.status && body.status !== previous?.status) {
        const workers = store.listWorkers(workspaceId)
        const assignedWorker = workers.find((w) => w.id === task.assignedAgentId)
        try {
          store.writeTaskQueueUpdate(
            workspaceId,
            `task #${task.id.slice(0, 8)} status changed to ${task.status}`,
            {
              id: task.id,
              title: task.title,
              status: task.status,
              assignedWorkerName: assignedWorker?.name,
              details: task.result || task.description,
            }
          )
        } catch {}
      }

      // Синхронизируем TASK.md файл в .gachi/
      try {
        const workspace = store.getWorkspaceSnapshot(workspaceId)
        syncTasksMarkdownFile(workspace.summary.path, taskStore.listTasks(workspaceId))
      } catch {}

      sendJson(response, 200, { task })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/tasks/:taskId/logs',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ message: string }>(request)
      if (!body.message || typeof body.message !== 'string') {
        sendJson(response, 400, { error: 'Log message is required' })
        return
      }

      const task = taskStore.addLog(workspaceId, taskId, body.message)
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      sendJson(response, 200, { task })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/tasks/:taskId/comments',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{
        author: string
        message: string
        author_role?: string
        path?: string
        line?: number
      }>(request)

      if (!body.message || typeof body.message !== 'string') {
        sendJson(response, 400, { error: 'Comment message is required' })
        return
      }

      // Inline review comments may pin to a diff line (repo path + new-file line).
      const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
      const anchor =
        rawPath && typeof body.line === 'number' && Number.isFinite(body.line) && body.line >= 1
          ? { path: rawPath.slice(0, 512), line: Math.floor(body.line) }
          : undefined

      const task = taskStore.addComment(
        workspaceId,
        taskId,
        body.author || 'User',
        body.message,
        body.author_role,
        anchor
      )
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      sendJson(response, 200, { task })
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/tasks/:taskId/dispatch',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ worker_id?: string }>(request).catch(
        () => ({}) as { worker_id?: string }
      )

      const task = taskStore.getTask(workspaceId, taskId)
      if (!task) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      const targetWorkerId = body.worker_id || task.assignedAgentId
      if (!targetWorkerId) {
        sendJson(response, 400, { error: 'No worker specified or assigned to this task' })
        return
      }

      const workers = store.listWorkers(workspaceId)
      const worker = workers.find((w) => w.id === targetWorkerId)
      if (!worker) {
        sendJson(response, 404, { error: 'Worker not found' })
        return
      }

      // review и running: статус не трогаем, просто повторно шлём промпт в PTY.
      // Переходы review→assigned и running→assigned запрещены state machine.
      const sendWithoutStatusChange = task.status === 'running' || task.status === 'review'

      let updated: TaskRecord | undefined
      if (!sendWithoutStatusChange) {
        // backlog/ready/assigned/blocked/failed → assigned: разрешённые переходы
        updated = taskStore.updateTask(workspaceId, taskId, {
          assignedAgentId: worker.id,
          status: 'assigned',
        })
      } else {
        // running/review: просто обновляем исполнителя без смены статуса
        updated = taskStore.updateTask(workspaceId, taskId, {
          assignedAgentId: worker.id,
        })
      }

      // Record log entry
      const logLabel =
        task.status === 'review'
          ? `[ДОРАБОТКА] Повторная отправка воркеру @${worker.name} (из Review)`
          : task.status === 'running'
            ? `[ТРИГГЕР] Повторная отправка задачи воркеру @${worker.name} (уже в работе)`
            : `[СТАРТ] Задача запущена напрямую воркеру @${worker.name}`
      taskStore.addLog(workspaceId, taskId, logLabel)

      // Dispatch prompt directly to worker PTY with full context packet
      const prompt = buildTaskDispatchPrompt(taskStore.getTask(workspaceId, taskId) ?? task)
      try {
        await store.dispatchTask(workspaceId, worker.id, prompt, {
          fromAgentId: `${workspaceId}:orchestrator`,
          gachiPort: String(request.socket.localPort ?? ''),
        })
      } catch (err) {
        console.error('[gachi] dispatchTask failed from UI', err)
      }

      sendJson(response, 200, { ok: true, task: updated })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/tasks/:taskId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      const taskId = getRequiredParam(response, params, 'taskId', 'Task id is required')
      if (!taskId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      // Delete through the team-ops path: the bound open dispatch (if any) is
      // cancelled first and the worker's pending count settled. Deleting the
      // bare card used to leave the dispatch open, so reconcile instantly
      // resurrected the card and deletion appeared broken.
      const deleted = store.deleteTaskCard(workspaceId, taskId, {
        fromAgentId: `${workspaceId}:orchestrator`,
        reason: 'deleted from Kanban board',
      })
      if (!deleted) {
        sendJson(response, 404, { error: 'Task not found' })
        return
      }

      sendJson(response, 200, { success: true })
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      // expectedRevision is optional so non-UI callers that don't track
      // revisions keep overwriting unconditionally; the UI always sends it
      // once it has loaded a revision, so a stale save gets a real 409
      // instead of silently clobbering an agent's concurrent tasks.md edit.
      const body = await readJsonBody<{ content: string; expectedRevision?: string }>(request)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      try {
        const { content, revision } = tasksFileService.writeTasks(
          workspace.summary.path,
          body.content,
          body.expectedRevision
        )
        sendJson(response, 200, { content, revision })
      } catch (error) {
        if (error instanceof TasksRevisionConflictError) {
          sendJson(response, 409, {
            content: error.currentContent,
            error: error.message,
            revision: error.currentRevision,
          })
          return
        }
        throw error
      }
    }
  ),
]
