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
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-control-summary-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const createResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Swarm',
      path: dataDir,
    }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { id: string }
  return { baseUrl: server.baseUrl, cookie, server, workspaceId: created.id }
}

describe('control summary endpoint (swarm dashboard)', () => {
  test('aggregates every agent with control state plus task counters', async () => {
    const { baseUrl, cookie, workspaceId, server } = await setup()

    // Fresh workspace owns exactly one orchestrator.
    const snapshot = server.store.getWorkspaceSnapshot(workspaceId)
    expect(snapshot.agents).toHaveLength(1)

    // Seed tasks across statuses so the counters are non-trivial.
    const seed = async (title: string) => {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title, description: 'seed' }),
      })
      expect(response.status).toBe(201)
    }
    await seed('one')
    await seed('two')

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/control/summary`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      agents: Array<{
        agent_id: string
        name: string
        role: string
        running: boolean
        status: string
      }>
      tasks: Record<string, number>
    }

    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]).toMatchObject({ name: 'Orchestrator', role: 'orchestrator' })
    expect(body.agents[0].running).toBe(false)

    // Both seeded cards land in `backlog` until dispatched.
    expect(body.tasks.backlog).toBe(2)
    expect(body.tasks.done).toBe(0)
  })

  test('returns 404 for an unknown workspace', async () => {
    const { baseUrl, cookie } = await setup()
    const response = await fetch(`${baseUrl}/api/workspaces/nope/control/summary`, {
      headers: { cookie },
    })
    expect(response.status).toBe(404)
  })
})

describe('agent follow-up input endpoint', () => {
  test('rejects empty text with 400', async () => {
    const { baseUrl, cookie, workspaceId, server } = await setup()
    const agent = server.store.getWorkspaceSnapshot(workspaceId).agents[0]
    if (!agent) throw new Error('fixture agent missing')
    const agentId = agent.id

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/control/input`,
      {
        body: JSON.stringify({ text: '   ' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(response.status).toBe(400)
  })

  test('returns 409 when the agent has no live run', async () => {
    const { baseUrl, cookie, workspaceId, server } = await setup()
    const agent = server.store.getWorkspaceSnapshot(workspaceId).agents[0]
    if (!agent) throw new Error('fixture agent missing')
    const agentId = agent.id

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/control/input`,
      {
        body: JSON.stringify({ text: 'продолжай' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('not running')
  })
})
