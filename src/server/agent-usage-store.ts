import type { Database } from 'better-sqlite3'

/**
 * Durable usage timeline (ROADMAP R1): the telemetry scraper is latest-wins
 * in memory, so restarts would erase the story. This store persists throttled
 * samples and serves the aggregates behind /metrics.
 */

const SAMPLE_THROTTLE_MS = 60_000
/** Bounded retention: ~2 samples/hour/agent for a month fits any laptop. */
const RETENTION_MS = 30 * 24 * 60 * 60_000

export interface UsageSampleRow {
  agentId: string
  contextPercent: number | null
  tokensUsed: number | null
  sampledAt: number
}

export interface AgentUsageTotals {
  agentId: string
  lastTokensUsed: number | null
  peakContextPercent: number | null
}

export interface WorkspaceMetrics {
  /** Monotone per-agent max tokens within the window (scraped totals). */
  agents: AgentUsageTotals[]
  samples: Array<UsageSampleRow & { tokensDelta: number | null }>
}

export interface AgentUsageStore {
  /** Records a sample unless the previous one is younger than the throttle. */
  recordSample: (input: {
    workspaceId: string
    agentId: string
    contextPercent: number | null
    tokensUsed: number | null
    at?: number
  }) => boolean
  listSamples: (workspaceId: string, sinceMs: number) => UsageSampleRow[]
  workspaceMetrics: (workspaceId: string, windowMs: number) => WorkspaceMetrics
  pruneOlderThan: (atMs: number) => void
}

export const createAgentUsageStore = (db: Database): AgentUsageStore => {
  const insertStmt = db.prepare(`
    INSERT INTO agent_usage_samples (workspace_id, agent_id, context_percent, tokens_used, sampled_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const lastSampleAtStmt = db.prepare(`
    SELECT MAX(sampled_at) AS at FROM agent_usage_samples
    WHERE workspace_id = ? AND agent_id = ?
  `)

  return {
    recordSample({ workspaceId, agentId, contextPercent, tokensUsed, at }) {
      const now = at ?? Date.now()
      const row = lastSampleAtStmt.get(workspaceId, agentId) as { at: number | null }
      if (row?.at !== null && row?.at !== undefined && now - row.at < SAMPLE_THROTTLE_MS) {
        return false
      }
      insertStmt.run(workspaceId, agentId, contextPercent, tokensUsed, now)
      return true
    },

    listSamples(workspaceId, sinceMs) {
      const rows = db
        .prepare(
          `SELECT agent_id AS agentId, context_percent AS contextPercent,
                  tokens_used AS tokensUsed, sampled_at AS sampledAt
           FROM agent_usage_samples
           WHERE workspace_id = ? AND sampled_at >= ?
           ORDER BY sampled_at ASC`
        )
        .all(workspaceId, sinceMs) as UsageSampleRow[]
      return rows
    },

    workspaceMetrics(workspaceId, windowMs) {
      const since = Date.now() - windowMs
      const samples = this.listSamples(workspaceId, since)

      // Scraped token counters are cumulative per run; deltas between samples
      // approximate consumption inside the window.
      const byAgent = new Map<string, { last: number | null; peak: number | null }>()
      const withDeltas = samples.map((sample) => {
        const entry = byAgent.get(sample.agentId) ?? { last: null, peak: null }
        let delta: number | null = null
        if (sample.tokensUsed !== null) {
          delta = entry.last === null ? null : Math.max(0, sample.tokensUsed - entry.last)
          entry.last = sample.tokensUsed
        }
        if (
          sample.contextPercent !== null &&
          (entry.peak === null || sample.contextPercent > entry.peak)
        ) {
          entry.peak = sample.contextPercent
        }
        byAgent.set(sample.agentId, entry)
        return { ...sample, tokensDelta: delta }
      })

      const agents: AgentUsageTotals[] = [...byAgent.entries()].map(([agentId, e]) => ({
        agentId,
        lastTokensUsed: e.last,
        peakContextPercent: e.peak,
      }))

      return { agents, samples: withDeltas }
    },

    pruneOlderThan(atMs) {
      db.prepare('DELETE FROM agent_usage_samples WHERE sampled_at < ?').run(atMs)
      void RETENTION_MS
    },
  }
}
