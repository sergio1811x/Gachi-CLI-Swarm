import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DiscoveryTargetId } from './cli-detector.js'

/**
 * Agent Discovery Layer §4: "installed" and "ready to work" are different
 * states. Auth detection is deliberately passive — it only checks for the
 * presence of credential artifacts (never prints their values), so a scan is
 * safe to run on any schedule.
 */

export interface AgentAuthState {
  installed: boolean
  authenticated: boolean
  method?: 'api-key' | 'oauth'
  error?: string
}

export interface AuthDetectorDeps {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  readJson?: (path: string) => Record<string, unknown> | null
}

const firstExisting = (candidates: string[], exists: (p: string) => boolean): string | null =>
  candidates.find((candidate) => exists(candidate)) ?? null

const hasMeaningfulContent = (
  path: string,
  readJson: (p: string) => Record<string, unknown> | null
) => {
  const parsed = readJson(path)
  if (!parsed) return true // non-JSON credential stores still count as present
  return Object.keys(parsed).length > 0
}

type PerCliAuth = (
  deps: Required<Pick<AuthDetectorDeps, 'exists' | 'readJson' | 'homeDir'>> & {
    env: NodeJS.ProcessEnv
  }
) => AgentAuthState

const detectClaudeAuth: PerCliAuth = ({ exists, readJson, homeDir, env }) => {
  if (env.ANTHROPIC_API_KEY) return { installed: true, authenticated: true, method: 'api-key' }
  const credentials = firstExisting(
    [join(homeDir, '.claude', '.credentials.json'), join(homeDir, '.claude', 'credentials.json')],
    exists
  )
  if (credentials && hasMeaningfulContent(credentials, readJson)) {
    return { installed: true, authenticated: true, method: 'oauth' }
  }
  const config = join(homeDir, '.claude.json')
  if (exists(config)) {
    const parsed = readJson(config)
    const hasAccount = Boolean(parsed?.oauthAccount) || Boolean(parsed?.primaryApiKey)
    if (hasAccount) return { installed: true, authenticated: true, method: 'oauth' }
  }
  return { installed: true, authenticated: false }
}

const detectCodexAuth: PerCliAuth = ({ exists, readJson, homeDir }) => {
  const auth = join(homeDir, '.codex', 'auth.json')
  if (exists(auth) && hasMeaningfulContent(auth, readJson)) {
    return { installed: true, authenticated: true, method: 'oauth' }
  }
  return { installed: true, authenticated: false }
}

const detectOpenCodeAuth: PerCliAuth = ({ exists, readJson, homeDir }) => {
  const auth = firstExisting(
    [
      join(homeDir, '.local', 'share', 'opencode', 'auth.json'),
      join(homeDir, '.config', 'opencode', 'auth.json'),
    ],
    exists
  )
  if (auth && hasMeaningfulContent(auth, readJson)) {
    return { installed: true, authenticated: true, method: 'oauth' }
  }
  return { installed: true, authenticated: false }
}

const detectAgyAuth: PerCliAuth = ({ exists, readJson, homeDir, env }) => {
  // Antigravity is Gemini-based: same Google OAuth store / API-key env vars.
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
    return { installed: true, authenticated: true, method: 'api-key' }
  }
  const oauth = join(homeDir, '.gemini', 'oauth_creds.json')
  if (exists(oauth) && hasMeaningfulContent(oauth, readJson)) {
    return { installed: true, authenticated: true, method: 'oauth' }
  }
  return { installed: true, authenticated: false }
}

const AUTH_BY_TARGET: Record<DiscoveryTargetId, PerCliAuth> = {
  claude: detectClaudeAuth,
  codex: detectCodexAuth,
  opencode: detectOpenCodeAuth,
  agy: detectAgyAuth,
}

export const detectAgentAuth = (
  name: DiscoveryTargetId,
  deps: AuthDetectorDeps = {}
): AgentAuthState => {
  const homeDir = deps.homeDir ?? homedir()
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const readJson =
    deps.readJson ??
    ((path: string) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        return null
      }
    })
  try {
    return AUTH_BY_TARGET[name]({ env, exists, homeDir, readJson })
  } catch (error) {
    return {
      installed: true,
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
