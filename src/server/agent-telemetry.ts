/**
 * Best-effort usage telemetry scraped from worker PTY output (control-plane
 * spec Part 2 §6/§7).
 *
 * Coding CLIs surface context pressure and token totals as terminal text, not
 * through a machine API, so parsing is intentionally conservative: unknown
 * formats leave the field untouched rather than guessing. Values are
 * "latest wins" snapshots — terminal repaints of stale numbers are harmless.
 *
 * The module is pure text-in/state-out; writing `/compact` when the policy
 * fires is the wiring layer's job (`onAutoCompact` callback).
 */

export interface AgentUsageSnapshot {
  contextPercent: number | null
  tokensUsed: number | null
  updatedAt: number
}

export interface AutoCompactInfo {
  contextPercent: number | null
  tokensUsed: number | null
  trigger: 'context' | 'tokens'
}

export interface AgentTelemetryOptions {
  /** Minimum delay between two automatic compaction triggers per agent. */
  autoCompactCooldownMs?: number
  /** Context percentage at which automatic compaction fires. */
  autoCompactThresholdPercent?: number
  /**
   * Per-decision threshold override (workspace policy). When provided it is
   * re-evaluated on every scrape so app-state changes apply without a
   * restart. Returning `null` (or a non-positive number) turns the percent
   * trigger off; the token-budget trigger stays independent.
   */
  getThresholdPercent?: () => number | null
  /**
   * Absolute token budget (ROADMAP R2-adjacent policy): when scraped
   * `tokensUsed` reaches this number the compaction fires too — engines that
   * never print a context-left percentage are covered by this path.
   * `null`/undefined disables the token trigger.
   */
  autoCompactTokens?: number | null
  /**
   * Quiet window: while true for an agent, policy triggers (compact + usage
   * warning) are skipped WITHOUT arming the cooldown. Used to ignore stale
   * scraped percentages from a previous session right after a fresh run
   * starts.
   */
  isInQuietWindow?: (workspaceId: string, agentId: string) => boolean
  /** Called when the policy decides this agent should compact now. */
  onAutoCompact?: (workspaceId: string, agentId: string, info: AutoCompactInfo) => void
  /**
   * Called when scraped usage first crosses the warning threshold so external
   * channels (Telegram) can alert the owner. Independent of the compact
   * cooldown and much slower — this is a "heads up", not a control action.
   */
  onUsageWarning?: (workspaceId: string, agentId: string, contextPercent: number) => void
  /** Minimum delay between two usage warnings per agent. */
  usageWarningCooldownMs?: number
}

export interface AgentTelemetry {
  dispose: () => void
  observe: (workspaceId: string, agentId: string, chunk: string) => void
  removeAgent: (workspaceId: string, agentId: string) => void
  removeWorkspace: (workspaceId: string) => void
  snapshot: (workspaceId: string, agentId: string) => AgentUsageSnapshot | undefined
  snapshotsForWorkspace: (workspaceId: string) => Array<AgentUsageSnapshot & { agentId: string }>
}

const CONTEXT_LEFT_PERCENT_RES = [
  // Claude Code: "Context left until auto-compact: 34%"
  /\bcontext\s+left(?:\s+until\s+auto-compact)?\s*[:：]?\s*~?(\d{1,3})\s*%/i,
  // Codex-style footers: "79% context left" (optionally wrapped in brackets)
  /(\d{1,3})%\s*[)\]]?\s*context\s+left/i,
]

const TOKENS_TOTAL_RES = [
  /\btotal\s+tokens?\b[^0-9]{0,16}([\d][\d,]*)/i,
  /\btokens?\s+used\b[^0-9]{0,16}([\d][\d,]*)/i,
]

/**
 * Engines emit color codes glued directly to status text (`\x1b[32mcontext…`);
 * the escape's trailing letter defeats `\b` matching. Strip CSI sequences
 * before applying scrape patterns.
 */
const CSI_SEQUENCE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

const parseContextPercent = (rawLine: string): number | null => {
  const line = rawLine.replace(CSI_SEQUENCE_RE, '')
  for (const regex of CONTEXT_LEFT_PERCENT_RES) {
    const match = regex.exec(line)
    const raw = match?.[1]
    if (raw === undefined) continue
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value
    return null
  }
  return null
}

const parseTokensTotal = (rawLine: string): number | null => {
  const line = rawLine.replace(CSI_SEQUENCE_RE, '')
  for (const regex of TOKENS_TOTAL_RES) {
    const match = regex.exec(line)
    const raw = match?.[1]
    if (raw === undefined) continue
    const value = Number(raw.replace(/,/g, ''))
    if (Number.isFinite(value) && value >= 0) return value
    return null
  }
  return null
}

const key = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

interface TelemetryState extends AgentUsageSnapshot {
  pendingLine: string
  lastAutoCompactAt: number
  lastUsageWarningAt: number
  /** True once the warning threshold has been crossed and not yet cleared. */
  warningActive: boolean
}

export const createAgentTelemetry = (options: AgentTelemetryOptions = {}): AgentTelemetry => {
  const cooldownMs = options.autoCompactCooldownMs ?? 30 * 60_000
  const thresholdPercent = options.autoCompactThresholdPercent ?? 85
  const tokenBudget = options.autoCompactTokens ?? null
  const warningCooldownMs = options.usageWarningCooldownMs ?? 30 * 60_000
  const states = new Map<string, TelemetryState>()

  const processLine = (stateKey: string, workspaceId: string, agentId: string, line: string) => {
    const state = states.get(stateKey)
    if (!state) return

    let changed = false
    const contextPercent = parseContextPercent(line)
    if (contextPercent !== null && contextPercent !== state.contextPercent) {
      state.contextPercent = contextPercent
      changed = true
    }
    const tokensUsed = parseTokensTotal(line)
    if (tokensUsed !== null && tokensUsed !== state.tokensUsed) {
      state.tokensUsed = tokensUsed
      changed = true
    }
    if (changed) state.updatedAt = Date.now()

    // Quiet window (fresh run, stale scrape): skip every policy action without
    // arming the cooldown so the first honest crossing still fires later.
    if (options.isInQuietWindow?.(workspaceId, agentId)) return

    const resolveThreshold = (): number | null => {
      if (options.getThresholdPercent) {
        const override = options.getThresholdPercent()
        if (override === null || !Number.isFinite(override) || override <= 0) return null
        return override
      }
      return thresholdPercent
    }

    let compactedThisTick = false

    // Token-budget trigger (absolute): covers engines that never print a
    // context-left percentage. Shares the cooldown with the percent path.
    if (
      tokenBudget !== null &&
      state.tokensUsed !== null &&
      state.tokensUsed >= tokenBudget &&
      Date.now() - state.lastAutoCompactAt >= cooldownMs
    ) {
      state.lastAutoCompactAt = Date.now()
      compactedThisTick = true
      options.onAutoCompact?.(workspaceId, agentId, {
        contextPercent: state.contextPercent,
        tokensUsed: state.tokensUsed,
        trigger: 'tokens',
      })
    }

    const activeThresholdPercent = resolveThreshold()

    // Percent trigger (engines reporting context-left).
    if (
      !compactedThisTick &&
      activeThresholdPercent !== null &&
      state.contextPercent !== null &&
      state.contextPercent >= activeThresholdPercent &&
      Date.now() - state.lastAutoCompactAt >= cooldownMs
    ) {
      state.lastAutoCompactAt = Date.now()
      compactedThisTick = true
      options.onAutoCompact?.(workspaceId, agentId, {
        contextPercent: state.contextPercent,
        tokensUsed: state.tokensUsed,
        trigger: 'context',
      })
    }

    // Usage warning fires on the crossing edge (not every scrape above the
    // threshold) with a long per-agent cooldown so Telegram stays quiet.
    if (
      options.onUsageWarning &&
      activeThresholdPercent !== null &&
      state.contextPercent !== null &&
      state.contextPercent >= activeThresholdPercent &&
      (!state.warningActive || Date.now() - state.lastUsageWarningAt >= warningCooldownMs)
    ) {
      state.warningActive = true
      state.lastUsageWarningAt = Date.now()
      options.onUsageWarning(workspaceId, agentId, state.contextPercent)
    } else if (
      activeThresholdPercent !== null &&
      state.contextPercent !== null &&
      state.contextPercent < activeThresholdPercent * 0.8 &&
      state.warningActive
    ) {
      // Hysteresis: only re-arm below 80% of the threshold so flapping around
      // the boundary does not produce repeated warnings.
      state.warningActive = false
    }
  }

  return {
    dispose() {
      states.clear()
    },
    observe(workspaceId, agentId, chunk) {
      const stateKey = key(workspaceId, agentId)
      const existing = states.get(stateKey)
      const state: TelemetryState =
        existing ??
        ({
          contextPercent: null,
          lastAutoCompactAt: 0,
          lastUsageWarningAt: 0,
          pendingLine: '',
          tokensUsed: null,
          updatedAt: Date.now(),
          warningActive: false,
        } satisfies TelemetryState)
      if (!existing) states.set(stateKey, state)

      state.pendingLine += chunk
      const lines = state.pendingLine.split(/\r?\n/)
      // The trailing fragment may be an incomplete line — hold it for the
      // next chunk instead of parsing a truncated number.
      state.pendingLine = lines.pop() ?? ''
      for (const line of lines) {
        processLine(stateKey, workspaceId, agentId, line)
      }
    },
    removeAgent(workspaceId, agentId) {
      states.delete(key(workspaceId, agentId))
    },
    removeWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`
      for (const stateKey of [...states.keys()]) {
        if (stateKey.startsWith(prefix)) states.delete(stateKey)
      }
    },
    snapshot(workspaceId, agentId) {
      const state = states.get(key(workspaceId, agentId))
      if (!state) return undefined
      return {
        contextPercent: state.contextPercent,
        tokensUsed: state.tokensUsed,
        updatedAt: state.updatedAt,
      }
    },
    snapshotsForWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`
      const result: Array<AgentUsageSnapshot & { agentId: string }> = []
      for (const [stateKey, state] of states) {
        if (!stateKey.startsWith(prefix)) continue
        result.push({
          agentId: stateKey.slice(prefix.length),
          contextPercent: state.contextPercent,
          tokensUsed: state.tokensUsed,
          updatedAt: state.updatedAt,
        })
      }
      return result
    },
  }
}
