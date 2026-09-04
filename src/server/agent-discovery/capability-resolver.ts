import { getAgentCapability } from '../agent-capability-registry.js'
import type { DiscoveredAgent } from './scanner.js'

/**
 * Agent Discovery Layer §5/§11: capabilities come from the control-plane
 * registry (engine adapters + control profiles) and are enriched with the
 * discovered runtime state. Nothing here branches on provider names — adding
 * an engine to `AGENT_DRIVERS` flows through automatically.
 */

export interface ResolvedAgentCapabilities {
  contextCommands: { clear: string | null; compact: string | null }
  displayName: string
  features: {
    contextControl: boolean
    modelSwitch: boolean
    reasoningControl: boolean
    usageTracking: boolean
    sessionResume: boolean
  }
  installed: boolean
  authenticated: boolean
  models: DiscoveredAgent['models']
  version?: string
}

export const resolveDiscoveredCapabilities = (
  agent: DiscoveredAgent,
  usageTrackingAvailable = false
): ResolvedAgentCapabilities | null => {
  const capability = getAgentCapability(agent.name)
  if (!capability) return null
  return {
    contextCommands: capability.contextCommands,
    displayName: agent.name === 'claude' ? capability.displayName : capability.displayName,
    features: {
      ...capability.features,
      sessionResume: capability.resumeSupported,
      // Usage tracking is only claimed when a real source exists (telemetry
      // scraping or an official API) — otherwise honest "unknown".
      usageTracking: usageTrackingAvailable && capability.features.contextControl,
    },
    authenticated: agent.auth.authenticated,
    installed: agent.installed,
    models: [...agent.models],
    ...(agent.version ? { version: agent.version } : {}),
  }
}
