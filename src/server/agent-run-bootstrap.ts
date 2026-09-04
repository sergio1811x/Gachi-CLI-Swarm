import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import {
  buildAgentLegacyIdentityMarker,
  buildAgentSessionBindingMarker,
} from './agent-startup-instructions.js'
import { getBuiltinResumeAugmentation } from './command-preset-defaults.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { buildDockerRunLaunch, type SandboxSettings } from './docker-sandbox.js'
import { withPresetResumeArgs } from './preset-launch-support.js'

/**
 * Runtime-injected env vars (besides process.env) that must reach the
 * container when the sandbox is on — the PTY driver sets them per spawn.
 */
const INJECTED_SANDBOX_ENV_KEYS = ['GACH_PORT', 'GACH_PROJECT_ID', 'GACH_AGENT_ID']

import {
  captureSessionIdForCapture,
  getSessionCaptureEnvironment,
  type SessionCaptureSnapshot,
  snapshotSessionIdsForCapture,
} from './session-capture.js'
import { getClaudeProjectsRoot, newestClaudeSessionId } from './session-capture-claude.js'

const resolveGachiBinDirs = (): string[] => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = resolve(moduleDir, '../..')
  return [
    resolve(packageRoot, 'bin'),
    resolve(packageRoot, 'dist/bin'),
    resolve(packageRoot, 'dist/src/bin'),
  ]
}

const GACHI_BIN_DIRS = resolveGachiBinDirs()
// Production evidence: a cold Claude TUI can sit in "connecting…" for many
// minutes before its first session file lands (observed ~6 min on a
// 16 MB-transcript workspace). 30s silently gave up on every such start,
// which is how resume died install-wide (S-1). 10 minutes covers it.
const SESSION_CAPTURE_TIMEOUT_MS = 600_000

type LaunchPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const resolveLaunchPreset = (
  config: AgentLaunchConfigInput,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
): LaunchPreset | undefined => {
  if (config.presetAugmentationDisabled) return undefined
  if (config.commandPresetId) return getCommandPreset(config.commandPresetId)

  const implicitPreset = getCommandPreset(config.command)
  if (!implicitPreset || implicitPreset.command !== config.command) return undefined

  return {
    resumeArgsTemplate: null,
    sessionIdCapture: null,
    yoloArgsTemplate: implicitPreset.yoloArgsTemplate,
  }
}

const enrichOrchestratorConfig = (config: AgentLaunchConfigInput): AgentLaunchConfigInput => {
  const augmentation = getBuiltinResumeAugmentation(config.command)
  if (!augmentation) return config
  return {
    ...config,
    sessionIdCapture: config.sessionIdCapture ?? augmentation.sessionIdCapture,
    resumeArgsTemplate: config.resumeArgsTemplate ?? augmentation.resumeArgsTemplate,
  }
}

const createSessionCaptureDiscriminator = (
  workspace: WorkspaceSummary,
  agent: AgentSummary | undefined
) => {
  if (!agent) return undefined
  return {
    contentIncludes: [
      buildAgentSessionBindingMarker({ agent, workspace }),
      buildAgentLegacyIdentityMarker({ agent, workspace }),
    ],
  }
}

export const buildAgentRunBootstrap = (
  workspace: WorkspaceSummary,
  agentId: string,
  config: AgentLaunchConfigInput,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  agent?: AgentSummary,
  /** The directory the CLI actually runs in (worktree or workspace root). */
  workingDirectory?: string,
  /** R5→R10: opt-in Docker sandbox resolved from workspace app-state. */
  sandbox?: SandboxSettings
) => {
  // The orchestrator deliberately avoids binding a command preset (which would
  // force yolo args and preset-specific behavior). Apply session-resume fields
  // at launch time so it can still reopen its previous session on restart.
  const effectiveConfig = agent?.role === 'orchestrator' ? enrichOrchestratorConfig(config) : config
  const preset = resolveLaunchPreset(effectiveConfig, getCommandPreset)
  const discriminator = createSessionCaptureDiscriminator(workspace, agent)

  // Legacy bridge: pre-fix installs have an empty agent_sessions table. For
  // claude engines, fall back to the NEWEST session file in the project dir
  // (≤7 days) so the very first restart after this fix already resumes.
  // Single-CLI-per-cwd workspaces make the ownership risk negligible; going
  // forward capture persists real ids and this path stops firing.
  let lastSessionId = sessionStore.getLastSessionId(workspace.id, agentId)
  const wantsClaudeLegacyFallback =
    !lastSessionId &&
    (effectiveConfig.sessionIdCapture?.source ?? preset?.sessionIdCapture?.source) ===
      'claude_project_jsonl_dir'
  if (wantsClaudeLegacyFallback) {
    const legacyId = newestClaudeSessionId(
      workingDirectory ?? workspace.path,
      getClaudeProjectsRoot(
        effectiveConfig.sessionIdCapture && 'pattern' in effectiveConfig.sessionIdCapture
          ? effectiveConfig.sessionIdCapture.pattern
          : undefined
      )
    )
    if (legacyId) {
      console.log(
        `[SESSIONS] no captured id for @${agentId} — legacy fallback resume ${legacyId.slice(0, 8)}`
      )
      lastSessionId = legacyId
    }
  }

  const startConfig = withPresetResumeArgs(
    effectiveConfig,
    preset,
    lastSessionId,
    workingDirectory ?? workspace.path,
    discriminator,
    () => sessionStore.clearLastSessionId(workspace.id, agentId)
  )
  // Capture matches ANY new session file for this cwd — the capture
  // coordinator already guarantees each concurrent agent claims a distinct id,
  // and requiring the injected ownership marker here made capture hostage to
  // TUI paste timing (instructions swallowed by a startup screen ⇒ no marker
  // in the JSONL ⇒ capture times out ⇒ every restart opened a NEW session).
  // The discriminator stays in force for RESUME ownership verification.
  // Resumed starts snapshot too: `--resume` makes claude (and codex) fork a
  // NEW session id, and if that fork is not captured the stored id goes stale
  // and every following restart falls back to legacy heuristics.
  const sessionCaptureSnapshot = snapshotSessionIdsForCapture(
    workingDirectory ?? workspace.path,
    startConfig.sessionIdCapture
  )
  const rawPath = Object.entries(process.env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  const pathParts = rawPath.split(delimiter).filter(Boolean)
  const combinedParts = [...GACHI_BIN_DIRS]
  for (const part of pathParts) {
    if (!combinedParts.includes(part)) combinedParts.push(part)
  }
  const normalizedPath = combinedParts.join(delimiter)

  // R5→R10 Docker sandbox (opt-in per workspace): wrap the resolved CLI into
  // `docker run` AFTER resume augmentation so session flags travel inside the
  // container command. persistedConfig stays unwrapped — restarts re-wrap.
  let launch = startConfig
  if (sandbox?.mode === 'docker' && agent?.role !== 'orchestrator') {
    const wrapped = buildDockerRunLaunch({
      args: startConfig.args ?? [],
      command: startConfig.command,
      envKeys: [...Object.keys(process.env), ...INJECTED_SANDBOX_ENV_KEYS],
      image: sandbox.image,
      workspacePath: workingDirectory ?? workspace.path,
    })
    launch = { ...startConfig, args: wrapped.args, command: wrapped.command }
    console.log(
      `[SANDBOX] @${agentId} → docker (${sandbox.image ?? 'default image'}), mount ${workingDirectory ?? workspace.path}`
    )
  }

  return {
    // The pre-resume launch config: command + args exactly as the user provided
    // (plus resume augmentation fields). This is what "last startup command"
    // means — persisted on launch and reused so the next restart comes up the
    // same way. Builtin engines keep their template (not a baked stale id) so
    // the latest session id is re-resolved fresh on the next launch.
    persistedConfig: effectiveConfig,
    sessionCaptureSnapshot,
    startConfig: launch,
    startEnv: {
      ...process.env,
      ...getSessionCaptureEnvironment(sessionCaptureSnapshot),
      GACH_PORT: '',
      GACH_PROJECT_ID: workspace.id,
      GACH_AGENT_ID: agentId,
      GACH_AGENT_TOKEN: '',
      PATH: normalizedPath,
      Path: normalizedPath,
    },
  }
}

export const startAgentRunCapture = ({
  agentId,
  sessionCaptureSnapshot,
  sessionStore,
  startConfig,
  workspace,
  workingDirectory,
}: {
  agentId: string
  sessionCaptureSnapshot: SessionCaptureSnapshot | undefined
  sessionStore: AgentSessionStorePort
  startConfig: AgentLaunchConfigInput
  workspace: WorkspaceSummary
  workingDirectory?: string
}) => {
  if (!sessionCaptureSnapshot || !startConfig.sessionIdCapture) return
  const captureConfig = startConfig.sessionIdCapture
  const captureStartedAt = Date.now()
  void captureSessionIdForCapture(
    workingDirectory ?? workspace.path,
    captureConfig,
    sessionCaptureSnapshot,
    (sessionId) => {
      sessionStore.setLastSessionId(workspace.id, agentId, sessionId)
      console.log(
        `[SESSIONS] captured ${captureConfig.source} session ${sessionId.slice(0, 8)} for @${agentId}`
      )
    },
    SESSION_CAPTURE_TIMEOUT_MS,
    1_000
  ).finally(() => {
    // Capture failures used to be completely silent — an entire install could
    // run for weeks with resume quietly disabled (empty agent_sessions table).
    if (!sessionStore.getLastSessionId(workspace.id, agentId)) {
      console.warn(
        `[SESSIONS] no ${captureConfig.source} session id captured for @${agentId} ` +
          `within ${Math.round((Date.now() - captureStartedAt) / 1000)}s — this run will not be resumable`
      )
    }
  })
}
