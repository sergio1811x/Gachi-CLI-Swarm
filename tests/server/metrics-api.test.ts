import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-metrics-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const createResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'M', path: dataDir }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { id: string }

  // Seed terminal tasks so success-rate is non-trivial.
  for (const title of ['one', 'two']) {
    await fetch(`${server.baseUrl}/api/workspaces/${created.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title, description: 'seed' }),
    })
  }

  return { baseUrl: server.baseUrl, cookie, workspaceId: created.id }
}

describe('workspace metrics endpoint (ROADMAP R1)', () => {
  test('returns task counters, success rate and usage aggregates', async () => {
    const ctx = await setup()
    const response = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/metrics?window_hours=24`,
      { headers: { cookie: ctx.cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      window_hours: number
      tasks: {
        done: number
        failed: number
        success_rate: number | null
        avg_task_duration_ms: number | null
      }
      tokens_total: number
      agents: Array<{ agentId: string }>
      samples: unknown[]
    }
    expect(body.window_hours).toBe(24)
    // Freshly seeded cards sit in backlog — nothing terminal yet.
    expect(body.tasks.done).toBe(0)
    expect(body.tasks.failed).toBe(0)
    expect(body.tasks.success_rate).toBeNull()
    expect(body.agents).toBeInstanceOf(Array)
    expect(body.samples).toBeInstanceOf(Array)
  })

  test('404 for unknown workspace', async () => {
    const ctx = await setup()
    const response = await fetch(`${ctx.baseUrl}/api/workspaces/nope/metrics`, {
      headers: { cookie: ctx.cookie },
    })
    expect(response.status).toBe(404)
  })
})
