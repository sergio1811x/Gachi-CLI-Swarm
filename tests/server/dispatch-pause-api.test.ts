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

describe('PUT /dispatch-pause (R10 error budget resume)', () => {
  test('pause flag round-trips and surfaces in pr/status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pause-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'DP', path: dataDir }),
    })
    const { id } = (await wsResponse.json()) as { id: string }

    const put = await fetch(`${server.baseUrl}/api/workspaces/${id}/dispatch-pause`, {
      body: JSON.stringify({ paused: true }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { dispatch_paused: boolean }).dispatch_paused).toBe(true)

    const status = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    expect(((await status.json()) as { dispatch_paused?: boolean }).dispatch_paused).toBe(true)

    const resume = await fetch(`${server.baseUrl}/api/workspaces/${id}/dispatch-pause`, {
      body: JSON.stringify({ paused: false }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(((await resume.json()) as { dispatch_paused: boolean }).dispatch_paused).toBe(false)
  })

  test('unknown workspace → 404', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pause-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const put = await fetch(`${server.baseUrl}/api/workspaces/no-such/dispatch-pause`, {
      body: JSON.stringify({ paused: true }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(404)
  })
})
