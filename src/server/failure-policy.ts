/**
 * Failure policies (ROADMAP R3): map a classified failure to the delay before
 * the task may be retried. `null` means retry immediately (the historical
 * behavior for plain crashes). Categories that cannot self-heal by waiting
 * get long backoffs so the swarm stops burning attempts against a wall.
 */

export const FAILURE_RETRY_POLICIES: Record<string, number | null> = {
  'rate-limit': 5 * 60_000,
  quota: 30 * 60_000,
  auth: 15 * 60_000,
  network: 60_000,
  oom: 10 * 60_000,
  disk: 10 * 60_000,
  'cli-missing': 30 * 60_000,
}

export const retryBackoffMs = (category: string | null | undefined): number | null => {
  if (!category) return null
  const policy = FAILURE_RETRY_POLICIES[category]
  return policy === undefined ? null : policy
}

export const describeBackoff = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`
