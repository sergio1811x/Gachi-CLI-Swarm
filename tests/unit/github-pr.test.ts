import { describe, expect, test } from 'vitest'

import {
  checkGhStatus,
  createBranchPr,
  type GhCommandRunner,
  GhError,
  listOpenPrs,
} from '../../src/server/github-pr.js'

/** Records every spawned command; canned stdout per command prefix. */
const fakeRunner = (options: {
  failFor?: Array<{ file: string; args: string[] }>
  prCreateStdout?: string
  prListJson?: string
}) => {
  const calls: Array<{ args: string[]; file: string }> = []
  const runner: GhCommandRunner = {
    run(file, args) {
      calls.push({ args, file })
      const failed = options.failFor?.find(
        (f) => f.file === file && f.args.every((a, i) => a === '*' || args[i] === a)
      )
      if (failed) throw new Error('spawn failure')
      if (file === 'gh' && args[0] === '--version') return 'gh version 2.0.0'
      if (file === 'gh' && args[0] === 'auth') return ''
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return options.prCreateStdout ?? 'https://github.com/acme/widgets/pull/9\n'
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return (
          options.prListJson ??
          '[{"headRefName":"gachi/a","number":1,"state":"OPEN","title":"t","url":"u"}]'
        )
      }
      return ''
    },
  }
  return { calls, runner }
}

describe('checkGhStatus', () => {
  test('reports installed and authed when both commands succeed', () => {
    const { runner } = fakeRunner({})
    const status = checkGhStatus('/repo', runner)
    expect(status).toEqual({ authed: true, error: null, installed: true })
  })

  test('reports not installed when gh is missing', () => {
    const { runner } = fakeRunner({ failFor: [{ file: 'gh', args: ['--version'] }] })
    const status = checkGhStatus('/repo', runner)
    expect(status.installed).toBe(false)
    expect(status.authed).toBe(false)
  })

  test('reports unauthenticated when auth status fails', () => {
    const { runner } = fakeRunner({ failFor: [{ file: 'gh', args: ['auth'] }] })
    const status = checkGhStatus('/repo', runner)
    expect(status.installed).toBe(true)
    expect(status.authed).toBe(false)
  })
})

describe('createBranchPr', () => {
  test('pushes the branch then opens a PR with title/body/base', () => {
    const { calls, runner } = fakeRunner({})
    const created = createBranchPr(
      {
        base: 'main',
        body: 'notes',
        branch: 'gachi/worker-1',
        cwd: '/repo',
        title: 'Worker work',
      },
      runner
    )
    expect(created.url).toContain('/pull/9')
    expect(created.number).toBe(9)

    const push = calls.find((c) => c.file === 'git' || c.args[0] === 'push')
    expect(push?.args.slice(0, 4)).toEqual([
      'push',
      '-u',
      'origin',
      'gachi/worker-1:gachi/worker-1',
    ])
    const createCall = calls.find((c) => c.args[0] === 'pr')
    expect(createCall?.args).toContain('--base')
    expect(createCall?.args).toContain('main')
    expect(createCall?.args).toContain('--title')
  })

  test('rejects branch names with whitespace before touching git', () => {
    const { calls, runner } = fakeRunner({})
    expect(() =>
      createBranchPr({ branch: 'bad branch name', cwd: '/repo', title: 'x' }, runner)
    ).toThrow(GhError)
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined()
  })

  test('unauthenticated gh surfaces as not_authed kind', () => {
    const { runner } = fakeRunner({ failFor: [{ file: 'gh', args: ['auth'] }] })
    try {
      createBranchPr({ branch: 'b', cwd: '/repo', title: 'x' }, runner)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(GhError)
      expect((error as GhError).kind).toBe('not_authed')
    }
  })

  test('existing-PR error is parsed into the PR url instead of failing', () => {
    const base = fakeRunner({ failFor: [{ file: 'gh', args: ['pr', 'create'] }] })
    // Make only pr/create fail with the "already exists" message.
    const wrapped: GhCommandRunner = {
      run(file, args, cwd, input) {
        try {
          return base.runner.run(file, args, cwd, input)
        } catch (error) {
          if (file === 'gh' && args[0] === 'pr') {
            throw new Error(
              'a pull request for branch "gachi/x" already exists: https://github.com/acme/widgets/pull/12'
            )
          }
          throw error
        }
      },
    }
    const created = createBranchPr({ branch: 'gachi/x', cwd: '/repo', title: 'dup' }, wrapped)
    expect(created.number).toBe(12)
    expect(created.url).toContain('/pull/12')
  })
})

describe('listOpenPrs', () => {
  test('parses gh json output into summaries', () => {
    const { runner } = fakeRunner({
      prListJson:
        '[{"headRefName":"gachi/a","headRefOid":"abc123","number":3,"state":"OPEN","title":"A","url":"https://x/pull/3"}]',
    })
    const prs = listOpenPrs('/repo', runner)
    expect(prs).toEqual([
      {
        head: 'gachi/a',
        headSha: 'abc123',
        number: 3,
        state: 'OPEN',
        title: 'A',
        url: 'https://x/pull/3',
      },
    ])
  })

  test('returns an empty list when gh is unusable or output is malformed', () => {
    const broken = fakeRunner({ failFor: [{ file: 'gh', args: ['--version'] }] })
    expect(listOpenPrs('/repo', broken.runner)).toEqual([])

    const malformed = fakeRunner({ prListJson: 'not-json{{{' })
    expect(listOpenPrs('/repo', malformed.runner)).toEqual([])
  })
})
