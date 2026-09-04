import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import {
  captureSessionIdForCapture,
  doesCapturedSessionExist,
  type SessionCaptureSnapshot,
  type SessionIdCaptureConfig,
  snapshotSessionIdsForCapture,
} from '../../src/server/session-capture.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const tempDirs: string[] = []
const databases: Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/**
 * Regression coverage for the "every restart opened a NEW session" outage:
 * capture used to require the injected ownership marker inside the session
 * JSONL, so any TUI paste hiccup silently disabled resume for the whole
 * install (agent_sessions stayed empty).
 */

const CLAUDE_CAPTURE: SessionIdCaptureConfig = {
  source: 'claude_project_jsonl_dir',
  pattern: '{encoded_cwd}',
}

const makeProjectsRoot = () => {
  const home = mkdtempSync(join(tmpdir(), 'gachi-session-capture-'))
  tempDirs.push(home)
  const projectsRoot = join(home, '.claude', 'projects')
  mkdirSync(projectsRoot, { recursive: true })
  return { home, projectsRoot }
}

describe('session capture flow (resume outage regression)', () => {
  test('captures a brand-new session file without requiring the ownership marker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gachi-capture-cwd-'))
    tempDirs.push(cwd)
    const { projectsRoot } = makeProjectsRoot()
    process.env.GACH_CLAUDE_PROJECTS_DIR = projectsRoot
    try {
      // Snapshot BEFORE the CLI starts, exactly like buildAgentRunBootstrap.
      const snapshot: SessionCaptureSnapshot | undefined = snapshotSessionIdsForCapture(
        cwd,
        CLAUDE_CAPTURE
      )
      expect(snapshot).toBeDefined()

      // The CLI creates its session file with arbitrary content (no marker).
      const encoded = cwd.replace(/[\\/:]/g, '-')
      mkdirSync(join(projectsRoot, encoded), { recursive: true })
      writeFileSync(
        join(projectsRoot, encoded, '123e4567-e89b-42d3-a456-426614174000.jsonl'),
        '{}\n'
      )

      let captured: string | undefined
      await captureSessionIdForCapture(
        cwd,
        CLAUDE_CAPTURE,
        snapshot!,
        (id) => {
          captured = id
        },
        2_000
      )

      expect(captured).toBe('123e4567-e89b-42d3-a456-426614174000')
    } finally {
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
    }
  })

  test('resume verification accepts an existing marker-less session file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gachi-resume-cwd-'))
    tempDirs.push(cwd)
    const { projectsRoot } = makeProjectsRoot()
    process.env.GACH_CLAUDE_PROJECTS_DIR = projectsRoot
    try {
      const encoded = cwd.replace(/[\\/:]/g, '-')
      mkdirSync(join(projectsRoot, encoded), { recursive: true })
      const sessionId = '223e4567-e89b-42d3-a456-426614174000'
      // Old installs have sessions without any ownership marker.
      writeFileSync(join(projectsRoot, encoded, `${sessionId}.jsonl`), '{}\n')

      const owned = doesCapturedSessionExist(cwd, CLAUDE_CAPTURE, sessionId, {
        contentIncludes: ['Gachi session binding: workspace_id=ws; agent_id=ag'],
      })
      expect(owned).toBe(true)
    } finally {
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
    }
  })

  test('persisted ids survive a store restart (hydrate from SQLite)', () => {
    const home = mkdtempSync(join(tmpdir(), 'gachi-sess-store-'))
    tempDirs.push(home)
    const db = new Database(':memory:')
    databases.push(db)
    initializeRuntimeDatabase(db)
    // The store only tracks sessions of known agents — seed the workspace row.
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'ws-1',
      'Alpha',
      'C:/tmp/alpha',
      Date.now()
    )

    const first = createAgentSessionStore(db)
    first.setLastSessionId('ws-1', 'ws-1:orchestrator', 'abc')
    // Simulate app restart: a fresh store instance over the same DB.
    const second = createAgentSessionStore(db)
    expect(second.getLastSessionId('ws-1', 'ws-1:orchestrator')).toBe('abc')

    second.setLastSessionId('ws-1', 'ws-1:orchestrator', 'def')
    expect(second.getLastSessionId('ws-1', 'ws-1:orchestrator')).toBe('def')
  })
})
