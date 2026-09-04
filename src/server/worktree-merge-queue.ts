import type { GitCommandRunner } from './worktree-manager.js'
import { mergeWorktreeToMain } from './worktree-manager.js'

/**
 * Serial merge queue (roadmap В2-5 фаза 2): collects merge requests from
 * worker completions and processes them one at a time. Concurrent merges on
 * the same git repo are unsafe (index lock + ref races), so all merges go
 * through a single pipeline.
 */

export interface MergeRequest {
  workspaceId: string
  agentId: string
  taskId: string | null
}

export interface MergeResult {
  agentId: string
  taskId: string | null
  merged: boolean
  filesChanged: number
  error: string | null
}

export interface WorktreeMergeQueueDeps {
  getWorkspacePath: (workspaceId: string) => string | null
  onMerged: (result: MergeResult) => void
  onConflict: (result: MergeResult) => void
  runner?: GitCommandRunner
}

export interface WorktreeMergeQueue {
  enqueue: (req: MergeRequest) => void
  flush: () => Promise<number>
  readonly depth: number
  stop: () => void
}

export const createWorktreeMergeQueue = (deps: WorktreeMergeQueueDeps): WorktreeMergeQueue => {
  const queue: MergeRequest[] = []
  let processing = false

  const processOne = (req: MergeRequest): MergeResult => {
    try {
      const wsPath = deps.getWorkspacePath(req.workspaceId)
      if (!wsPath) {
        return { ...req, merged: false, filesChanged: 0, error: 'workspace not found' }
      }
      const result = mergeWorktreeToMain(wsPath, req.agentId, deps.runner)
      return { ...req, ...result }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ...req, merged: false, filesChanged: 0, error: msg }
    }
  }

  const flushSync = (): number => {
    let completed = 0
    while (queue.length > 0) {
      const req = queue.shift()
      if (!req) break
      const result = processOne(req)

      if (result.merged) {
        deps.onMerged(result)
        completed += 1
      } else if (result.error) {
        deps.onConflict(result)
      }
      // No error + not merged = no new commits — skip silently.
    }
    return completed
  }

  return {
    enqueue(req) {
      queue.push(req)
      // Fire-and-forget flush; serial lock prevents overlap.
      if (!processing) {
        processing = true
        try {
          flushSync()
        } finally {
          processing = false
        }
      }
    },

    async flush() {
      return flushSync()
    },

    get depth() {
      return queue.length
    },

    stop() {
      queue.length = 0
    },
  }
}
