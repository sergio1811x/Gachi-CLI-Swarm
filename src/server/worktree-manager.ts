import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface GitCommandRunner {
  run(args: string[], cwd: string): string
}

export class WorktreeError extends Error {}

const defaultRunner: GitCommandRunner = {
  run(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  },
}

/**
 * R9: agent ids may be non-ASCII (Cyrillic worker names are valid user
 * input). Instead of hard-failing the whole worktree pipeline, fall back to
 * a deterministic slug so branch names stay stable across processes.
 */
const safeSegment = (value: string) => {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (result) return result
  return `agent-${createHash('sha1').update(value).digest('hex').slice(0, 10)}`
}

const isContainedBy = (parent: string, child: string) => {
  const relation = relative(parent, child)
  return relation === '' || (!relation.startsWith('..') && !relation.includes(':'))
}

export const getAgentWorktreePath = (workspacePath: string, agentId: string) =>
  join(resolve(workspacePath), '.gachi', 'worktrees', safeSegment(agentId))

/** Every agent worktree lives on a `gachi/<agent>` branch. */
export const resolveWorkerBranchName = (
  workspacePath: string,
  agentId: string,
  runner: GitCommandRunner = defaultRunner
): string => {
  void workspacePath
  void runner
  return `gachi/${safeSegment(agentId)}`
}

export const isGitWorkspaceRoot = (
  workspacePath: string,
  runner: GitCommandRunner = defaultRunner
) => {
  try {
    const root = realpathSync(workspacePath)
    return resolve(runner.run(['rev-parse', '--show-toplevel'], root).trim()) === root
  } catch {
    return false
  }
}

export const createAgentWorktree = (
  workspacePath: string,
  agentId: string,
  runner: GitCommandRunner = defaultRunner
) => {
  const root = realpathSync(workspacePath)
  const worktreePath = getAgentWorktreePath(root, agentId)
  const worktreeRoot = join(root, '.gachi', 'worktrees')
  if (!isContainedBy(worktreeRoot, worktreePath)) {
    throw new WorktreeError('Resolved worktree path escaped the workspace worktree directory')
  }

  let gitRoot: string
  try {
    gitRoot = runner.run(['rev-parse', '--show-toplevel'], root).trim()
  } catch {
    throw new WorktreeError(`Workspace is not a Git repository: ${root}`)
  }
  if (resolve(gitRoot) !== root) {
    throw new WorktreeError(
      'Workspace must be the Git repository root before creating agent worktrees'
    )
  }

  if (existsSync(worktreePath)) return worktreePath
  mkdirSync(worktreeRoot, { recursive: true })
  const branch = resolveWorkerBranchName(root, agentId)
  try {
    runner.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root)
    runner.run(['worktree', 'add', worktreePath, branch], root)
  } catch {
    try {
      runner.run(['worktree', 'add', '-b', branch, worktreePath], root)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new WorktreeError(`Unable to create agent worktree ${agentId}: ${message}`)
    }
  }
  return worktreePath
}

/**
 * Merges the agent's worktree branch back into main.
 *
 * Strategy: FF-first → if FF fails (parallel workers diverged), rebase the
 * worker branch onto current main inside the worktree, then retry FF.
 * If rebase also conflicts → return conflict for manual resolution.
 */
export const mergeWorktreeToMain = (
  workspacePath: string,
  agentId: string,
  runner: GitCommandRunner = defaultRunner
): { merged: boolean; filesChanged: number; error: string | null } => {
  const root = realpathSync(workspacePath)
  const branch = resolveWorkerBranchName(root, agentId, runner)
  const wtPath = getAgentWorktreePath(root, agentId)

  try {
    // Check if worker has any commits not in the current checkout.
    const log = runner.run(
      ['log', '--oneline', `${branch}`, '--not', 'HEAD', '--max-count', '1'],
      root
    )
    if (!log.trim()) return { merged: false, filesChanged: 0, error: null }
  } catch {
    // Branch might not exist — nothing to merge.
    return { merged: false, filesChanged: 0, error: null }
  }

  // Attempt 1: fast-forward merge.
  try {
    runner.run(['merge', branch, '--no-edit', '--ff-only'], root)
    const count = countChangedFiles(runner, root)
    return { merged: true, filesChanged: count, error: null }
  } catch {
    // Not a fast-forward — need rebase.
  }

  // Attempt 2: rebase worker branch onto current main tip SHA, then retry
  // FF merge. If rebase conflicts → abort and report.
  if (!existsSync(wtPath)) {
    return { merged: false, filesChanged: 0, error: `worktree missing for ${agentId}` }
  }
  try {
    const mainSha = runner.run(['rev-parse', 'HEAD'], root).trim()
    runner.run(['rebase', mainSha], wtPath)
    // Rebase succeeded — now FF merge from main.
    runner.run(['merge', branch, '--no-edit', '--ff-only'], root)
    const count = countChangedFiles(runner, root)
    return { merged: true, filesChanged: count, error: null }
  } catch (error) {
    // Abort the rebase to leave the worktree in a clean state.
    try {
      runner.run(['rebase', '--abort'], wtPath)
    } catch {}
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { merged: false, filesChanged: 0, error: message || 'rebase conflict' }
  }
}

const countChangedFiles = (runner: GitCommandRunner, cwd: string): number => {
  try {
    const diff = runner.run(['diff', '--stat', 'HEAD~1..HEAD'], cwd)
    const match = /(\d+) files? changed/.exec(diff)
    return match ? Number(match[1]) : 1
  } catch {
    return 1
  }
}

/**
 * Removes a stale worktree (after worker deletion or manual cleanup).
 */
export const removeAgentWorktree = (
  workspacePath: string,
  agentId: string,
  runner: GitCommandRunner = defaultRunner
): void => {
  const root = resolve(workspacePath)
  const worktreePath = getAgentWorktreePath(root, agentId)
  if (!existsSync(worktreePath)) return
  try {
    runner.run(['worktree', 'remove', '--force', worktreePath], root)
    try {
      runner.run(['branch', '-D', `gachi/${safeSegment(agentId)}`], root)
    } catch {}
  } catch {}
}
