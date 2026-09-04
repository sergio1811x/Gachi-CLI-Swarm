import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  createAgentWorktree,
  mergeWorktreeToMain,
  resolveWorkerBranchName,
} from '../../src/server/worktree-manager.js'

/**
 * ROADMAP R9: Windows-first honesty checks. Real users put projects into
 * paths like `C:\Users\Иван Петров\мои проекты\` — spaces and Cyrillic
 * must survive the whole merge pipeline: branch names, worktrees, git runs.
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const makeRepoAt = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  git(['init'], dir)
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 'T'], dir)
  writeFileSync(join(dir, 'README.md'), '# init\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

describe('paths with spaces and Cyrillic (R9)', () => {
  const trickyRoot = join(tmpdir(), 'гачи swarm test dir')

  test('worktree merge-back survives spaces and Cyrillic', () => {
    const repo = makeRepoAt(join(trickyRoot, 'проект с пробелами'))
    const wt = createAgentWorktree(repo, 'воркер альфа')
    expect(wt).toContain(repo)

    writeFileSync(join(wt, 'feature.txt'), 'done\n')
    git(['add', '.'], wt)
    git(['commit', '-m', 'feat: кириллический коммит'], wt)

    const result = mergeWorktreeToMain(repo, 'воркер альфа')
    expect(result.merged).toBe(true)
    expect(result.error).toBeNull()
    expect(git(['log', '--oneline', '-2'], repo)).toContain('feat: кириллический коммит')

    // Branch naming is stable across repeated resolution.
    const again = resolveWorkerBranchName(repo, 'воркер альфа')
    const first = resolveWorkerBranchName(repo, 'воркер альфа')
    expect(again).toBe(first)
    expect(again.startsWith('gachi/')).toBe(true)
  })

  test('SQLite data dir with Cyrillic + spaces round-trips app state', () => {
    const dataDir = join(trickyRoot, 'датa директория данные')
    mkdirSync(dataDir, { recursive: true })
    tempDirs.push(dataDir)
    const dbPath = join(dataDir, 'runtime.sqlite')

    const db = new Database(dbPath)
    initializeRuntimeDatabase(db)
    db.prepare(
      "INSERT INTO app_state (key, value, updated_at) VALUES ('probe_key', 'значение ок', ?)"
    ).run(Date.now())
    db.close()

    const reopened = new Database(dbPath)
    const row = reopened.prepare('SELECT value FROM app_state WHERE key = ?').get('probe_key') as
      | { value: string }
      | undefined
    reopened.close()
    expect(row?.value).toBe('значение ок')
  })

  test('merge conflict path reports cleanly on tricky paths', () => {
    const repo = makeRepoAt(join(trickyRoot, 'conflict dir'))
    const wt = createAgentWorktree(repo, 'worker бета')

    // Diverge main inside the worktree's base → force rebase-conflict.
    writeFileSync(join(wt, 'shared.txt'), 'worker line\n')
    git(['add', '.'], wt)
    git(['commit', '-m', 'feat: worker edit'], wt)

    writeFileSync(join(repo, 'shared.txt'), 'main line\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'feat: main edit'], repo)

    const result = mergeWorktreeToMain(repo, 'worker бета')
    expect(result.merged).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
