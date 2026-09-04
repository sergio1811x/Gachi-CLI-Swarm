import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Agent Discovery Layer §2–3: find installed AI CLIs and their versions.
 *
 * Detection is registry-driven (no `if (agent === 'claude')` hacks): targets
 * come from the same engine ids the control plane uses. Version probing is
 * time-boxed so a hung CLI can never stall startup or an API scan.
 */

const exec = promisify(execFile)

export const DISCOVERY_TARGET_IDS = ['claude', 'codex', 'opencode', 'agy'] as const
export type DiscoveryTargetId = (typeof DISCOVERY_TARGET_IDS)[number]

export interface InstalledAgent {
  name: DiscoveryTargetId
  installed: boolean
  path?: string
  version?: string
  error?: string
}

export interface CliDetectorDeps {
  platform?: NodeJS.Platform
  run?: (file: string, args: string[]) => Promise<{ stdout: string }>
  timeoutMs?: number
}

const VERSION_RE = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/

/** Pulls the first semver-ish token out of noisy `--version` output. */
export const parseVersionOutput = (stdout: string): string | undefined =>
  VERSION_RE.exec(stdout)?.[1]

const defaultRun = async (
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string }> => {
  try {
    // shell on Windows: npm-style CLIs are .cmd shims that execFile can't run
    // directly; with a shell they resolve and print their versions normally.
    return await exec(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
  } catch (error) {
    const err = error as { stdout?: string; message?: string }
    // `where` exits non-zero when not found but still writes diagnostics.
    if (typeof err.stdout === 'string' && err.stdout.trim()) return { stdout: err.stdout }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Locates the executable: `where` on Windows, `which` elsewhere. */
export const locateCli = async (
  name: string,
  deps: CliDetectorDeps = {}
): Promise<string | null> => {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? ((file, args) => defaultRun(file, args, deps.timeoutMs ?? 8_000))
  const tool = platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await run(tool, [name])
    const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    return firstLine?.trim() ?? null
  } catch {
    return null
  }
}

/** Reads `--version`; missing/hung CLIs degrade to `version: undefined`. */
export const readCliVersion = async (
  path: string,
  deps: CliDetectorDeps = {}
): Promise<string | undefined> => {
  const run = deps.run ?? ((file, args) => defaultRun(file, args, deps.timeoutMs ?? 8_000))
  try {
    const { stdout } = await run(path, ['--version'])
    return parseVersionOutput(stdout)
  } catch {
    return undefined
  }
}

export const detectInstalledAgent = async (
  name: DiscoveryTargetId,
  deps: CliDetectorDeps = {}
): Promise<InstalledAgent> => {
  const path = await locateCli(name, deps)
  if (!path) return { name, installed: false }
  const version = await readCliVersion(path, deps)
  return { name, installed: true, path, ...(version ? { version } : {}) }
}

export const detectInstalledAgents = async (
  deps: CliDetectorDeps = {}
): Promise<InstalledAgent[]> =>
  Promise.all(DISCOVERY_TARGET_IDS.map((name) => detectInstalledAgent(name, deps)))
