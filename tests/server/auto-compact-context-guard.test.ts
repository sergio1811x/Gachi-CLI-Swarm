import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

/**
 * Этап 4: context guard wiring end-to-end. A scraped
 * "Context left until auto-compact: N%" line above the configured threshold
 * journals `[CONTEXT] compact requested (N%)` into the worker's bound card
 * (and writes the engine's /compact into the live PTY). The app-state knobs
 * are honored live: `context_guard_threshold_percent` (default 85, "0" = off),
 * fresh runs get a 2-minute quiet window that must NOT arm the 30-minute
 * cooldown, and each agent cools down independently.
 */

const CONTEXT_LINE = (percent: number) => `Context left until auto-compact: ${percent}%`

const journalCount = (workspaceId: string, taskId: string) =>
  (taskStore.getTask(workspaceId, taskId)?.logs ?? []).filter((line) =>
    line.includes('[CONTEXT] compact requested')
  ).length

const tempDirs: string[] = []
const stores: Array<{ close: () => Promise<void> | void }> = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close()
  }
  // Windows: sqlite handle release can lag one tick behind close().
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { force: true, recursive: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

const waitFor = async (predicate: () => boolean, timeoutMs: number, message: string) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

const setup = async (dataDir: string) => {
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  // Worker that survives the whole test without touching stdin.
  const keepAliveScript = join(workspacePath, 'keep-alive.cjs')
  writeFileSync(keepAliveScript, 'process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n')
  // Engine stamp: never spawned — its basename is what the adapter matches.
  const fakeClaude = join(workspacePath, 'claude.cmd')
  writeFileSync(fakeClaude, 'rem fake\n')

  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Alpha')

  const startEngineWorker = async (workerId: string) => {
    store.configureAgentLaunch(workspace.id, workerId, {
      command: process.execPath,
      args: [keepAliveScript],
    })
    await store.startAgent(workspace.id, workerId, { gachiPort: '4010' })
    // Re-stamp the persisted config as a claude launch while the live run
    // keeps the node keep-alive script alive (engine-switch seam).
    store.configureAgentLaunch(workspace.id, workerId, {
      command: fakeClaude,
      args: [],
    })
  }

  return { store, workspaceId: workspace.id, startEngineWorker }
}

describe('auto-compact context guard wiring (Этап 4)', () => {
  test(
    'crossings journal into the bound card and honor the app-state knobs',
    { skip: SKIP_CONPTY_WINDOWS },
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'gachi-context-guard-'))
      tempDirs.push(dataDir)
      const { store, workspaceId: ws, startEngineWorker } = await setup(dataDir)

      const runOf = (agentId: string) => store.getActiveRunByAgentId(ws, agentId)

      // Sentry: card bound before start so the starter keeps this exact task.
      const sentry = store.addWorker(ws, { name: 'Sentry', role: 'coder' })
      const sentryCard = taskStore.createTask(ws, {
        title: 'Hold the line',
        description: 'long-running engine session',
        status: 'assigned',
        assignedAgentId: sentry.id,
      })
      await startEngineWorker(sentry.id)
      await waitFor(() => runOf(sentry.id) !== undefined, 15_000, 'Sentry run never became active')

      // 1) Fresh run — quiet window: the crossing is ignored and must NOT
      //    arm the cooldown.
      store.telemetry.observe(ws, sentry.id, `${CONTEXT_LINE(92)}\r\n`)
      expect(journalCount(ws, sentryCard.id)).toBe(0)

      // 2) Window expired (white-box backdate): the same crossing now fires
      //    and journals into the bound card.
      const sentryRun = runOf(sentry.id)
      if (!sentryRun) throw new Error('Sentry run vanished')
      sentryRun.startedAt = Date.now() - 3 * 60_000
      store.telemetry.observe(ws, sentry.id, `${CONTEXT_LINE(92)}\r\n`)
      expect(journalCount(ws, sentryCard.id)).toBe(1)

      // 3) Per-agent cooldown: an immediate re-crossing stays silent.
      store.telemetry.observe(ws, sentry.id, `${CONTEXT_LINE(95)}\r\n`)
      expect(journalCount(ws, sentryCard.id)).toBe(1)

      // 4) Workspace threshold override, read live from app-state: 94 stays
      //    silent below 96, 97 fires above it (cooldown of Sentry is
      //    independent — Ranger has its own run and its own clock).
      store.settings.setAppState('context_guard_threshold_percent', '96')
      const ranger = store.addWorker(ws, { name: 'Ranger', role: 'coder' })
      const rangerCard = taskStore.createTask(ws, {
        title: 'Scout ahead',
        description: 'second worker, own threshold',
        status: 'assigned',
        assignedAgentId: ranger.id,
      })
      await startEngineWorker(ranger.id)
      await waitFor(() => runOf(ranger.id) !== undefined, 15_000, 'Ranger run never became active')
      const rangerRun = runOf(ranger.id)
      if (!rangerRun) throw new Error('Ranger run vanished')
      rangerRun.startedAt = Date.now() - 3 * 60_000

      store.telemetry.observe(ws, ranger.id, `${CONTEXT_LINE(94)}\r\n`)
      expect(journalCount(ws, rangerCard.id)).toBe(0)

      store.telemetry.observe(ws, ranger.id, `${CONTEXT_LINE(97)}\r\n`)
      expect(journalCount(ws, rangerCard.id)).toBe(1)

      // 5) "0" turns the percent trigger off without a restart; the scrape
      //    itself keeps updating the snapshot.
      store.settings.setAppState('context_guard_threshold_percent', '0')
      const mute = store.addWorker(ws, { name: 'Mute', role: 'coder' })
      const muteCard = taskStore.createTask(ws, {
        title: 'Silent watch',
        description: 'guard disabled',
        status: 'assigned',
        assignedAgentId: mute.id,
      })
      await startEngineWorker(mute.id)
      await waitFor(() => runOf(mute.id) !== undefined, 15_000, 'Mute run never became active')
      const muteRun = runOf(mute.id)
      if (!muteRun) throw new Error('Mute run vanished')
      muteRun.startedAt = Date.now() - 3 * 60_000

      store.telemetry.observe(ws, mute.id, `${CONTEXT_LINE(99)}\r\n`)
      expect(journalCount(ws, muteCard.id)).toBe(0)
      expect(store.telemetry.snapshot(ws, mute.id)?.contextPercent).toBe(99)
    },
    40_000
  )
})
