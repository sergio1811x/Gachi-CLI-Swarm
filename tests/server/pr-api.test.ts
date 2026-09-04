import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  BranchPrInput,
  CreatedPr,
  GhStatus,
  OpenPrSummary,
} from '../../src/server/github-pr.js'
import { GhError } from '../../src/server/github-pr.js'
import type { PrService } from '../../src/server/route-types.js'
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

/** Fake PrService recording every call — the real HTTP boundary stays live. */
const fakePrService = (options?: {
  installed?: boolean
  authed?: boolean
  createError?: string
}) => {
  const calls: Array<{ kind: 'create' | 'status' | 'list'; branch?: string }> = []
  const service: PrService & { calls: typeof calls } = Object.assign(
    {
      checkStatus(_cwd: string): GhStatus {
        calls.push({ kind: 'status' })
        return options?.installed === false
          ? { authed: false, error: 'gh CLI not found on PATH', installed: false }
          : { authed: options?.authed ?? true, error: null, installed: true }
      },
      create(input: BranchPrInput): CreatedPr {
        calls.push({ branch: input.branch, kind: 'create' })
        if (options?.createError) {
          // Mirror production: github-pr throws typed GhError failures.
          throw new GhError('git_failed', options.createError)
        }
        return { number: 42, url: `https://github.com/acme/widgets/pull/42?head=${input.branch}` }
      },
      list(_cwd: string): OpenPrSummary[] {
        calls.push({ kind: 'list' })
        return [
          {
            head: 'gachi/worker-a',
            number: 7,
            state: 'OPEN',
            title: 'Worker A changes',
            url: 'https://github.com/acme/widgets/pull/7',
          },
        ]
      },
    },
    {}
  )
  return { calls, service }
}

describe('github pr flow (roadmap Wave 2)', () => {
  test('status reports availability and lists open PRs', async () => {
    const { service } = fakePrService()
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pr-status-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir, prService: service })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const ws = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'S', path: dataDir }),
    })
    const { id } = (await ws.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      error: string | null
      installed: boolean
      open_prs: Array<{ number: number; url: string }>
    }
    expect(body.installed).toBe(true)
    expect(body.open_prs).toHaveLength(1)
    expect(body.open_prs[0]?.number).toBe(7)
  })

  test('status degrades gracefully when gh is not installed', async () => {
    const { service } = fakePrService({ installed: false })
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pr-noghi-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir, prService: service })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const ws = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'N', path: dataDir }),
    })
    const { id } = (await ws.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr/status`, {
      headers: { cookie },
    })
    const body = (await response.json()) as { installed: boolean; open_prs: unknown[] }
    expect(body.installed).toBe(false)
    expect(body.open_prs).toEqual([])
  })

  test('POST /pr publishes an explicit branch and returns the PR url', async () => {
    const { calls, service } = fakePrService()
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pr-create-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir, prService: service })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const ws = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'C', path: dataDir }),
    })
    const { id } = (await ws.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr`, {
      body: JSON.stringify({
        body: 'What was done:\n- feature',
        branch: 'gachi/worker-x',
        title: 'Worker X: feature',
      }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { ok: boolean; url: string }
    expect(body.ok).toBe(true)
    expect(body.url).toContain('/pull/42')

    const createCall = calls.find((c) => c.kind === 'create')
    expect(createCall?.branch).toBe('gachi/worker-x')
  })

  test('POST /pr without branch or agent_id is a 400', async () => {
    const { calls, service } = fakePrService()
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pr-badreq-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir, prService: service })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const ws = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'B', path: dataDir }),
    })
    const { id } = (await ws.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr`, {
      body: JSON.stringify({ title: 'no branch given' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(response.status).toBe(400)
    expect(calls.find((c) => c.kind === 'create')).toBeUndefined()
  })

  test('gh failures surface as 409 with a kind discriminator', async () => {
    const { service } = fakePrService({ createError: 'git push failed: rejected' })
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-pr-fail-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir, prService: service })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const ws = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ autostart_orchestrator: false, name: 'F', path: dataDir }),
    })
    const { id } = (await ws.json()) as { id: string }

    const response = await fetch(`${server.baseUrl}/api/workspaces/${id}/pr`, {
      body: JSON.stringify({ branch: 'gachi/broken' }),
      headers: { 'content-type': 'application/json', cookie },
      method: 'POST',
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; ok: boolean }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('rejected')
  })
})
