import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const setupGachi = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-event-log-'))
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
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerResponse.json()) as { id: string; name: string }

  return { baseUrl, instance, worker, workspaceId: workspace.id, workspacePath }
}

afterEach(async () => {
  delete process.env.GACH_DATA_DIR
  delete process.env.GACH_DATA_DIR
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('team events API (EventBus mailbox)', () => {
  test('rejects a request with no project_id (400)', async () => {
    const ctx = await setupGachi()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/team/events`)
      expect(response.status).toBe(400)
    } finally {
      await ctx.instance.close()
    }
  })

  test('rejects anonymous caller with a project_id but no agent identity (401)', async () => {
    const ctx = await setupGachi()
    try {
      const response = await fetch(`${ctx.baseUrl}/api/team/events?project_id=${ctx.workspaceId}`)
      expect(response.status).toBe(401)
    } finally {
      await ctx.instance.close()
    }
  })

  test('task dispatch writes to the agent mailbox, audit log, and the on-disk ndjson', async () => {
    const ctx = await setupGachi()
    try {
      // No fromAgentId -> dispatchTask just creates the task card and emits
      // QUEUE_UPDATED / TASK_* events; it does not need a live PTY run.
      await ctx.instance.store.dispatchTask(ctx.workspaceId, ctx.worker.id, 'Implement login')

      const events = ctx.instance.store.tailEvents(ctx.workspaceId)
      expect(events.length).toBeGreaterThan(0)
      expect(events.some((e) => e.type === 'QUEUE_UPDATED')).toBe(true)
      // The task's dispatch must appear in the worker's own mailbox stream.
      const workerEvents = ctx.instance.store.agentEvents(ctx.workspaceId, ctx.worker.id)
      expect(workerEvents.some((e) => e.type === 'QUEUE_UPDATED')).toBe(true)

      // Audit trail is durable on disk, next to the task file.
      const auditFile = join(ctx.workspacePath, '.gachi', 'events', `${ctx.workspaceId}.ndjson`)
      expect(existsSync(auditFile)).toBe(true)
    } finally {
      await ctx.instance.close()
    }
  })
})
