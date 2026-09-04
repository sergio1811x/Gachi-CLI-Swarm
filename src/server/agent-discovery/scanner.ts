import { type AgentAuthState, detectAgentAuth } from './auth-detector.js'
import {
  DISCOVERY_TARGET_IDS,
  type DiscoveryTargetId,
  detectInstalledAgents,
  type InstalledAgent,
} from './cli-detector.js'
import { getModelsForProvider } from './model-registry.js'

/**
 * Agent Discovery Layer §1/§10: one scan produces the full environment
 * picture; results are cached with a TTL so UI polling (30–60 s) never
 * re-runs the version probes.
 */

const CACHE_TTL_MS = 45_000

export interface DiscoveredAgent extends InstalledAgent {
  auth: AgentAuthState
  models: ReturnType<typeof getModelsForProvider>
}

export interface DiscoveryReport {
  agents: DiscoveredAgent[]
  scannedAt: number
}

export interface AgentDiscoveryScanner {
  /** Cached scan (TTL-bound); safe to call on every UI poll. */
  getReport: () => Promise<DiscoveryReport>
  /** Forces a fresh scan (rescan button / doctor). */
  rescan: () => Promise<DiscoveryReport>
}

export const createAgentDiscoveryScanner = (): AgentDiscoveryScanner => {
  let cache: DiscoveryReport | null = null
  let inFlight: Promise<DiscoveryReport> | null = null

  const runScan = async (): Promise<DiscoveryReport> => {
    const installed = await detectInstalledAgents()
    const agents: DiscoveredAgent[] = installed.map((agent) => ({
      ...agent,
      auth: agent.installed
        ? detectAgentAuth(agent.name)
        : { installed: false, authenticated: false },
      models: getModelsForProvider(agent.name),
    }))
    return { agents, scannedAt: Date.now() }
  }

  const scanWithCache = async (force: boolean): Promise<DiscoveryReport> => {
    if (!force && cache && Date.now() - cache.scannedAt < CACHE_TTL_MS) {
      return cache
    }
    inFlight ??= runScan()
      .then((report) => {
        cache = report
        return report
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    getReport: () => scanWithCache(false),
    rescan: () => scanWithCache(true),
  }
}

/** Process-wide scanner shared by the HTTP API and the doctor CLI. */
export const agentDiscoveryScanner = createAgentDiscoveryScanner()

export { DISCOVERY_TARGET_IDS, type DiscoveryTargetId }
