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

const createWorkspace = async (baseUrl: string, cookie: string, dataDir: string) => {
  const wsResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'MW', path: dataDir }),
  })
  return ((await wsResponse.json()) as { id: string }).id
}

describe('memory watchdog API', () => {
  test('config route persists threshold + rotation and echoes the resulting config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-memwd-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const id = await createWorkspace(server.baseUrl, cookie, dataDir)

    const put = await fetch(`${server.baseUrl}/api/workspaces/${id}/memory-watchdog`, {
      body: JSON.stringify({ free_percent: 12, rotation_rss_mb: 2048 }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(200)
    expect(
      (
        (await put.json()) as {
          memory_watchdog: { free_percent: number; rotation_rss_mb: number | null }
        }
      ).memory_watchdog
    ).toEqual({ free_percent: 12, rotation_rss_mb: 2048 })

    // Values are visible through the app-state surface the watchdog reads.
    const store = server.store
    expect(store.settings.getAppState('memory_watchdog_free_percent')?.value).toBe('12')
    expect(store.settings.getAppState(`worker_mem_rotation_${id}`)?.value).toBe('2048')

    // Rotation off again.
    const off = await fetch(`${server.baseUrl}/api/workspaces/${id}/memory-watchdog`, {
      body: JSON.stringify({ rotation_rss_mb: null }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(
      ((await off.json()) as { memory_watchdog: { rotation_rss_mb: number | null } })
        .memory_watchdog.rotation_rss_mb
    ).toBeNull()

    // Disabling zeroes the threshold.
    const disable = await fetch(`${server.baseUrl}/api/workspaces/${id}/memory-watchdog`, {
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(
      ((await disable.json()) as { memory_watchdog: { free_percent: number } }).memory_watchdog
        .free_percent
    ).toBe(0)
  })

  test('pr/status exposes the global memory hold and watchdog config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-memwd-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const id = await createWorkspace(server.baseUrl, cookie, dataDir)

    const before = (await (
      await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, { headers: { cookie } })
    ).json()) as { dispatch_paused_memory?: boolean; memory_watchdog?: { free_percent: number } }
    expect(before.dispatch_paused_memory).toBe(false)
    expect(before.memory_watchdog?.free_percent).toBeGreaterThan(0)

    // The watchdog's global hold flips the status flag for every workspace.
    server.store.settings.setAppState('dispatch_paused_memory', '1')
    const during = (await (
      await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, { headers: { cookie } })
    ).json()) as { dispatch_paused_memory?: boolean }
    expect(during.dispatch_paused_memory).toBe(true)
  })

  test('unknown workspace → 404', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-memwd-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const put = await fetch(`${server.baseUrl}/api/workspaces/no-such/memory-watchdog`, {
      body: JSON.stringify({ free_percent: 10 }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'PUT',
    })
    expect(put.status).toBe(404)
  })
})
