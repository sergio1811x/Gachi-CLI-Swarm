import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  BINDING_MARKER_PREFIX,
  claudeMarkerConfirmed,
  startDeliveryMonitor,
} from '../../src/server/instruction-delivery-monitor.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('instruction delivery monitor (S-1 follow-up)', () => {
  test('claudeMarkerConfirmed sees the marker in a fresh session file', () => {
    const home = mkdtempSync(join(tmpdir(), 'gachi-monitor-home-'))
    tempDirs.push(home)
    const cwd = mkdtempSync(join(tmpdir(), 'gachi-monitor-cwd-'))
    tempDirs.push(cwd)
    const since = Date.now() - 5_000
    const encoded = cwd.replace(/[\\/:]/g, '-')
    const dir = join(home, '.claude', 'projects', encoded)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '323e4567-e89b-42d3-a456-426614174000.jsonl'),
      `${BINDING_MARKER_PREFIX}workspace_id=ws; agent_id=ag\n`
    )

    process.env.GACH_CLAUDE_PROJECTS_DIR = join(home, '.claude', 'projects')
    try {
      expect(claudeMarkerConfirmed(cwd, since)).toBe(true)
      // A file written BEFORE `since` must not count.
      expect(claudeMarkerConfirmed(cwd, Date.now() + 10_000)).toBe(false)
    } finally {
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
      delete process.env.GACH_CLAUDE_PROJECTS_DIR
    }
  })

  test('monitor re-pastes until confirmed and then stops', async () => {
    const home = makeProjectsHome()
    let pastes = 0
    let confirmed = false
    const alive = true

    startDeliveryMonitor({
      isRunAlive: () => alive,
      repaste: () => {
        pastes += 1
        if (pastes >= 2) {
          // Simulate the CLI finally landing the payload → marker appears.
          confirmed = true
          writeMarker(home)
        }
      },
      isConfirmed: () => confirmed,
      intervalMs: 30,
      maxAttempts: 20,
    })

    await waitFor(() => expect(confirmed).toBe(true))
    const afterConfirm = pastes
    await new Promise((resolve) => setTimeout(resolve, 80))
    // No further pastes once confirmed.
    expect(pastes).toBe(afterConfirm)
    void alive
  }, 5_000)

  test('monitor gives up after the attempt budget and stops pasting', async () => {
    let gaveUp = false
    let pastes = 0
    startDeliveryMonitor({
      isRunAlive: () => true,
      repaste: () => {
        pastes += 1
      },
      isConfirmed: () => false,
      intervalMs: 10,
      maxAttempts: 3,
      onGiveUp: () => {
        gaveUp = true
      },
    })
    await waitFor(() => expect(gaveUp).toBe(true))
    const frozen = pastes
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pastes).toBe(frozen)
    expect(frozen).toBeLessThanOrEqual(4) // budget respected
  }, 5_000)

  test('dead run stops the loop without give-up noise', async () => {
    let pastes = 0
    let gaveUpFired = false
    startDeliveryMonitor({
      isRunAlive: () => false,
      repaste: () => {
        pastes += 1
      },
      isConfirmed: () => false,
      intervalMs: 10,
      maxAttempts: 50,
      onGiveUp: () => {
        gaveUpFired = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pastes).toBe(0)
    expect(gaveUpFired).toBe(false)
  })
})

// --- helpers ---

let _projectsHomeForTests: string | null = null

function makeProjectsHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gachi-monitor-'))
  tempDirs.push(home)
  _projectsHomeForTests = home
  return home
}

function writeMarker(home: string): void {
  const dir = join(home, '.claude', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '423e4567-e89b-42d3-a456-426614174000.jsonl'),
    `${BINDING_MARKER_PREFIX}ws; ag\n`
  )
}

async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  assertion()
}
