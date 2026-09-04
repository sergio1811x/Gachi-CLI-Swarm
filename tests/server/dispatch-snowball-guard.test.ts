import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const setupGachi = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-snowball-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  process.env.GACH_DATA_DIR = dataDir
  const instance = await runGachiCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${instance.port}`
  const uiCookie = await getUiCookie(baseUrl)

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }

  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Image Gen B', role: 'coder' }),
  })
  const worker = (await workerResponse.json()) as { id: string; name: string }

  return { baseUrl, instance, worker, workspaceId: workspace.id }
}

afterEach(async () => {
  delete process.env.GACH_DATA_DIR
  delete process.env.GACH_DATA_DIR
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('dispatch snowball guard', () => {
  test('a second team send to a worker with an in-flight task is rejected (no poke / no pending inflation)', async () => {
    const ctx = await setupGachi()
    try {
      // First dispatch creates an in-flight (assigned) task for the worker.
      const first = await ctx.instance.store.dispatchTask(
        ctx.workspaceId,
        ctx.worker.id,
        'Render A'
      )
      expect(first).toBeDefined()

      // A fresh `team send` to the same busy worker must be rejected with a
      // clear conflict instead of poking its PTY and inflating pendingTaskCount.
      await expect(
        ctx.instance.store.dispatchTaskByWorkerName(ctx.workspaceId, 'Image Gen B', 'Render B')
      ).rejects.toThrow(/already working on task/)

      // Only one dispatch exists (no duplicate dispatch snowballing in the ledger).
      expect(ctx.instance.store.listDispatches(ctx.workspaceId)).toHaveLength(1)
    } finally {
      await ctx.instance.close()
    }
  })
})
