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

describe('POST /plan/draft (R2.2)', () => {
  test('409 when the orchestrator is not running', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-plan-draft-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'D', path: dataDir }),
    })
    expect(wsResponse.status).toBe(201)
    const { id } = (await wsResponse.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/plan/draft`, {
      body: JSON.stringify({ goal: 'Build a CRM dashboard with auth' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('orchestrator is not running')
  })

  test('400 when goal is too short', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-plan-short-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'S', path: dataDir }),
    })
    const { id } = (await wsResponse.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/plan/draft`, {
      body: JSON.stringify({ goal: 'hi' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(response.status).toBe(400)
  })
})
