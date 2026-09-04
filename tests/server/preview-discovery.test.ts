import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
const httpServers: Server[] = []

afterAll(async () => {
  for (const srv of httpServers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

/** Real HTTP server on an ephemeral port serving a titled page. */
const listenWithTitle = async (title: string): Promise<number> => {
  const srv = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<html><head><title>${title}</title></head><body>preview</body></html>`)
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const address = srv.address()
  if (!address || typeof address === 'string') throw new Error('no inet port')
  httpServers.push(srv)
  return address.port
}

describe('dev-server preview discovery', () => {
  test('finds a live dev server and reports its title via the API', async () => {
    const port = await listenWithTitle('Vite App')

    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-preview-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'P', path: dataDir }),
    })
    expect(wsResponse.status).toBe(201)
    const { id } = (await wsResponse.json()) as { id: string }

    // Probe ONLY our controlled port plus one certainly-dead high port.
    const deadPort = 59000 + Math.floor(Math.random() * 500)
    const response = await fetch(
      `${server.baseUrl}/api/workspaces/${id}/preview/discover?ports=${port},${deadPort}`,
      { headers: { cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      candidates: Array<{ port: number; status: number; title: string | null }>
    }
    const found = body.candidates.find((candidate) => candidate.port === port)
    expect(found).toBeDefined()
    expect(found?.title).toBe('Vite App')

    expect(body.candidates.some((candidate) => candidate.port === deadPort)).toBe(false)
  })

  test('returns an empty list when nothing listens on probed ports', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-preview-empty-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'E', path: dataDir }),
    })
    const { id } = (await wsResponse.json()) as { id: string }

    // Two unlikely-to-be-listening high ports keep this deterministic.
    const a = 59100 + Math.floor(Math.random() * 200)
    const b = 59400 + Math.floor(Math.random() * 200)
    const response = await fetch(
      `${server.baseUrl}/api/workspaces/${id}/preview/discover?ports=${a},${b}`,
      { headers: { cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { candidates: unknown[] }
    expect(body.candidates.filter((c) => (c as { port: number }).port !== a)).toBeDefined()
    expect(
      body.candidates.find((c) => [a, b].includes((c as { port: number }).port))
    ).toBeUndefined()
  })

  test('404 for an unknown workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-preview-404-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const response = await fetch(`${server.baseUrl}/api/workspaces/nope/preview/discover`, {
      headers: { cookie },
    })
    expect(response.status).toBe(404)
  })
})
