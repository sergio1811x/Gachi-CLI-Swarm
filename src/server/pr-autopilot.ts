/**
 * T2 Review Autopilot: watch a workspace repo's open pull requests and hand
 * each new/updated one to a worker for review. Opt-in per workspace:
 *
 *   app-state `pr_autopilot_<wsId>`:
 *     '' | 'off'              → disabled
 *     'dry'                   → review as a `gh pr comment` (default first days)
 *     'live'                  → worker may run `gh pr review --approve|--request-changes`
 *   app-state `pr_autopilot_limit_<wsId>` → max review rounds per PR (default 3)
 *
 * Seen-state persists in `pr_autopilot_seen_<wsId>` as JSON:
 *   { [prNumber]: { sha, rounds } }
 */

export const AUTOPILOT_KEY_PREFIX = 'pr_autopilot_'
export const SEEN_KEY_PREFIX = 'pr_autopilot_seen_'

export type AutopilotMode = 'off' | 'dry' | 'live'

export interface AutopilotSeenEntry {
  rounds: number
  sha: string
}

export type AutopilotSeenMap = Record<string, AutopilotSeenEntry>

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

export const readAutopilotMode = (settings: AppStateReader, workspaceId: string): AutopilotMode => {
  const raw = settings.getAppState(`${AUTOPILOT_KEY_PREFIX}${workspaceId}`)?.value?.trim() ?? ''
  if (raw === 'live') return 'live'
  if (raw === 'dry') return 'dry'
  return 'off'
}

const DEFAULT_ROUNDS_LIMIT = 3

export const readRoundsLimit = (settings: AppStateReader, workspaceId: string): number => {
  const raw = Number(settings.getAppState(`${SEEN_KEY_PREFIX}limit_${workspaceId}`)?.value)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_ROUNDS_LIMIT
}

export const parseSeenMap = (raw: string | null | undefined): AutopilotSeenMap => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: AutopilotSeenMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof key === 'string' &&
        typeof value === 'object' &&
        value !== null &&
        typeof (value as AutopilotSeenEntry).sha === 'string' &&
        typeof (value as AutopilotSeenEntry).rounds === 'number'
      ) {
        out[key] = value as AutopilotSeenEntry
      }
    }
    return out
  } catch {
    return {}
  }
}

export const readSeenMap = (settings: AppStateReader, workspaceId: string): AutopilotSeenMap =>
  parseSeenMap(settings.getAppState(`${SEEN_KEY_PREFIX}${workspaceId}`)?.value)

export const writeSeenMap = (
  settings: { setAppState: (key: string, value: string) => void },
  workspaceId: string,
  seen: AutopilotSeenMap
): void => {
  settings.setAppState(`${SEEN_KEY_PREFIX}${workspaceId}`, JSON.stringify(seen))
}

export interface PrCandidate {
  head: string
  headSha: string | null
  number: number
  title: string
  url: string
}

/**
 * Which open PRs need a (re)view right now: unseen, head moved since last
 * review, or under the rounds limit after a previous pass.
 */
export const selectPrsToReview = (
  prs: PrCandidate[],
  seen: AutopilotSeenMap,
  roundsLimit: number
): Array<PrCandidate & { reReview: boolean }> => {
  const out: Array<PrCandidate & { reReview: boolean }> = []
  for (const pr of prs) {
    const entry = seen[String(pr.number)]
    const sha = pr.headSha ?? pr.head
    if (!entry) {
      out.push({ ...pr, reReview: false })
      continue
    }
    if (entry.sha === sha) continue // already reviewed this exact state
    if (entry.rounds >= roundsLimit) continue // ping-pong guard
    out.push({ ...pr, reReview: true })
  }
  return out
}

/** Anti-flood: an open card for this PR blocks duplicates. */
export const hasOpenAutopilotTask = (
  tasks: Array<{ description: string; status: string }>,
  workspaceId: string,
  prNumber: number
): boolean => {
  const marker = autopilotMarker(workspaceId, prNumber)
  return tasks.some(
    (task) =>
      ['backlog', 'ready', 'claimed', 'assigned', 'running'].includes(task.status) &&
      task.description.includes(marker)
  )
}

export const autopilotMarker = (workspaceId: string, prNumber: number): string =>
  `[pr-autopilot:${workspaceId.slice(0, 8)}#${prNumber}]`

/** The instruction card handed to a worker. */
export const buildPrReviewTaskInput = (input: {
  mode: Extract<AutopilotMode, 'dry' | 'live'>
  pr: { number: number; title: string; url: string }
  reReview: boolean
  workspaceId: string
}): { description: string; title: string } => {
  const marker = autopilotMarker(input.workspaceId, input.pr.number)
  const finalize =
    input.mode === 'live'
      ? [
          'Finish by posting the review yourself:',
          '`gh pr review <N> --approve --body "…"` or',
          '`gh pr review <N> --request-changes --body "…"`.',
        ]
      : [
          'DRY-RUN: do NOT approve or request changes. Post findings as a comment:',
          '`gh pr comment <N> --body "…"` (start the body with "review:").',
        ]
  const description = [
    marker,
    '',
    `Review open PR #${input.pr.number}: ${input.pr.title}`,
    input.pr.url,
    input.reReview ? 'This is a RE-REVIEW after new commits.' : '',
    '',
    'Steps:',
    `1. \`gh pr view ${input.pr.number}\` and \`gh pr diff ${input.pr.number}\``,
    '2. Assess correctness, tests, security, scope creep.',
    ...finalize.map((line) => line.replace(/<N>/g, String(input.pr.number))),
    '3. Report back via `team report` with the verdict summary.',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    description,
    title: `[PR REVIEW] #${input.pr.number} ${input.pr.title}`.slice(0, 90),
  }
}
