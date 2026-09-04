import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createAgentWorktree,
  type GitCommandRunner,
  getAgentWorktreePath,
  isGitWorkspaceRoot,
} from '../../src/server/worktree-manager.js'

describe('worktree manager', () => {
  const directories: string[] = []
  const workspace = () => {
    const path = mkdtempSync(join(tmpdir(), 'gachi-worktree-'))
    directories.push(path)
    return path
  }

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { force: true, recursive: true })
  })

  test('derives a workspace-contained stable path from an agent id', () => {
    expect(getAgentWorktreePath('C:/repo', 'ws:Backend Agent')).toMatch(
      /\.gachi[\\/]worktrees[\\/]ws-backend-agent$/
    )
  })

  test('creates a dedicated branch worktree when the branch does not exist', () => {
    const path = workspace()
    const run = vi.fn((args: string[]) => {
      if (args[0] === 'rev-parse') return `${path}\n`
      if (args[0] === 'show-ref') throw new Error('missing branch')
      return ''
    })
    const runner: GitCommandRunner = { run }

    createAgentWorktree(path, 'Backend Agent', runner)

    expect(run).toHaveBeenCalledWith(
      ['worktree', 'add', '-b', 'gachi/backend-agent', expect.stringMatching(/backend-agent$/)],
      expect.any(String)
    )
  })

  test('recognizes only an actual Git root as safe for automatic isolation', () => {
    const path = workspace()
    const runner: GitCommandRunner = { run: () => `${path}\n` }

    expect(isGitWorkspaceRoot(path, runner)).toBe(true)
    expect(isGitWorkspaceRoot(path, { run: () => 'C:/another-repo\n' })).toBe(false)
  })
})
