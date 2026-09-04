import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const makeProjectDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-example-task-'))
  tempDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

describe('POST /api/workspaces example_task (R8)', () => {
  test('opt-in flag seeds one orientation card into the backlog', async () => {
    const server = await startTestServer({ dataDir: mkdtempSync(join(tmpdir(), 'gachi-ex-')) })
    servers.push(server)
    tempDirs.push(mkdtempSync(join(tmpdir(), 'gachi-ex-unused')))
    const cookie = await getUiCookie(server.baseUrl)

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart_orchestrator: false,
        example_task: true,
        name: 'EX',
        path: makeProjectDir(),
      }),
    })
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }

    const listResponse = await fetch(`${server.baseUrl}/api/workspaces/${id}/tasks?format=store`, {
      headers: { cookie },
    })
    const listed = (await listResponse.json()) as {
      tasks: Array<{ description: string; status: string; title: string }>
    }
    const seeded = listed.tasks.filter((task) =>
      task.title.includes('Orientation: explore this project')
    )
    expect(seeded).toHaveLength(1)
    expect(seeded[0]?.status).toBe('backlog')
    expect(seeded[0]?.description).toContain('.gachi/orientation.md')
    expect(seeded[0]?.description).toContain('Do not modify any source files')
  })

  test('default (no flag) creates no cards', async () => {
    const server = await startTestServer({ dataDir: mkdtempSync(join(tmpdir(), 'gachi-ex2-')) })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)

    const response = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart_orchestrator: false,
        name: 'EX2',
        path: makeProjectDir(),
      }),
    })
    const { id } = (await response.json()) as { id: string }

    const listResponse = await fetch(`${server.baseUrl}/api/workspaces/${id}/tasks?format=store`, {
      headers: { cookie },
    })
    const listed = (await listResponse.json()) as { tasks: unknown[] }
    expect(listed.tasks).toHaveLength(0)
  })
})
