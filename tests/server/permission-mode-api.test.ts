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

describe('PUT /permissions + pr/status mode field (R10)', () => {
  test('mode round-trips and surfaces in pr/status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-perm-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'PM', path: dataDir }),
    })
    const { id } = (await wsResponse.json()) as { id: string }

    const statusBefore = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    expect(
      ((await statusBefore.json()) as { worker_permission_mode?: string }).worker_permission_mode
    ).toBe('allow-all')

    const put = await fetch(`${server.baseUrl}/api/workspaces/${id}/permissions`, {
      body: JSON.stringify({ mode: 'ask' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { worker_permission_mode: string }).worker_permission_mode).toBe(
      'ask'
    )

    // Garbage modes fall back to the safe default rather than erroring.
    const junkPut = await fetch(`${server.baseUrl}/api/workspaces/${id}/permissions`, {
      body: JSON.stringify({ mode: 'sudo-everything' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(
      ((await junkPut.json()) as { worker_permission_mode: string }).worker_permission_mode
    ).toBe('allow-all')

    const statusAfter = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    // Last write won — the junk PUT reset it to allow-all.
    expect(
      ((await statusAfter.json()) as { worker_permission_mode?: string }).worker_permission_mode
    ).toBe('allow-all')
  })

  test('unknown workspace → 404', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-perm-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const put = await fetch(`${server.baseUrl}/api/workspaces/no-such/permissions`, {
      body: JSON.stringify({ mode: 'ask' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(404)
  })
})
