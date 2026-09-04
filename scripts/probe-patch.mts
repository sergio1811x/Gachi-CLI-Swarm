import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestServer } from '../tests/helpers/test-server.js'
import { getUiCookie } from '../tests/helpers/ui-session.js'

const dataDir = mkdtempSync(join(tmpdir(), 'probe-ts-api-'))
const wsPath = join(dataDir, 'ws')
mkdirSync(wsPath, { recursive: true })
const server = await startTestServer({ dataDir })
const cookie = await getUiCookie(server.baseUrl)
const r = await fetch(`${server.baseUrl}/api/workspaces`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ name: 'P', path: wsPath }),
})
const ws = await r.json()
const tr = await fetch(`${server.baseUrl}/api/workspaces/${ws.id}/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ title: 't' }),
})
console.log('create', tr.status)
const list = await (
  await fetch(`${server.baseUrl}/api/workspaces/${ws.id}/tasks?format=store`, {
    headers: { cookie },
  })
).json()
const id = list.tasks[0].id
const pr = await fetch(`${server.baseUrl}/api/workspaces/${ws.id}/tasks/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ status: 'running', assigned_worker_id: 'worker-42' }),
})
console.log('patch', pr.status, await pr.text())
await server.close()
