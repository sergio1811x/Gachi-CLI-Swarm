import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Real repo with two commits dated inside the window. */
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-changelog-'))
  tempDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  git(['init'], dir)
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 'Swarm'], dir)
  writeFileSync(join(dir, 'a.txt'), '1\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'feat: alpha engine wiring'], dir)
  writeFileSync(join(dir, 'b.txt'), '2\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'fix: telegram proxy reconnect'], dir)
  return dir
}

describe('GET /changelog (ROADMAP R4)', () => {
  test('merges git commits with PR journal from done tasks', async () => {
    const repoPath = makeRepo()

    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-changelog-db-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'CL', path: repoPath }),
    })
    expect(wsResponse.status).toBe(201)
    const { id } = (await wsResponse.json()) as { id: string }

    // Seed a done card through the singleton taskStore (same instance the
    // server uses), walking the legal transition chain.
    const { taskStore } = await import('../../src/server/task-store.js')
    const seeded = taskStore.createTask(id, { title: 'Ship login flow' })
    taskStore.updateTask(id, seeded.id, { status: 'ready' })
    taskStore.updateTask(id, seeded.id, { status: 'assigned' })
    taskStore.updateTask(id, seeded.id, { status: 'running' })
    taskStore.updateTask(id, seeded.id, { status: 'review' })
    taskStore.updateTask(id, seeded.id, { status: 'done' })
    // Attach the PR link to that done card's journal.
    await fetch(`${server.baseUrl}/api/workspaces/${id}/tasks/${seeded.id}/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: '[PR] https://github.com/acme/widgets/pull/42' }),
    })

    // Store sync from the markdown file is watcher-driven — poll briefly.
    let doneCard: { id: string; status: string } | undefined
    for (let attempt = 0; attempt < 20 && !doneCard; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const listResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${id}/tasks?format=store`,
        { headers: { cookie } }
      )
      const listed = (await listResponse.json()) as {
        tasks: Array<{ id: string; status: string }>
      }
      doneCard = listed.tasks.find((t) => t.id === seeded.id && t.status === 'done')
    }
    expect(doneCard).toBeDefined()

    // Attach the PR link to that done card's journal.
    await fetch(`${server.baseUrl}/api/workspaces/${id}/tasks/${doneCard!.id}/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: '[PR] https://github.com/acme/widgets/pull/42' }),
    })

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/changelog?days=7`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      commits: Array<{ message: string }>
      pull_requests: Array<{ url: string }>
      markdown: string
      is_git_repo: boolean
    }

    expect(body.is_git_repo).toBe(true)
    expect(body.commits.map((c) => c.message)).toContain('feat: alpha engine wiring')
    expect(body.pull_requests[0]?.url).toContain('/pull/42')
    expect(body.markdown).toContain('## Shipped via Pull Requests')
    expect(body.markdown).toContain('feat: alpha engine wiring')
  })

  test('non-git workspace degrades gracefully', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-changelog-nogit-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'NG', path: dataDir }),
    })
    const { id } = (await wsResponse.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/changelog?days=7`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { is_git_repo: boolean; markdown: string }
    expect(body.is_git_repo).toBe(false)
  })
})
