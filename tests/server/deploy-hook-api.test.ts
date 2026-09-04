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

describe('deploy hook config API (ROADMAP R4)', () => {
  test('PUT sets the command; pr/status exposes it; empty value clears', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-deployhook-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'DH', path: dataDir }),
    })
    expect(wsResponse.status).toBe(201)
    const { id } = (await wsResponse.json()) as { id: string }

    const statusBefore = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    expect(
      ((await statusBefore.json()) as { deploy_hook_command: unknown }).deploy_hook_command
    ).toBeNull()

    const put = await fetch(`${server.baseUrl}/api/workspaces/${id}/deploy-hook`, {
      body: JSON.stringify({ command: ' npm run deploy \n' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { deploy_hook_command: string | null }).deploy_hook_command).toBe(
      'npm run deploy'
    )

    const statusAfter = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    expect(
      ((await statusAfter.json()) as { deploy_hook_command: string | null }).deploy_hook_command
    ).toBe('npm run deploy')

    const clear = await fetch(`${server.baseUrl}/api/workspaces/${id}/deploy-hook`, {
      body: JSON.stringify({ command: '' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(clear.status).toBe(200)
    expect(
      ((await clear.json()) as { deploy_hook_command: string | null }).deploy_hook_command
    ).toBeNull()
  })

  test('unknown workspace → 404', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-deployhook-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const put = await fetch(`${server.baseUrl}/api/workspaces/no-such/deploy-hook`, {
      body: JSON.stringify({ command: 'x' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(404)
  })
})
