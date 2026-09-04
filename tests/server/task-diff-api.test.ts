import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const exec = promisify(execFile)

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

interface TestContext {
  baseUrl: string
  cookie: string
  dataDir: string
  workspaceId: string
}

const setup = async (workspacePath: string): Promise<TestContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-task-diff-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const createResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'Diff',
      path: workspacePath,
    }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { id: string }

  // A card must exist for the diff endpoint's task validation.
  const taskResponse = await fetch(`${server.baseUrl}/api/workspaces/${created.id}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'review me', description: 'diff fixture' }),
  })
  expect(taskResponse.status).toBe(201)
  void taskResponse

  return { baseUrl: server.baseUrl, cookie, dataDir, workspaceId: created.id }
}

const fetchFirstTaskId = async (ctx: TestContext): Promise<string> => {
  const response = await fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks?format=store`,
    { headers: { cookie: ctx.cookie } }
  )
  const body = (await response.json()) as {
    tasks?: Array<{ id: string }>
  }
  const first = body.tasks?.[0]?.id
  if (!first) throw new Error('fixture task was not created')
  return first
}

describe('task diff endpoint (roadmap Wave 1)', () => {
  test('returns unified diff against HEAD plus untracked files', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'gachi-diff-repo-'))
    tempDirs.push(repoPath)
    const git = async (...args: string[]) => exec('git', args, { cwd: repoPath })

    await git('init')
    await git('config', 'user.email', 'test@local')
    await git('config', 'user.name', 'Test')
    writeFileSync(join(repoPath, 'tracked.txt'), 'line one\nline two\n', 'utf8')
    await git('add', '.')
    await git('commit', '-m', 'init')

    // Worker-style changes: edit tracked file, add an untracked one.
    writeFileSync(join(repoPath, 'tracked.txt'), 'line one\nCHANGED\n', 'utf8')
    writeFileSync(join(repoPath, 'new-file.md'), 'created by worker\n', 'utf8')

    const ctx = await setup(repoPath)
    const taskId = await fetchFirstTaskId(ctx)

    const response = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${taskId}/diff`,
      { headers: { cookie: ctx.cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      branch?: string | null
      clean?: boolean
      diff?: string
      truncated?: boolean
      untrackedFiles?: string[]
      error?: string
    }

    expect(body.ok).toBe(true)
    expect(typeof body.branch).toBe('string')
    expect(body.clean).toBe(false)
    expect(body.diff).toContain('-line two')
    expect(body.diff).toContain('+CHANGED')
    expect(body.truncated).toBe(false)
    expect(body.untrackedFiles).toContain('new-file.md')
  }, 30_000)

  test('reports a typed unavailable result for a non-git directory', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'gachi-diff-plain-'))
    tempDirs.push(plainDir)
    const ctx = await setup(plainDir)
    const taskId = await fetchFirstTaskId(ctx)

    const response = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${taskId}/diff`,
      { headers: { cookie: ctx.cookie } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
  })
})
