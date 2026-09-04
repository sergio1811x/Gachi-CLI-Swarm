import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { getBuiltinResumeAugmentation } from './command-preset-defaults.js'
import { readEnv } from './env.js'
import type { SettingsStore } from './settings-store.js'
import { getOrchestratorId } from './workspace-store-support.js'

interface ConfigurePort {
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
}

const parseArgsEnv = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
  } catch {
    return trimmed.split(/\s+/)
  }
  return undefined
}

/**
 * Wire session resume for the orchestrator from the builtin preset matching the
 * resolved command. This is what lets the previous session reopen on restart:
 * - `sessionIdCapture` snapshots the CLI's session store and persists the id.
 * - `resumeArgsTemplate` turns the persisted id into `--resume {session_id}`.
 *
 * Capture is keyed by the agent's identity marker (see buildAgentRunBootstrap's
 * discriminator), so the orchestrator only claims its own session, never a
 * worker's. Commands that don't match a builtin preset (custom binaries, test
 * stubs like `bash -c '...'`) are left untouched.
 */
const enrichWithBuiltinResume = (
  config: AgentLaunchConfigInput | undefined
): AgentLaunchConfigInput | undefined => {
  if (!config) return undefined
  const augmentation = getBuiltinResumeAugmentation(config.command)
  if (!augmentation) return config
  return {
    ...config,
    sessionIdCapture: config.sessionIdCapture ?? augmentation.sessionIdCapture,
    resumeArgsTemplate: config.resumeArgsTemplate ?? augmentation.resumeArgsTemplate,
  }
}

/**
 * Resolve the orchestrator's launch config in priority order:
 * 1. Explicit startup command pasted by the user. It runs through their shell
 *    so aliases/functions like `ccs --resume ...` can expand.
 * 2. Explicit workspace-create command preset chosen by the user.
 * 3. `GACH_ORCHESTRATOR_COMMAND` env var (with optional `GACH_ORCHESTRATOR_ARGS_JSON`).
 *    Tests use this to inject a dummy CLI like `bash -c 'echo queen up; sleep 60'`
 *    so autostart can run end-to-end without depending on a real `claude` binary.
 * 4. The seeded `orchestrator` role template (defaults to `claude`).
 * Returns `undefined` when neither source has a usable command.
 */
export const resolveOrchestratorLaunchConfig = (
  settings: SettingsStore,
  commandPresetId: string | null = null,
  startupCommand: string | null = null
): AgentLaunchConfigInput | undefined => {
  const trimmedStartupCommand = startupCommand?.trim()
  if (trimmedStartupCommand) {
    return enrichWithBuiltinResume(
      resolveStartupCommandLaunchConfig(settings, trimmedStartupCommand, commandPresetId)
    )
  }
  if (commandPresetId) {
    return enrichWithBuiltinResume(resolveCommandPresetLaunchConfig(settings, commandPresetId))
  }
  const envCommand = readEnv('ORCHESTRATOR_COMMAND')
  if (envCommand) {
    return enrichWithBuiltinResume({
      command: envCommand,
      args: parseArgsEnv(readEnv('ORCHESTRATOR_ARGS_JSON')) ?? [],
      commandPresetId: null,
    })
  }
  const template = settings.listRoleTemplates().find((entry) => entry.roleType === 'orchestrator')
  if (!template) return undefined
  // resume + session-id capture are wired via enrichWithBuiltinResume below;
  // commandPresetId stays null so yolo args are not forced by a preset bind.
  return enrichWithBuiltinResume({
    command: template.defaultCommand,
    args: template.defaultArgs,
    commandPresetId: null,
  })
}

/**
 * Idempotent: only seeds when no existing launch config is present for the
 * orchestrator (prevents stomping on user-customized configs across restarts).
 */
export const seedOrchestratorLaunchConfig = (
  port: ConfigurePort,
  settings: SettingsStore,
  workspaceId: string,
  commandPresetId: string | null = null,
  startupCommand: string | null = null
): void => {
  const orchestratorId = getOrchestratorId(workspaceId)
  if (port.peekAgentLaunchConfig(workspaceId, orchestratorId)) return
  const config = resolveOrchestratorLaunchConfig(settings, commandPresetId, startupCommand)
  if (!config) return
  port.configureAgentLaunch(workspaceId, orchestratorId, config)
}
