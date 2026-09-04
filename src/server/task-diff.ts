import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Review diff for a task card (roadmap Wave 1): workers run in the shared
 * workspace checkout, so "what did the worker change" is the working-tree
 * delta against HEAD plus untracked files. Read-only git plumbing — no
 * index mutation, no network.
 */

const exec = promisify(execFile)

/** Unified-diff payloads are capped so a pathological repo cannot flood the UI. */
const MAX_DIFF_BYTES = 512 * 1024

export interface TaskDiffSuccess {
  ok: true
  branch: string | null
  clean: boolean
  /** Unified diff against HEAD (empty string when nothing tracked changed). */
  diff: string
  untrackedFiles: string[]
  truncated: boolean
}

export interface TaskDiffUnavailable {
  ok: false
  error: string
}

export type TaskDiffResult = TaskDiffSuccess | TaskDiffUnavailable

const GIT = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

export const buildTaskDiff = async (workspacePath: string): Promise<TaskDiffResult> => {
  try {
    const branch = (await GIT(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let diff = ''
    try {
      // Empty repos have no HEAD; treat as "no tracked changes".
      diff = await GIT(workspacePath, ['diff', 'HEAD'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/unknown revision|bad revision|does not have any commits yet/i.test(message)) {
        throw error
      }
    }
    const status = await GIT(workspacePath, ['status', '--porcelain'])
    const untrackedFiles = status
      .split(/\r?\n/)
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
    const truncated = Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES
    return {
      ok: true,
      branch: branch || null,
      clean: diff.trim() === '' && untrackedFiles.length === 0,
      diff: truncated
        ? `${Buffer.from(diff, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n… (truncated)`
        : diff,
      truncated,
      untrackedFiles,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { ok: false, error: message || 'git is not available' }
  }
}
