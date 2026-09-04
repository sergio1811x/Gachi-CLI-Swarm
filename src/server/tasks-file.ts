import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildProtocolDoc } from './gachi-team-guidance.js'

export const computeTasksRevision = (content: string): string =>
  createHash('sha1').update(content).digest('hex').slice(0, 16)

/**
 * Windows (R9): rename over a file that a watcher/indexer briefly holds open
 * fails with EPERM/EACCES/EBUSY. The lock always clears — retry with a short
 * backoff before surfacing the error.
 */
const WINDOWS_RENAME_ATTEMPTS = 15
const WINDOWS_RENAME_BACKOFF_MS = 200

const isTransientWindowsRenameError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

export const renameWithWindowsRetry = (from: string, to: string): void => {
  let lastError: unknown
  for (let attempt = 0; attempt < WINDOWS_RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      lastError = error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WINDOWS_RENAME_BACKOFF_MS)
    }
  }
  throw lastError
}

export class TasksRevisionConflictError extends Error {
  readonly currentContent: string
  readonly currentRevision: string

  constructor(currentContent: string, currentRevision: string) {
    super('tasks.md was modified by someone else since you last loaded it')
    this.name = 'TasksRevisionConflictError'
    this.currentContent = currentContent
    this.currentRevision = currentRevision
  }
}

interface TasksFileService {
  readTasks: (workspacePath: string) => { content: string; revision: string }
  /**
   * When `expectedRevision` is provided and doesn't match what's currently on
   * disk, throws TasksRevisionConflictError instead of writing — this is the
   * compare-and-swap guard against the UI clobbering an agent's concurrent
   * edit. Omit it to write unconditionally (existing callers that don't track
   * revisions keep working as before).
   */
  writeTasks: (
    workspacePath: string,
    content: string,
    expectedRevision?: string
  ) => { content: string; revision: string }
}

export const GACHI_DIR_NAME = '.gachi'
export const TASKS_FILE_NAME = 'tasks.md'
export const TASKS_RELATIVE_PATH = `${GACHI_DIR_NAME}/${TASKS_FILE_NAME}`
export const PROTOCOL_FILE_NAME = 'PROTOCOL.md'
export const PROTOCOL_RELATIVE_PATH = `${GACHI_DIR_NAME}/${PROTOCOL_FILE_NAME}`

export const getTasksFilePath = (workspacePath: string) =>
  join(workspacePath, GACHI_DIR_NAME, TASKS_FILE_NAME)

export const getProtocolFilePath = (workspacePath: string) =>
  join(workspacePath, GACHI_DIR_NAME, PROTOCOL_FILE_NAME)

const ensureTasksDir = (workspacePath: string) => {
  mkdirSync(dirname(getTasksFilePath(workspacePath)), { recursive: true })
}

export const ensureTasksFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const tasksFilePath = getTasksFilePath(workspacePath)
  if (existsSync(tasksFilePath)) {
    return readFileSync(tasksFilePath, 'utf8')
  }

  const content = ''
  writeFileSync(tasksFilePath, content, 'utf8')
  return content
}

/**
 * Always overwrites `.gachi/PROTOCOL.md` with the freshly-built protocol doc.
 * The doc is marked auto-generated so user edits are not expected; rewriting
 * on every workspace open means a version bump that changes the rules
 * propagates without manual intervention.
 */
export const ensureProtocolFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const protocolFilePath = getProtocolFilePath(workspacePath)
  const desired = buildProtocolDoc()
  const current = existsSync(protocolFilePath) ? readFileSync(protocolFilePath, 'utf8') : null
  if (current === desired) return desired
  writeFileSync(protocolFilePath, desired, 'utf8')
  return desired
}

export const createTasksFileService = (): TasksFileService => {
  return {
    readTasks(workspacePath) {
      const content = ensureTasksFile(workspacePath)
      return { content, revision: computeTasksRevision(content) }
    },

    writeTasks(workspacePath, content, expectedRevision) {
      ensureTasksDir(workspacePath)
      const tasksFilePath = getTasksFilePath(workspacePath)

      if (expectedRevision !== undefined) {
        const currentContent = existsSync(tasksFilePath) ? readFileSync(tasksFilePath, 'utf8') : ''
        const currentRevision = computeTasksRevision(currentContent)
        if (currentRevision !== expectedRevision) {
          throw new TasksRevisionConflictError(currentContent, currentRevision)
        }
      }

      // Atomic write: a crash or concurrent read mid-write can never observe a
      // half-written tasks.md — write to a sibling temp file, then rename,
      // which POSIX and Windows both guarantee is atomic within the same
      // directory/volume.
      //
      // R9 Windows: the watcher/AV may hold the destination open for a few
      // milliseconds, making renameSync throw EPERM/EACCES/EBUSY. Retry with
      // a tiny backoff before giving up — the lock always clears.
      const tempFilePath = `${tasksFilePath}.tmp-${randomUUID()}`
      writeFileSync(tempFilePath, content, 'utf8')
      try {
        renameWithWindowsRetry(tempFilePath, tasksFilePath)
      } catch (error) {
        try {
          rmSync(tempFilePath, { force: true })
        } catch {}
        // Last-resort fallback: losing a user's save to a stubborn FS lock is
        // worse than a brief non-atomic overwrite. The retry window above has
        // already proven the lock is exceptional.
        console.warn(
          `[TASKS FILE] atomic rename failed (${String(error)}); falling back to direct write`
        )
        writeFileSync(tasksFilePath, content, 'utf8')
      }

      return { content, revision: computeTasksRevision(content) }
    },
  }
}

export const formatTasksToMarkdown = (
  tasks: Array<{
    id: string
    title: string
    status: string
    description?: string | undefined
    assignedAgentId?: string | undefined
    result?: string | undefined
    comments?: Array<{ author: string; message: string }> | undefined
  }>
): string => {
  const lines: string[] = [
    '# Kanban Tasks Board',
    '',
    `Last synchronized: ${new Date().toISOString()}`,
    '',
  ]

  const statusLabels: Record<string, string> = {
    backlog: '🗂️ Backlog',
    ready: '📋 Ready (К выполнению)',
    assigned: '👤 Assigned',
    running: '⏳ Running (В работе)',
    review: '🔍 Review (На проверке)',
    failed: '⚠️ Failed',
    done: '✅ Done (Завершено)',
    canceled: '❌ Canceled (Отменено)',
  }

  const statuses = [
    'backlog',
    'ready',
    'assigned',
    'running',
    'review',
    'failed',
    'done',
    'canceled',
  ] as const
  for (const status of statuses) {
    const group = tasks.filter((t) => t.status === status)
    lines.push(`## ${statusLabels[status]} (${group.length})`, '')
    if (group.length === 0) {
      lines.push('_Нет задач в этой секции._', '')
      continue
    }
    for (const task of group) {
      lines.push(`### [${task.id.slice(0, 8)}] ${task.title}`)
      if (task.assignedAgentId) {
        lines.push(`- **Исполнитель:** @${task.assignedAgentId}`)
      }
      if (task.description) {
        lines.push(`- **Описание:** ${task.description}`)
      }
      if (task.result) {
        lines.push(`- **Отчёт ИИ:** ${task.result}`)
      }
      if (task.comments && task.comments.length > 0) {
        lines.push('- **Комментарии:**')
        for (const c of task.comments) {
          lines.push(`  - @${c.author}: ${c.message}`)
        }
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export const syncTasksMarkdownFile = (
  workspacePath: string,
  tasks: Array<{
    id: string
    title: string
    status: string
    description?: string | undefined
    assignedAgentId?: string | undefined
    result?: string | undefined
    comments?: Array<{ author: string; message: string }> | undefined
  }>
) => {
  try {
    ensureTasksDir(workspacePath)
    const content = formatTasksToMarkdown(tasks)
    const tasksFilePath = getTasksFilePath(workspacePath)
    writeFileSync(tasksFilePath, content, 'utf8')
    // Также пишем .gachi/TASK.md для совместимости
    const altTaskFilePath = join(workspacePath, GACHI_DIR_NAME, 'TASK.md')
    writeFileSync(altTaskFilePath, content, 'utf8')
  } catch (err) {
    console.error('[gachi] failed to sync tasks markdown file', err)
  }
}

export type { TasksFileService }
