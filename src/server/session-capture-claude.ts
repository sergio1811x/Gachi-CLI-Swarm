import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  captureSessionIdWithCoordinator,
  resetSessionCaptureCoordinatorForTests,
} from './claude-session-coordinator.js'
import { readEnv } from './env.js'

const SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i

const getDefaultProjectsRoot = () =>
  readEnv('CLAUDE_PROJECTS_DIR') ?? join(homedir(), '.claude/projects')

export const getClaudeProjectsRoot = (pattern?: string) => {
  if (!pattern) return getDefaultProjectsRoot()
  const markerIndex = pattern.indexOf('{encoded_cwd}')
  if (markerIndex === -1) return getDefaultProjectsRoot()
  const root = pattern.slice(0, markerIndex).replace(/[\\/]+$/, '')
  if (!root) return getDefaultProjectsRoot()
  if (root === '~' || root.startsWith('~/')) {
    return readEnv('CLAUDE_PROJECTS_DIR') ?? join(homedir(), '.claude', 'projects')
  }
  return root
}

export const encodeClaudeProjectPath = (cwd: string) => cwd.replace(/[\\/:\s]/g, '-')

const listSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) => {
  const projectDir = join(projectsRoot, encodeClaudeProjectPath(cwd))
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name))
      .map((entry) => entry.name.replace(/\.jsonl$/i, ''))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

interface ClaudeSessionCaptureDiscriminator {
  contentIncludes?: string | readonly string[]
}

const includesAny = (content: string, needles: string | readonly string[]) => {
  const normalizedNeedles = Array.isArray(needles) ? needles : [needles]
  return normalizedNeedles.some((needle) => content.includes(needle))
}

const sessionFileContainsAny = (
  cwd: string,
  projectsRoot: string,
  sessionId: string,
  contentIncludes: string | readonly string[]
) => {
  try {
    const content = readFileSync(
      join(projectsRoot, encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`),
      'utf8'
    )
    return includesAny(content, contentIncludes)
  } catch {
    return false
  }
}

export const getClaudeSessionFilePath = (cwd: string, sessionId: string, pattern?: string) =>
  join(getClaudeProjectsRoot(pattern), encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)

export const hasClaudeSessionFile = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) => {
  if (
    !SESSION_FILE.test(`${sessionId}.jsonl`) ||
    !existsSync(getClaudeSessionFilePath(cwd, sessionId, pattern))
  ) {
    return false
  }
  const projectsRoot = getClaudeProjectsRoot(pattern)
  if (!discriminator.contentIncludes) return true
  // Ownership marker is a strong signal but must not veto resume: older
  // sessions (pre-marker injections) legitimately exist on disk. File
  // presence in THIS project dir is already a solid ownership bound —
  // the runtime is the only thing launching CLIs in that cwd.
  if (sessionFileContainsAny(cwd, projectsRoot, sessionId, discriminator.contentIncludes)) {
    return true
  }
  console.warn(
    `[SESSIONS] ${sessionId.slice(0, 8)} exists without the ownership marker — resuming anyway`
  )
  return true
}

export const captureClaudeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  projectsRoot = getDefaultProjectsRoot(),
  discriminator: ClaudeSessionCaptureDiscriminator = {}
) => {
  const contentIncludes = discriminator.contentIncludes
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, projectsRoot),
    onCapture,
    projectKey: join(projectsRoot, encodeClaudeProjectPath(cwd)),
    timeoutMs,
    ...(contentIncludes
      ? {
          matchesSessionId: (sessionId: string) =>
            sessionFileContainsAny(cwd, projectsRoot, sessionId, contentIncludes),
        }
      : {}),
  })
}

export const snapshotClaudeSessionIds = (cwd: string, projectsRoot = getDefaultProjectsRoot()) =>
  new Set(listSessionIds(cwd, projectsRoot))

/**
 * S-1 legacy bridge: newest session id for this cwd whose file was touched
 * within `maxAgeMs`. Used when nothing was captured yet (pre-fix installs),
 * so the very first restart after the fix ALREADY resumes instead of starting
 * blank. Ownership caveat is documented at the call site.
 */
export const newestClaudeSessionId = (
  cwd: string,
  projectsRoot = getDefaultProjectsRoot(),
  maxAgeMs = 7 * 24 * 60 * 60_000
): string | null => {
  const dir = join(projectsRoot, encodeClaudeProjectPath(cwd))
  let best: { id: string; mtime: number } | null = null
  try {
    const cutoff = Date.now() - maxAgeMs
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue
      const mtime = statSync(join(dir, entry.name)).mtimeMs
      if (mtime < cutoff) continue
      if (!best || mtime > best.mtime) {
        best = { id: entry.name.replace(/\.jsonl$/i, ''), mtime }
      }
    }
  } catch {
    return null
  }
  return best?.id ?? null
}

export const resetClaudeSessionClaimsForTests = () => {
  resetSessionCaptureCoordinatorForTests()
}
