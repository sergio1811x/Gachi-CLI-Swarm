/**
 * R5→R10 Docker sandbox (opt-in per workspace): run worker CLIs inside a
 * container so their commands execute against a mounted workspace instead of
 * hitting the host user directly. Configured via app-state
 * `worker_sandbox_<wsId>` = 'docker' (+ optional `worker_sandbox_image_<wsId>`).
 */

export const SANDBOX_MODE_KEY_PREFIX = 'worker_sandbox_'
export const SANDBOX_IMAGE_KEY_PREFIX = 'worker_sandbox_image_'

export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim'
/** Where the host workspace is mounted inside the container. */
export const SANDBOX_WORKSPACE_MOUNT = '/workspace'

export type SandboxMode = 'off' | 'docker'

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

export interface SandboxSettings {
  mode: SandboxMode
  image: string | null
}

export const readSandboxSettings = (
  settings: AppStateReader,
  workspaceId: string,
  /** Orchestrator never runs sandboxed — it drives the runtime itself. */
  isOrchestrator: boolean
): SandboxSettings => {
  if (isOrchestrator) return { image: null, mode: 'off' }
  const raw = settings.getAppState(`${SANDBOX_MODE_KEY_PREFIX}${workspaceId}`)?.value?.trim() ?? ''
  if (raw !== 'docker') return { image: null, mode: 'off' }
  const image =
    settings.getAppState(`${SANDBOX_IMAGE_KEY_PREFIX}${workspaceId}`)?.value?.trim() ||
    DEFAULT_SANDBOX_IMAGE
  return { image, mode: 'docker' }
}

/**
 * Env vars forwarded into the container: brand/runtime wiring plus the
 * provider credentials engines authenticate with. Everything else stays on
 * the host — that is the point of the sandbox.
 */
const ENV_ALLOWLIST = [
  /^GACH_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GEMINI_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^OPENROUTER_API_KEY$/i,
  /^(HTTPS?_PROXY|NO_PROXY)$/i,
]

export const pickSandboxEnvKeys = (keys: Iterable<string>): string[] =>
  [...new Set(keys)].filter((key) => ENV_ALLOWLIST.some((re) => re.test(key)))

export interface WrappedLaunch {
  command: string
  args: string[]
}

/**
 * Composes `docker run …` around the resolved CLI command. Pure — the caller
 * supplies env key names; values are read by the docker CLI from the host
 * environment at spawn time via `-e KEY`.
 */
export const buildDockerRunLaunch = (input: {
  command: string
  args: string[]
  workspacePath: string
  image?: string | null
  envKeys: Iterable<string>
}): WrappedLaunch => {
  const image = input.image?.trim() || DEFAULT_SANDBOX_IMAGE
  // The image is operator config pushed before the `--` separator; a value
  // like `--privileged` would otherwise be parsed as a docker flag (container
  // escape), so only real image references pass.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/.test(image)) {
    throw new Error(`Invalid sandbox image reference: ${image}`)
  }
  const args: string[] = ['run', '--rm', '-i', '--init']
  args.push('-v', `${input.workspacePath}:${SANDBOX_WORKSPACE_MOUNT}`)
  args.push('-w', SANDBOX_WORKSPACE_MOUNT)
  for (const key of pickSandboxEnvKeys(input.envKeys)) {
    args.push('-e', key)
  }
  args.push(image)
  // `--` keeps the original command/args intact even when they start with `-`.
  args.push('--', input.command, ...input.args)
  return { args, command: 'docker' }
}
