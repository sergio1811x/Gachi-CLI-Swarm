import { execFile } from 'node:child_process'
import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

/**
 * Orchestrator feedback #3: "minutes since the last PTY character" cannot
 * distinguish a productive worker from a hung one (a CLI can stream spinner
 * frames forever while touching nothing). This clock reports the freshest
 * FILE activity inside the workspace instead — the thing tasks actually
 * produce. Read-only and throttled; never throws to callers.
 */

const exec = promisify(execFile)

export interface WorkspaceActivity {
  /** Newest mtime among artifact files, null when nothing found. */
  lastArtifactAt: number | null
  /** Changed/untracked file count (git) or scanned file count fallback. */
  changedFiles: number
}

interface ActivityCache {
  at: number
  result: WorkspaceActivity
}

const CACHE_TTL_MS = 30_000
const SCAN_TIMEOUT_MS = 5_000

const cache = new Map<string, ActivityCache>()

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.gachi',
  'dist',
  'coverage',
  '.next',
  '.cache',
])

const isIgnoredPath = (relative: string): boolean => {
  const normalized = relative.replace(/\\/g, '/')
  if (normalized.startsWith('.gachi/') || normalized.includes('/.gachi/')) return true
  return normalized.split('/').some((segment) => IGNORED_DIRS.has(segment))
}

const statMtime = (root: string, relative: string): number | null => {
  try {
    const stats = statSync(join(root, relative))
    // Directory mtimes change when children are added/renamed — still signal.
    return Math.max(stats.mtimeMs, stats.ctimeMs)
  } catch {
    return null
  }
}

/** Git-tracked + untracked changes; falls back to a shallow scan when not a repo. */
const collectActivity = async (workspacePath: string): Promise<WorkspaceActivity> => {
  const root = resolve(workspacePath)
  let latest = 0
  let count = 0

  try {
    const { stdout } = await exec('git', ['status', '--porcelain', '-z'], {
      cwd: root,
      timeout: SCAN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    for (const entry of stdout.split('\0')) {
      if (!entry || entry.length < 3) continue
      const relative = entry.slice(3)
      if (!relative || isIgnoredPath(relative)) continue
      count += 1
      const mtime = statMtime(root, relative)
      if (mtime && mtime > latest) latest = mtime
    }
    if (count > 0 || latest > 0) {
      return {
        lastArtifactAt: latest > 0 ? latest : null,
        changedFiles: count,
      }
    }
    // Clean git tree — fall through to shallow scan so "clean but writing
    // outside tracked paths" is still visible.
  } catch {
    // Not a git repo / no git binary — shallow scan below.
  }

  const scanDir = (dir: string, depth: number): void => {
    if (depth > 2) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(full, depth + 1)
        continue
      }
      count += 1
      const mtime = statMtime(dir, entry.name)
      if (mtime && mtime > latest) latest = mtime
    }
  }

  if (existsSync(root)) scanDir(root, 0)
  return { lastArtifactAt: latest > 0 ? latest : null, changedFiles: count }
}

export const getWorkspaceActivity = async (workspacePath: string): Promise<WorkspaceActivity> => {
  const key = resolve(workspacePath)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result
  const result = await collectActivity(key)
  cache.set(key, { at: Date.now(), result })
  return result
}

/** Minutes since the newest artifact write; null when nothing is on disk yet. */
export const minutesSinceLastArtifact = (activity: WorkspaceActivity): number | null =>
  activity.lastArtifactAt === null
    ? null
    : Math.max(0, Math.round((Date.now() - activity.lastArtifactAt) / 60_000))
