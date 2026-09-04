import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { type TaskStatus, taskStatuses, type WorkerRole } from '../shared/types.js'
import type { TaskCompletion } from './task-completion.js'

export const taskPriorities = ['low', 'normal', 'high', 'critical'] as const
export type TaskPriority = (typeof taskPriorities)[number]

export interface TaskComment {
  id: string
  author: string
  authorRole?: string | undefined
  message: string
  timestamp: number
  /** Optional diff anchor: repo-relative file path for inline review comments. */
  path?: string | undefined
  /** 1-based line in the NEW file version the comment is pinned to. */
  line?: number | undefined
}

export interface TaskRecord {
  id: string
  workspaceId: string
  title: string
  description: string
  status: TaskStatus
  dispatchId?: string | undefined
  assignedAgentId?: string | undefined
  claimedBy?: string | undefined
  claimedAt?: number | undefined
  claimExpiresAt?: number | undefined
  startedAt?: number | undefined
  finishedAt?: number | undefined
  attempts?: number | undefined
  version?: number | undefined
  dependencies: string[]
  priority: TaskPriority
  requiredSkills: string[]
  reviewRequired: boolean
  role?: WorkerRole | undefined
  /** For review tasks: the original task being reviewed. */
  parentTaskId?: string | undefined
  /** For review tasks: the reviewer agent that owns the review. */
  reviewerAgentId?: string | undefined
  /**
   * Lineage marker (orchestrator feedback #1): set when this card replaces or
   * duplicates an earlier one, so `team list` / the board can surface
   * duplicates programmatically instead of title-grepping.
   */
  supersededFrom?: string | null | undefined
  /** Draft-plan grouping (ROADMAP R2): tasks from one planner run share this id. */
  planGroupId?: string | undefined
  plannedAt?: number | undefined
  /** Failure policy (ROADMAP R3): earliest retry time + last classified category. */
  nextRetryAt?: number | undefined
  lastFailureCategory?: string | undefined
  result?: string | undefined
  artifacts?: string[] | undefined
  completion?: TaskCompletion | undefined
  comments?: TaskComment[] | undefined
  logs: string[]
  createdAt: number
  updatedAt: number
}

export interface CreateTaskInput {
  title: string
  description?: string | undefined
  dispatchId?: string | undefined
  assignedAgentId?: string | undefined
  claimedBy?: string | undefined
  claimedAt?: number | undefined
  claimExpiresAt?: number | undefined
  startedAt?: number | undefined
  finishedAt?: number | undefined
  attempts?: number | undefined
  version?: number | undefined
  status?: TaskStatus | undefined
  result?: string | undefined
  artifacts?: string[] | undefined
  completion?: TaskCompletion | undefined
  dependencies?: string[] | undefined
  priority?: TaskPriority | undefined
  requiredSkills?: string[] | undefined
  reviewRequired?: boolean | undefined
  role?: WorkerRole | undefined
  parentTaskId?: string | undefined
  reviewerAgentId?: string | undefined
  supersededFrom?: string | null | undefined
  /** Draft-plan grouping (ROADMAP R2): tasks from one planner run share this id. */
  planGroupId?: string | undefined
  plannedAt?: number | undefined
}

export interface UpdateTaskInput {
  title?: string | undefined
  description?: string | undefined
  dispatchId?: string | undefined
  status?: TaskStatus | undefined
  assignedAgentId?: string | null | undefined
  claimedBy?: string | null | undefined
  claimedAt?: number | null | undefined
  claimExpiresAt?: number | null | undefined
  startedAt?: number | null | undefined
  finishedAt?: number | null | undefined
  attempts?: number | undefined
  version?: number | undefined
  result?: string | undefined
  artifacts?: string[] | undefined
  completion?: TaskCompletion | undefined
  dependencies?: string[] | undefined
  priority?: TaskPriority | undefined
  requiredSkills?: string[] | undefined
  reviewRequired?: boolean | undefined
  role?: WorkerRole | undefined
  parentTaskId?: string | undefined
  reviewerAgentId?: string | undefined
  supersededFrom?: string | null | undefined
  /** Failure policy (ROADMAP R3). */
  nextRetryAt?: number | undefined
  lastFailureCategory?: string | undefined
}

export class TaskDependencyError extends Error {
  constructor(readonly dependencyIds: string[]) {
    super(`Task dependencies are not complete: ${dependencyIds.join(', ')}`)
  }
}

const statusTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  assigned: ['ready', 'claimed', 'running', 'review', 'done', 'blocked', 'failed', 'canceled'],
  backlog: ['ready', 'claimed', 'assigned', 'canceled'],
  canceled: ['backlog'],
  claimed: ['ready', 'assigned', 'running', 'blocked', 'failed', 'canceled'],
  done: [],
  blocked: ['ready', 'claimed', 'assigned', 'running', 'failed', 'canceled'],
  failed: ['ready', 'claimed', 'assigned', 'canceled'],
  ready: ['claimed', 'assigned', 'canceled'],
  // `assigned` reopens a review card for direct re-dispatch (`team send` poke):
  // when an orchestrator sends new work to a worker whose previous run ended
  // in review, the bound card must reopen instead of 500ing the send.
  review: ['running', 'ready', 'assigned', 'done', 'failed', 'canceled'],
  running: ['ready', 'review', 'blocked', 'failed', 'canceled'],
}

const normalizePersistedStatus = (status: string): TaskStatus => {
  if (status === 'open') return 'ready'
  if (status === 'in_progress') return 'running'
  if (taskStatuses.includes(status as TaskStatus)) return status as TaskStatus
  return 'backlog'
}

export const TASK_TTL_MS = 24 * 60 * 60 * 1000 // 24 часа

/** How long a CLAIMED/ASSIGNED task may wait before the claim lease expires. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 2 * 60_000

/** Cap on per-task audit logs / comments so `saveToDb` stringify stays bounded. */
export const MAX_TASK_LOGS = 200
export const MAX_TASK_COMMENTS = 200

/**
 * Per-field length caps (production incident: an unbounded poke-append made
 * `description` grow on every re-dispatch until the whole tasks JSON blob
 * exceeded SQLite's bind limit — every write then failed and the runtime
 * showed an eternal loader). Values chosen well above real payloads.
 */
export const MAX_DESCRIPTION_LEN = 32_000
export const MAX_RESULT_LEN = 64_000
export const MAX_LOG_LEN = 4_000
export const MAX_COMMENT_LEN = 8_000

const clampText = (value: string | null | undefined, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

export interface TaskStoreDb {
  prepare: (sql: string) => {
    // better-sqlite3's statement shape is intentionally loose here: the store
    // binds heterogeneous column payloads and reads row blobs back.
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => unknown
  }
}

export class TaskStore {
  private tasks = new Map<string, TaskRecord>()
  private db?: TaskStoreDb | Database | undefined
  /** Колбек вызывается при любом изменении задач (updateTask, addLog, addComment, createTask) */
  private changeListener?: ((workspaceId: string, tasks: TaskRecord[]) => void) | undefined

  init(db: TaskStoreDb | Database) {
    this.db = db
    this.loadFromDb()
  }

  /** Регистрирует листенер изменений. Заменяет предыдущий если был. */
  onTaskChanged(listener: (workspaceId: string, tasks: TaskRecord[]) => void): void {
    this.changeListener = listener
  }

  /** Вызывает changeListener если он зарегистрирован */
  private notifyChanged(workspaceId: string): void {
    if (this.changeListener) {
      this.changeListener(workspaceId, this.listTasks(workspaceId))
    }
  }

  detachDatabase(): void {
    this.db = undefined
  }

  private loadFromDb() {
    if (!this.db) return
    try {
      const row = this.db
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get('kanban_tasks_v1') as { value: string | null } | undefined
      if (row?.value) {
        const parsed = JSON.parse(row.value) as TaskRecord[]
        if (Array.isArray(parsed)) {
          this.tasks.clear()
          const now = Date.now()
          let sanitized = false
          for (const task of parsed) {
            if (task.status !== 'done' || now - task.createdAt <= TASK_TTL_MS) {
              const record: TaskRecord = {
                ...task,
                dependencies: task.dependencies ?? [],
                priority: task.priority ?? 'normal',
                requiredSkills: task.requiredSkills ?? [],
                reviewRequired: task.reviewRequired ?? true,
                status: normalizePersistedStatus(task.status),
              }
              // S-2 self-heal: clamp oversized legacy fields immediately so the
              // next save fits SQLite's bind limit instead of wedging forever.
              if ((record.description?.length ?? 0) > MAX_DESCRIPTION_LEN) {
                record.description = clampText(record.description, MAX_DESCRIPTION_LEN) ?? ''
                sanitized = true
              }
              if ((record.result?.length ?? 0) > MAX_RESULT_LEN) {
                record.result = clampText(record.result, MAX_RESULT_LEN) ?? undefined
                sanitized = true
              }
              if (record.logs.some((line) => line.length > MAX_LOG_LEN)) {
                record.logs = record.logs.map((line) =>
                  line.length > MAX_LOG_LEN ? (clampText(line, MAX_LOG_LEN) ?? line) : line
                )
                sanitized = true
              }
              if (record.logs.length > MAX_TASK_LOGS) {
                record.logs = record.logs.slice(-MAX_TASK_LOGS)
                sanitized = true
              }
              this.tasks.set(record.id, record)
            }
          }
          if (sanitized) {
            console.log('[gachi] compacted oversized legacy task fields')
            this.saveToDb()
          }
        }
      }
    } catch (err) {
      console.error('[gachi] failed to load tasks from db', err)
    }
  }

  private saveToDb() {
    if (!this.db) return
    try {
      const allTasks = Array.from(this.tasks.values())
      const json = JSON.stringify(allTasks)
      this.db
        .prepare(
          `INSERT INTO app_state (key, value, updated_at)
           VALUES ('kanban_tasks_v1', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(json, Date.now())
    } catch {
      // Self-heal (S-2): a legacy oversized blob must never wedge every future
      // write. Compact the heavy fields and retry once.
      console.error('[gachi] tasks blob too large — compacting logs/comments/results')
      for (const task of this.tasks.values()) {
        task.logs = task.logs.slice(-30)
        task.comments = task.comments?.slice(-20)
        task.result = undefined
        if ((task.description?.length ?? 0) > MAX_DESCRIPTION_LEN) {
          task.description = clampText(task.description, MAX_DESCRIPTION_LEN) ?? task.description
        }
      }
      try {
        const json = JSON.stringify(Array.from(this.tasks.values()))
        this.db
          .prepare(
            `INSERT INTO app_state (key, value, updated_at)
             VALUES ('kanban_tasks_v1', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .run(json, Date.now())
        console.log('[gachi] tasks persisted after compaction')
      } catch (err) {
        console.error('[gachi] failed to persist tasks to db even after compaction', err)
      }
    }
  }

  /**
   * Удаляет задачи старше maxAgeMs (по умолчанию 24 часа).
   */
  cleanupExpiredTasks(maxAgeMs: number = TASK_TTL_MS): number {
    const now = Date.now()
    let deletedCount = 0
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'done' && now - task.createdAt > maxAgeMs) {
        this.tasks.delete(id)
        deletedCount++
      }
    }
    if (deletedCount > 0) {
      this.saveToDb()
    }
    return deletedCount
  }

  createTask(workspaceId: string, input: CreateTaskInput): TaskRecord {
    this.cleanupExpiredTasks()
    const now = Date.now()
    if (input.dependencies?.some((dependencyId) => dependencyId.trim().length === 0)) {
      throw new Error('Task dependencies cannot contain empty IDs')
    }
    if (input.status === 'running') {
      const unresolvedDependencies = (input.dependencies ?? []).filter(
        (dependencyId) => this.getTask(workspaceId, dependencyId)?.status !== 'done'
      )
      if (unresolvedDependencies.length > 0) throw new TaskDependencyError(unresolvedDependencies)
    }
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      workspaceId,
      title: input.title,
      description: clampText(input.description, MAX_DESCRIPTION_LEN) ?? '',
      status: input.status ?? 'backlog',
      logs: [],
      comments: [],
      artifacts: input.artifacts ?? [],
      dependencies: input.dependencies ?? [],
      priority: input.priority ?? 'normal',
      requiredSkills: input.requiredSkills ?? [],
      reviewRequired: input.reviewRequired ?? true,
      attempts: input.attempts ?? 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    if (input.dispatchId !== undefined) {
      task.dispatchId = input.dispatchId
    }
    if (input.planGroupId !== undefined) {
      task.planGroupId = input.planGroupId
      task.plannedAt = input.plannedAt ?? now
    }
    if (input.completion !== undefined) {
      task.completion = input.completion
    }
    if (input.assignedAgentId !== undefined) {
      task.assignedAgentId = input.assignedAgentId
    }
    if (input.claimedBy !== undefined) {
      task.claimedBy = input.claimedBy
    }
    if (input.claimedAt !== undefined) {
      task.claimedAt = input.claimedAt
    }
    if (input.claimExpiresAt !== undefined) {
      task.claimExpiresAt = input.claimExpiresAt
    }
    if (input.startedAt !== undefined) {
      task.startedAt = input.startedAt
    }
    if (input.finishedAt !== undefined) {
      task.finishedAt = input.finishedAt
    }
    if (input.result !== undefined) {
      task.result = clampText(input.result, MAX_RESULT_LEN)
    }
    if (input.role !== undefined) task.role = input.role
    if (input.parentTaskId !== undefined) task.parentTaskId = input.parentTaskId
    if (input.reviewerAgentId !== undefined) task.reviewerAgentId = input.reviewerAgentId
    if (input.supersededFrom !== undefined && input.supersededFrom !== null) {
      task.supersededFrom = input.supersededFrom
    }
    this.tasks.set(task.id, task)
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  getTask(workspaceId: string, taskId: string): TaskRecord | undefined {
    this.cleanupExpiredTasks()
    const task = this.tasks.get(taskId)
    if (!task || task.workspaceId !== workspaceId) {
      return undefined
    }
    return task
  }

  getTaskByDispatchId(workspaceId: string, dispatchId: string): TaskRecord | undefined {
    this.cleanupExpiredTasks()
    const trimmed = dispatchId.trim()
    for (const task of this.tasks.values()) {
      if (task.workspaceId === workspaceId) {
        if (task.dispatchId === trimmed || task.id === trimmed || task.id.startsWith(trimmed)) {
          return task
        }
      }
    }
    return undefined
  }

  getTaskById(taskId: string): TaskRecord | undefined {
    this.cleanupExpiredTasks()
    return this.tasks.get(taskId)
  }

  /**
   * Resolves a possibly-short task id to a full task record. The Kanban board
   * and notifications render ids as `#<first8>` (e.g. `#f064b6b3`), so callers
   * often pass that truncated form. Accepts the bare prefix (with or without a
   * leading `#`); returns the single matching task or throws on ambiguity.
   */
  resolveTaskId(workspaceId: string, rawId: string): TaskRecord | undefined {
    const normalized = rawId.trim().replace(/^#/, '')
    if (!normalized) return undefined
    const exact = this.getTask(workspaceId, normalized)
    if (exact) return exact
    const candidates = this.listTasks(workspaceId).filter((t) => t.id.startsWith(normalized))
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      const preview = candidates
        .slice(0, 3)
        .map((t) => t.id.slice(0, 8))
        .join(', ')
      throw new Error(
        'Ambiguous task id "' +
          rawId +
          '": matches ' +
          String(candidates.length) +
          ' tasks (' +
          preview +
          (candidates.length > 3 ? '…' : '') +
          ')'
      )
    }
    return undefined
  }

  listTasks(workspaceId: string): TaskRecord[] {
    this.cleanupExpiredTasks()
    return Array.from(this.tasks.values()).filter((t) => t.workspaceId === workspaceId)
  }

  /**
   * Атомарно захватывает задачу воркером (READY -> CLAIMED) с увеличением attempts и фиксацией claimedBy.
   * Гарантирует, что два воркера не смогут забрать одну задачу одновременно.
   */
  claimTask(
    workspaceId: string,
    taskId: string,
    agentId: string,
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS
  ): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return undefined
    if (task.status !== 'ready') return undefined
    if (task.claimedBy && task.claimedBy !== agentId) return undefined

    const now = Date.now()
    task.status = 'claimed'
    task.assignedAgentId = agentId
    task.claimedBy = agentId
    task.claimedAt = now
    task.claimExpiresAt = now + claimTimeoutMs
    task.attempts = (task.attempts ?? 0) + 1
    task.version = (task.version ?? 0) + 1
    task.updatedAt = now
    task.logs.push(
      `[${new Date(now).toISOString()}] [CLAIM] Задача атомарно захвачена воркером @${agentId.split(':').pop()} (попытка #${task.attempts})`
    )
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  /**
   * Подтверждает, что агент реально получил задачу (CLAIMED -> ASSIGNED).
   */
  markTaskAssigned(workspaceId: string, taskId: string): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task || task.status !== 'claimed') return undefined
    const now = Date.now()
    task.status = 'assigned'
    // The claim lease guards only the claim→assign window. Keeping it alive
    // through the delivery phase let the 2-minute eviction release cards whose
    // payload was still in flight (slow engine spawn, session-resume paste);
    // the late onDelivered then found a `ready` card markTaskRunning could not
    // promote, so the worker executed a task the board showed as READY. A
    // genuinely stalled `assigned` card is released by the watchdog (no active
    // run), which checks the live process instead of a fixed deadline.
    delete task.claimedAt
    delete task.claimExpiresAt
    task.version = (task.version ?? 0) + 1
    task.updatedAt = now
    task.logs.push(
      `[${new Date(now).toISOString()}] [ASSIGN] Задача передана агенту @${task.claimedBy?.split(':').pop() ?? task.assignedAgentId?.split(':').pop()}`
    )
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  /**
   * Фиксирует старт выполнения (ASSIGNED -> RUNNING) с записью startedAt.
   */
  markTaskRunning(workspaceId: string, taskId: string): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return undefined
    if (task.status !== 'assigned' && task.status !== 'claimed') return undefined

    const unresolvedDependencies = task.dependencies.filter(
      (dependencyId) => this.getTask(workspaceId, dependencyId)?.status !== 'done'
    )
    if (unresolvedDependencies.length > 0) throw new TaskDependencyError(unresolvedDependencies)

    const now = Date.now()
    task.status = 'running'
    task.startedAt = now
    task.version = (task.version ?? 0) + 1
    task.updatedAt = now
    task.logs.push(`[${new Date(now).toISOString()}] [RUNNING] Задача начала выполняться`)
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  /**
   * Возвращает CLAIMED/ASSIGNED задачи, чей claim старше maxAgeMs, обратно в READY
   * (агент не стартовал за timeout).
   */
  releaseExpiredClaims(
    maxAgeMs: number,
    now = Date.now()
  ): Array<{ workspaceId: string; taskId: string }> {
    const expired: Array<{ workspaceId: string; taskId: string }> = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'claimed' && task.status !== 'assigned') continue
      // Only cards that actually hold a claim window are evictable. The
      // updatedAt fallback used to hit `team send` cards (created directly as
      // `assigned` with no claim fields) and requeue them mid-delivery.
      if (task.claimExpiresAt === undefined && task.claimedAt === undefined) continue
      // Prefer the explicit lease; fall back to the legacy age heuristic.
      const expiresAt = task.claimExpiresAt ?? (task.claimedAt ?? task.updatedAt) + maxAgeMs
      if (now >= expiresAt) {
        this.releaseTask(task.workspaceId, task.id, 'Агент не стартовал в течение claim timeout')
        expired.push({ workspaceId: task.workspaceId, taskId: task.id })
      }
    }
    return expired
  }

  /**
   * Освобождает задачу при падении, сбое доставки или истечении claim.
   *
   * По умолчанию задача ВСЕГДА возвращается в READY: сбой доставки (воркер не
   * смог принять/стартовать) — это инфраструктурная проблема, а не невозможность
   * задачи. Автоматически задача в FAILED не переводится, иначе флейковый воркер
   * сжигает попытки и задача навсегда пропадает из диспетчеризации. Перевод в
   * FAILED — только явное решение через `options.permanent`.
   *
   * Sticky affinity: исполнитель СОХРАНЯЕТСЯ. Ready-карточка с привязкой
   * выдаётся диспетчером только своему воркеру (см. queue-engine), поэтому
   * после падения/остановки задача не «перепрыгивает» случайному свободному
   * агенту, а ждёт именно своего исполнителя (watchdog перезапускает его с
   * session resume). Снять привязку можно вручную через UI или она снимается
   * при удалении воркера.
   */
  releaseTask(
    workspaceId: string,
    taskId: string,
    reason: string,
    options?: { permanent?: boolean }
  ): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return undefined
    const now = Date.now()
    const attempts = task.attempts ?? 1
    const boundWorkerId = task.assignedAgentId
    delete task.claimedBy
    delete task.claimedAt
    delete task.claimExpiresAt
    delete task.startedAt

    if (options?.permanent) {
      task.status = 'failed'
      delete task.assignedAgentId
      task.logs.push(
        `[${new Date(now).toISOString()}] [RECOVERY] Задача переведена в FAILED: ${reason}`
      )
    } else {
      task.status = 'ready'
      task.logs.push(
        `[${new Date(now).toISOString()}] [RECOVERY] Задача освобождена и возвращена в READY${
          boundWorkerId ? ` (привязана за @${boundWorkerId.split(':').pop()})` : ''
        } (попытка ${attempts}): ${reason}`
      )
    }
    task.version = (task.version ?? 0) + 1
    task.updatedAt = now
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  updateTask(
    workspaceId: string,
    taskId: string,
    updates: UpdateTaskInput
  ): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return undefined

    if (updates.title !== undefined) task.title = updates.title
    if (updates.description !== undefined) {
      task.description = clampText(updates.description, MAX_DESCRIPTION_LEN) ?? ''
    }
    if (updates.dispatchId !== undefined) task.dispatchId = updates.dispatchId
    if (updates.status !== undefined && updates.status !== task.status) {
      if (!statusTransitions[task.status].includes(updates.status)) {
        throw new Error(`Invalid task transition: ${task.status} -> ${updates.status}`)
      }
      // Review is mandatory: a review-required task must pass through `review`
      // before `done` (the reviewer APPROVE path). Direct `assigned` -> `done`
      // used to bypass the reviewer entirely; only review-exempt cards (e.g.
      // the reviewer's own child card) may settle without one.
      if (updates.status === 'done' && task.reviewRequired && task.status !== 'review') {
        throw new Error(`Task requires review before done: ${task.status} -> done`)
      }
      if (updates.status === 'running') {
        const unresolvedDependencies = task.dependencies.filter(
          (dependencyId) => this.getTask(workspaceId, dependencyId)?.status !== 'done'
        )
        if (unresolvedDependencies.length > 0) throw new TaskDependencyError(unresolvedDependencies)
        task.startedAt = Date.now()
      } else if (
        updates.status === 'done' ||
        updates.status === 'failed' ||
        updates.status === 'canceled'
      ) {
        task.finishedAt = Date.now()
      }
      task.status = updates.status
    }
    if (updates.result !== undefined) task.result = clampText(updates.result, MAX_RESULT_LEN)
    if (updates.artifacts !== undefined) task.artifacts = updates.artifacts
    if (updates.dependencies !== undefined) task.dependencies = updates.dependencies
    if (updates.priority !== undefined) task.priority = updates.priority
    if (updates.requiredSkills !== undefined) task.requiredSkills = updates.requiredSkills
    if (updates.reviewRequired !== undefined) task.reviewRequired = updates.reviewRequired
    if (updates.role !== undefined) task.role = updates.role
    if (updates.parentTaskId !== undefined) task.parentTaskId = updates.parentTaskId
    if (updates.reviewerAgentId !== undefined) task.reviewerAgentId = updates.reviewerAgentId
    if (updates.supersededFrom !== undefined) {
      if (updates.supersededFrom === null) delete task.supersededFrom
      else task.supersededFrom = updates.supersededFrom
    }
    if (updates.claimedBy !== undefined) {
      if (updates.claimedBy === null) delete task.claimedBy
      else task.claimedBy = updates.claimedBy
    }
    if (updates.claimedAt !== undefined) {
      if (updates.claimedAt === null) delete task.claimedAt
      else task.claimedAt = updates.claimedAt
    }
    if (updates.claimExpiresAt !== undefined) {
      if (updates.claimExpiresAt === null) delete task.claimExpiresAt
      else task.claimExpiresAt = updates.claimExpiresAt
    }
    if (updates.nextRetryAt !== undefined) {
      if (updates.nextRetryAt === null) delete task.nextRetryAt
      else task.nextRetryAt = updates.nextRetryAt
    }
    if (updates.lastFailureCategory !== undefined) {
      task.lastFailureCategory = updates.lastFailureCategory
    }
    if (updates.startedAt !== undefined) {
      if (updates.startedAt === null) delete task.startedAt
      else task.startedAt = updates.startedAt
    }
    if (updates.finishedAt !== undefined) {
      if (updates.finishedAt === null) delete task.finishedAt
      else task.finishedAt = updates.finishedAt
    }
    if (updates.attempts !== undefined) task.attempts = updates.attempts
    if (updates.completion !== undefined) task.completion = updates.completion
    if (updates.assignedAgentId !== undefined) {
      if (updates.assignedAgentId === null) {
        delete task.assignedAgentId
      } else {
        task.assignedAgentId = updates.assignedAgentId
      }
    }
    task.version = (task.version ?? 0) + 1
    task.updatedAt = Date.now()
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  addLog(workspaceId: string | undefined, taskId: string, message: string): TaskRecord | undefined {
    const task = workspaceId ? this.getTask(workspaceId, taskId) : this.getTaskById(taskId)
    if (!task) return undefined
    task.logs.push(`[${new Date().toISOString()}] ${clampText(message, MAX_LOG_LEN) ?? ''}`)
    if (task.logs.length > MAX_TASK_LOGS) task.logs = task.logs.slice(-MAX_TASK_LOGS)
    task.updatedAt = Date.now()
    this.saveToDb()
    this.notifyChanged(task.workspaceId)
    return task
  }

  addComment(
    workspaceId: string,
    taskId: string,
    author: string,
    message: string,
    authorRole?: string,
    anchor?: { path?: string; line?: number }
  ): TaskRecord | undefined {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return undefined
    if (!task.comments) task.comments = []
    task.comments.push({
      id: crypto.randomUUID(),
      author,
      authorRole,
      message,
      timestamp: Date.now(),
      path: anchor?.path,
      line: anchor?.line,
    })
    if (task.comments.length > MAX_TASK_COMMENTS)
      task.comments = task.comments.slice(-MAX_TASK_COMMENTS)
    task.updatedAt = Date.now()
    this.saveToDb()
    this.notifyChanged(workspaceId)
    return task
  }

  findOpenTask(workspaceId: string): TaskRecord | undefined {
    return this.listTasks(workspaceId).find((t) => t.status === 'ready' && !t.assignedAgentId)
  }

  getAssignedTaskForWorker(workspaceId: string, workerIdOrName: string): TaskRecord | undefined {
    const statusRank: Record<string, number> = { running: 0, assigned: 1, claimed: 2, review: 3 }
    return this.listTasks(workspaceId)
      .filter((task) => {
        const inFlight =
          task.status === 'claimed' ||
          task.status === 'assigned' ||
          task.status === 'running' ||
          task.status === 'review'
        if (!inFlight) return false
        return (
          task.assignedAgentId === workerIdOrName ||
          (task.assignedAgentId &&
            (workerIdOrName.endsWith(task.assignedAgentId) ||
              task.assignedAgentId.endsWith(workerIdOrName)))
        )
      })
      .sort((left, right) => (statusRank[left.status] ?? 4) - (statusRank[right.status] ?? 4))
      .at(0)
  }

  deleteTask(workspaceId: string, taskId: string): boolean {
    const task = this.getTask(workspaceId, taskId)
    if (!task) return false
    const deleted = this.tasks.delete(taskId)
    if (deleted) {
      this.saveToDb()
      this.notifyChanged(workspaceId)
    }
    return deleted
  }

  clear(): void {
    this.tasks.clear()
    this.saveToDb()
  }
}

export const taskStore = new TaskStore()
