import { execFileSync } from 'node:child_process'

/**
 * GitHub PR flow (roadmap Wave 2): publish a worker's `gachi/<agent>` branch
 * to origin and open a pull request via the `gh` CLI.
 *
 * The runtime never talks to the GitHub API directly — `gh` owns auth and
 * enterprise host handling. Everything here is injectable through a runner
 * so tests can fake both git and gh without network access.
 */

export interface GhCommandRunner {
  run(file: string, args: string[], cwd: string, input?: string): string
}

export class GhError extends Error {
  readonly kind: 'not_installed' | 'not_authed' | 'git_failed' | 'gh_failed'
  constructor(kind: GhError['kind'], message: string) {
    super(message)
    this.name = 'GhError'
    this.kind = kind
  }
}

const defaultRunner: GhCommandRunner = {
  run(file, args, cwd) {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  },
}

export interface GhStatus {
  installed: boolean
  authed: boolean
  error: string | null
}

/** Checks that `gh` exists on PATH and is authenticated for this repo. */
export const checkGhStatus = (cwd: string, runner: GhCommandRunner = defaultRunner): GhStatus => {
  try {
    runner.run('gh', ['--version'], cwd)
  } catch (error) {
    return {
      installed: false,
      authed: false,
      error:
        (error instanceof Error ? error.message.split('\n')[0] : undefined) ??
        'gh CLI not found on PATH',
    }
  }
  try {
    runner.run('gh', ['auth', 'status'], cwd)
    return { installed: true, authed: true, error: null }
  } catch (error) {
    return {
      installed: true,
      authed: false,
      error: (error instanceof Error ? error.message.split('\n')[0] : undefined) ?? String(error),
    }
  }
}

export interface BranchPrInput {
  /** Repo root (workspace path). */
  cwd: string
  /** Local branch to publish, e.g. `gachi/worker-abc`. */
  branch: string
  title: string
  body?: string | undefined
  /** Target branch; defaults to the repo's remote default. */
  base?: string | undefined
}

export interface CreatedPr {
  url: string
  number: number | null
}

/**
 * Pushes the branch to origin (creating/updating the remote ref) and opens
 * a PR for it. Re-running with the same branch updates the existing PR's
 * commits; `gh pr create` fails loudly if a PR already exists.
 */
export const createBranchPr = (
  input: BranchPrInput,
  runner: GhCommandRunner = defaultRunner
): CreatedPr => {
  const status = checkGhStatus(input.cwd, runner)
  if (!status.installed) throw new GhError('not_installed', status.error ?? 'gh not found')
  if (!status.authed) throw new GhError('not_authed', status.error ?? 'gh not authenticated')

  const safeBranch = input.branch.trim()
  if (!safeBranch || /\s/.test(safeBranch)) {
    throw new GhError('git_failed', `Invalid branch name: "${input.branch}"`)
  }

  try {
    runner.run('git', ['push', '-u', 'origin', `${safeBranch}:${safeBranch}`], input.cwd)
  } catch (error) {
    throw new GhError(
      'git_failed',
      `git push failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    )
  }

  const args = ['pr', 'create', '--head', safeBranch]
  if (input.base) args.push('--base', input.base)
  args.push('--title', input.title)
  if (input.body) args.push('--body', input.body)

  let stdout: string
  try {
    stdout = runner.run('gh', args, input.cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A PR for this head already exists — surface its URL instead of failing.
    const existing = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/.exec(message)
    if (existing) {
      return { url: existing[0], number: Number(existing[1]) }
    }
    throw new GhError('gh_failed', message.split('\n')[0] ?? 'gh pr create failed')
  }

  const url = stdout.trim().split('\n').pop() ?? ''
  const numberMatch = /pull\/(\d+)/.exec(url)
  return { url, number: numberMatch ? Number(numberMatch[1]) : null }
}

export interface OpenPrSummary {
  head: string
  /** Latest commit sha on the PR head (null when gh omits it). */
  headSha: string | null
  number: number
  state: string
  title: string
  url: string
}

interface GhPrListRow {
  headRefName?: unknown
  headRefOid?: unknown
  number?: unknown
  state?: unknown
  title?: unknown
  url?: unknown
}

/** Lists open PRs for the repo (best-effort JSON parsing). */
export const listOpenPrs = (
  cwd: string,
  runner: GhCommandRunner = defaultRunner
): OpenPrSummary[] => {
  const status = checkGhStatus(cwd, runner)
  if (!status.installed || !status.authed) return []
  let stdout: string
  try {
    stdout = runner.run(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,title,state,headRefName,headRefOid,url'],
      cwd
    )
  } catch {
    return []
  }
  try {
    const rows = JSON.parse(stdout) as GhPrListRow[]
    return rows.flatMap((row) => {
      if (
        typeof row.number !== 'number' ||
        typeof row.title !== 'string' ||
        typeof row.url !== 'string' ||
        typeof row.headRefName !== 'string' ||
        typeof row.state !== 'string'
      ) {
        return []
      }
      return [
        {
          head: row.headRefName,
          headSha: typeof row.headRefOid === 'string' ? row.headRefOid : null,
          number: row.number,
          state: row.state,
          title: row.title,
          url: row.url,
        },
      ]
    })
  } catch {
    return []
  }
}
