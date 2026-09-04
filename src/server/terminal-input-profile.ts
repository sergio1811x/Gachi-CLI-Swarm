import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getAgentDriver, getAgentDriverById } from './cli-driver.js'

export type TerminalInputProfile = 'default' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  terminal_input_profile: TerminalInputProfile
}

export const resolveTerminalInputProfile = (
  config: AgentLaunchConfigInput | undefined
): TerminalInputProfile => {
  if (!config) return 'default'
  const presetDriver = getAgentDriverById(config.commandPresetId)
  if (presetDriver) return presetDriver.terminalInputProfile
  return getAgentDriver(config.interactiveCommand ?? config.command).terminalInputProfile
}
