import { execFileSync } from 'node:child_process'

/**
 * Changelog generation (ROADMAP R4): merges git history with the swarm's own
 * task/PR journal so release notes reflect both code commits and agent work.
 */

export interface ChangelogCommit {
  date: string
  hash: string
  message: string
}

export interface ChangelogPullRequest {
  taskId: string
  title: string
  url: string
}

export interface ChangelogResult {
  generatedAt: number
  sinceDays: number
  isGitRepo: boolean
  commits: ChangelogCommit[]
  pullRequests: ChangelogPullRequest[]
  markdown: string
}

export interface ChangelogTaskPort {
  /** Done tasks finished within the window: [{id,title,finishedAt,logs}] */
  listDoneTasks: (
    workspaceId: string,
    sinceMs: number
  ) => Array<{
    id: string
    title: string
    finishedAt: number | null
    logs: string[]
  }>
}

type GitRunner = (args: string[], cwd: string) => string

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Journal lines are timestamp-prefixed (`[iso] [PR] url`) — match anywhere. */
const extractPrUrls = (logs: string[]): string[] =>
  logs
    .map((line) => /\[PR\]\s*(https?:\/\/\S+)/i.exec(line)?.[1])
    .filter((url): url is string => Boolean(url))

export const buildChangelog = (input: {
  workspacePath: string
  workspaceId: string
  sinceDays: number
  tasks: ChangelogTaskPort
  now?: number | undefined
  gitRunner?: GitRunner | undefined
}): ChangelogResult => {
  const now = input.now ?? Date.now()
  const sinceMs = now - input.sinceDays * 24 * 60 * 60_000
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10)

  let isGitRepo = true
  let commits: ChangelogCommit[] = []
  try {
    const runner = input.gitRunner ?? defaultGitRunner
    const raw = runner(
      ['log', `--since=${sinceDate}`, '--pretty=%h%x09%ad%x09%s', '--date=short'],
      input.workspacePath
    )
    commits = raw
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts) => parts.length === 3 && parts[2])
      .map((parts) => ({
        hash: parts[0] ?? '',
        date: parts[1] ?? '',
        message: parts[2] ?? '',
      }))
  } catch {
    isGitRepo = false
  }

  const doneTasks = input.tasks.listDoneTasks(input.workspaceId, sinceMs)
  const pullRequests: ChangelogPullRequest[] = doneTasks.flatMap((task) => {
    const urls = extractPrUrls(task.logs)
    if (urls.length === 0) return []
    return urls.map((url) => ({ taskId: task.id, title: task.title, url }))
  })

  // Markdown assembly: PR-linked work first, then plain commits.
  const lines: string[] = [`# Changelog — last ${input.sinceDays} days`, '']
  if (pullRequests.length > 0) {
    lines.push('## Shipped via Pull Requests', '')
    for (const pr of pullRequests) {
      lines.push(`- [${pr.title}](${pr.url})`)
    }
    lines.push('')
  }
  if (commits.length > 0) {
    lines.push('## Commits', '')
    let currentDate = ''
    for (const commit of commits) {
      if (commit.date !== currentDate) {
        currentDate = commit.date
        lines.push('', `### ${currentDate}`, '')
      }
      lines.push(`- \`${commit.hash}\` ${commit.message}`)
    }
    lines.push('')
  }
  if (!isGitRepo) {
    lines.push('(workspace is not a git repository)', '')
  }

  return {
    generatedAt: now,
    sinceDays: input.sinceDays,
    isGitRepo,
    commits,
    pullRequests,
    markdown: lines.join('\n'),
  }
}

/** Convenience wrapper used by routes. */
export const changelogForWorkspace = (
  workspacePath: string,
  workspaceId: string,
  listDoneTasks: ChangelogTaskPort['listDoneTasks'],
  sinceDays: number,
  gitRunner?: GitRunner | undefined
): ChangelogResult => {
  return buildChangelog({
    workspacePath,
    workspaceId,
    sinceDays,
    tasks: { listDoneTasks },
    gitRunner,
  })
}
