import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'

const CODEX_SESSION_FILE = /^rollout-.*\.jsonl$/i
const CODEX_HEADER_READ_CHUNK_BYTES = 4096
const CODEX_HEADER_MAX_BYTES = 64 * 1024

const getDefaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')

const expandHome = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

export const getCodexHome = (pattern?: string) => {
  if (!pattern) return getDefaultCodexHome()
  const markerIndex = pattern.indexOf('/sessions/')
  if (markerIndex === -1) return getDefaultCodexHome()
  const rawRoot = pattern.slice(0, markerIndex)
  if (rawRoot === '~/.codex' || rawRoot === '~/.codex/') return getDefaultCodexHome()
  const root = expandHome(rawRoot)
  return root || getDefaultCodexHome()
}

const walkSessionFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walkSessionFiles(path)
      return entry.isFile() && CODEX_SESSION_FILE.test(entry.name) ? [path] : []
    })
  } catch {
    return []
  }
}

export const readCodexSessionFirstLine = (
  filePath: string,
  maxBytes = CODEX_HEADER_MAX_BYTES
): string | null => {
  const fd = openSync(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0
    let reachedLineEnd = false

    while (totalBytes < maxBytes) {
      const bytesToRead = Math.min(CODEX_HEADER_READ_CHUNK_BYTES, maxBytes - totalBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
      if (bytesRead === 0) {
        reachedLineEnd = true
        break
      }

      const slice = buffer.subarray(0, bytesRead)
      const newlineIndex = slice.indexOf(0x0a)
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex))
        reachedLineEnd = true
        break
      }

      chunks.push(slice)
      totalBytes += bytesRead
      position += bytesRead
    }

    if (!reachedLineEnd) return null
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
  } finally {
    closeSync(fd)
  }
}

const parseCodexSession = (filePath: string) => {
  const firstLine = readCodexSessionFirstLine(filePath) ?? ''
  const parsed = JSON.parse(firstLine) as unknown
  if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null
  const payload = parsed.payload
  if (!payload || typeof payload !== 'object') return null
  const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : null
  const cwd = 'cwd' in payload && typeof payload.cwd === 'string' ? payload.cwd : null
  return id && cwd ? { cwd, id } : null
}

const listSessionIds = (cwd: string, codexHome = getDefaultCodexHome()) => {
  const sessionsRoot = join(codexHome, 'sessions')
  return walkSessionFiles(sessionsRoot)
    .flatMap((filePath) => {
      try {
        const session = parseCodexSession(filePath)
        return session?.cwd === cwd ? [session.id] : []
      } catch {
        return []
      }
    })
    .sort((left, right) => left.localeCompare(right))
}

export const hasCodexSession = (cwd: string, sessionId: string, pattern?: string) =>
  listSessionIds(cwd, getCodexHome(pattern)).includes(sessionId)

export const snapshotCodexSessionIds = (cwd: string, codexHome = getDefaultCodexHome()) =>
  new Set(listSessionIds(cwd, codexHome))

export const captureCodexSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  codexHome = getDefaultCodexHome()
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, codexHome),
    onCapture,
    projectKey: join(codexHome, 'sessions', cwd),
    timeoutMs,
  })
}

export const codexSessionStoreExists = (codexHome = getDefaultCodexHome()) =>
  existsSync(join(codexHome, 'sessions'))
