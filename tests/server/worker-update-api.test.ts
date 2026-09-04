import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []
const stores: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }

  await Promise.all(stores.splice(0).map((store) => store.close()))

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-worker-update-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const store = createRuntimeStore({ dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

  const app = createApp({ store })
  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const cookie = await getUiCookie(baseUrl)
  return { baseUrl, cookie, store, worker, workspace }
}

describe.skipIf(SKIP_CONPTY_WINDOWS)('worker update api', () => {
  test('PATCH worker updates name and description and returns the serialized worker', async () => {
    const { baseUrl, cookie, store, worker, workspace } = await setup()

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Alice 2', description: 'New skill text' }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { description: string | null; name: string }
    expect(body.name).toBe('Alice 2')
    expect(body.description).toBe('New skill text')

    const updated = store.getWorker(workspace.id, worker.id)
    expect(updated.name).toBe('Alice 2')
    expect(updated.description).toBe('New skill text')
  })

  test('PATCH worker with only description keeps the existing name', async () => {
    const { baseUrl, cookie, store, worker, workspace } = await setup()

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ description: 'Only skill changed' }),
    })

    expect(response.status).toBe(200)
    const updated = store.getWorker(workspace.id, worker.id)
    expect(updated.name).toBe('Alice')
    expect(updated.description).toBe('Only skill changed')
  })

  test('PATCH worker with a duplicate name is rejected', async () => {
    const { baseUrl, cookie, store, worker, workspace } = await setup()
    store.addWorker(workspace.id, { name: 'Bob', role: 'reviewer' })

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers/${worker.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Bob' }),
    })

    expect(response.status).toBe(409)
  })
})
