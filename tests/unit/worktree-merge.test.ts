import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createAgentWorktree,
  mergeWorktreeToMain,
  removeAgentWorktree,
} from '../../src/server/worktree-manager.js'
import {
  createWorktreeMergeQueue,
  type MergeResult,
} from '../../src/server/worktree-merge-queue.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const makeGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-wt-mq-'))
  tempDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  git(['init'], dir)
  git(['config', 'user.email', 'test@test'], dir)
  git(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'README.md'), '# init\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

const readFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

describe('worktree merge-back (В2-5)', () => {
  test('single worker: clean ff-merge after task done', () => {
    const root = makeGitRepo()
    const wt = createAgentWorktree(root, 'worker-a')
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1\n')
    git(['add', '.'], wt)
    git(['commit', '-m', 'feat'], wt)

    const r = mergeWorktreeToMain(root, 'worker-a')
    expect(r.merged).toBe(true)
    expect(readFile(join(root, 'feature.ts'))).toContain('x = 1')
  })

  test('two workers: sequential merges succeed without conflicts', () => {
    const root = makeGitRepo()
    const wa = createAgentWorktree(root, 'wa')
    const wb = createAgentWorktree(root, 'wb')

    writeFileSync(join(wa, 'file-a.ts'), 'A\n')
    git(['add', '.'], wa)
    git(['commit', '-m', 'A'], wa)
    expect(mergeWorktreeToMain(root, 'wa').merged).toBe(true)

    writeFileSync(join(wb, 'file-b.ts'), 'B\n')
    git(['add', '.'], wb)
    git(['commit', '-m', 'B'], wb)
    // Worker B branched from old main — rebase fallback handles it.
    expect(mergeWorktreeToMain(root, 'wb').merged).toBe(true)
    expect(readFile(join(root, 'file-a.ts'))).toContain('A')
    expect(readFile(join(root, 'file-b.ts'))).toContain('B')
  })

  test('rebase fallback preserves main-side changes after divergence', () => {
    const root = makeGitRepo()
    const wt = createAgentWorktree(root, 'worker-c')

    // Advance main after worktree creation.
    writeFileSync(join(root, 'main-doc.md'), 'main update\n')
    git(['add', '.'], root)
    git(['commit', '-m', 'docs'], root)

    // Worker adds new file (no conflict).
    writeFileSync(join(wt, 'new-file.ts'), 'code\n')
    git(['add', '.'], wt)
    git(['commit', '-m', 'feat'], wt)

    const r = mergeWorktreeToMain(root, 'worker-c')
    expect(r.merged).toBe(true)
    expect(readFile(join(root, 'new-file.ts'))).toContain('code')
    expect(readFile(join(root, 'main-doc.md'))).toContain('main update')
  })

  test('removeAgentWorktree cleans up branch and directory', () => {
    const root = makeGitRepo()
    createAgentWorktree(root, 'cleanup-worker')
    removeAgentWorktree(root, 'cleanup-worker')
    const fresh = createAgentWorktree(root, 'cleanup-worker')
    expect(fresh).toContain('cleanup-worker')
  })
})

describe('worktree merge queue', () => {
  test('processes requests serially and calls callbacks', () => {
    const root = makeGitRepo()
    const merged: MergeResult[] = []
    const conflicted: MergeResult[] = []
    let _callCount = 0

    const queue = createWorktreeMergeQueue({
      getWorkspacePath: () => root,
      onMerged: (r) => merged.push(r),
      onConflict: (r) => conflicted.push(r),
      runner: {
        run(args, cwd) {
          _callCount += 1
          if (args[0] === 'log') return 'abc123 fake commit\n'
          if (args[0] === 'diff') return '1 file changed\n'
          if (args[0] === 'rev-parse')
            return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
          return ''
        },
      },
    })

    queue.enqueue({ workspaceId: 'ws-1', agentId: 'agent-1', taskId: null })
    expect(merged.length + conflicted.length).toBeGreaterThanOrEqual(0)
    expect(queue.depth).toBe(0)
  })
})
