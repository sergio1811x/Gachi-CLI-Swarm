import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { taskStore } from '../../src/server/task-store.js'
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

interface TestContext {
  baseUrl: string
  cookie: string
  dataDir: string
  server: Awaited<ReturnType<typeof startTestServer>>
  workspaceId: string
}

const setup = async (): Promise<TestContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-telegram-api-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const response = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'TG', path: workspacePath }),
  })
  expect(response.status).toBe(201)
  const workspace = (await response.json()) as { id: string }

  return { baseUrl: server.baseUrl, cookie, dataDir, server, workspaceId: workspace.id }
}

/** Starts a real worker run (long-lived node process) and returns its minted token. */
const startWorkerWithToken = async (
  ctx: TestContext,
  workerName = 'Alice'
): Promise<{ taskId: string; token: string; workerId: string }> => {
  const workerResponse = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ autostart: false, name: workerName, role: 'coder' }),
  })
  expect(workerResponse.status).toBe(201)
  const worker = (await workerResponse.json()) as { id: string }

  // Start the worker with a harmless long-lived node process so the runtime
  // mints its agent token (tokens exist only for started runs).
  const workerScript = join(ctx.dataDir, `worker-${worker.id}.js`)
  writeFileSync(workerScript, 'process.stdin.resume(); setTimeout(() => {}, 120000)\n', 'utf8')
  await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${worker.id}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ctx.cookie },
    body: JSON.stringify({ command: process.execPath, args: [workerScript] }),
  })
  const start = await fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ gachi_port: '0' }),
    }
  )
  expect(start.status).toBe(201)
  const token = ctx.server.store.peekAgentToken(worker.id) ?? ''
  expect(token).not.toBe('')

  // Give the worker an in-flight task so requests bind to its card.
  await ctx.server.store.dispatchTask(ctx.workspaceId, worker.id, 'audit the runtime', {})
  const assigned = taskStore.getAssignedTaskForWorker(ctx.workspaceId, worker.id)
  const taskId = assigned?.id ?? ''

  return { taskId, token, workerId: worker.id }
}

const postTeamRequest = async (ctx: TestContext, workerId: string, token: string) =>
  fetch(`${ctx.baseUrl}/api/team/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: ctx.workspaceId,
      from_agent_id: workerId,
      token,
      command: 'npm install left-pad',
      reason: 'needed for tests',
    }),
  })

describe('telegram control plane api', () => {
  test('settings round-trip: save config, generate pairing code', async () => {
    const ctx = await setup()

    const initial = await fetch(`${ctx.baseUrl}/api/settings/telegram`, {
      headers: { cookie: ctx.cookie },
    })
    expect(initial.status).toBe(200)
    const initialBody = (await initial.json()) as {
      config: { enabled: boolean; tokenSet: boolean }
      links: unknown[]
      available_events: string[]
    }
    expect(initialBody.config.enabled).toBe(false)
    expect(initialBody.config.tokenSet).toBe(false)
    expect(initialBody.links).toEqual([])
    expect(initialBody.available_events).toContain('approval_required')

    const save = await fetch(`${ctx.baseUrl}/api/settings/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ enabled: true }),
    })
    expect(save.status).toBe(200)

    const pairing = await fetch(`${ctx.baseUrl}/api/settings/telegram/pairing`, {
      method: 'POST',
      headers: { cookie: ctx.cookie },
    })
    expect(pairing.status).toBe(201)
    const pairingBody = (await pairing.json()) as { code: string; expires_at: number }
    expect(pairingBody.code).toMatch(/^\d{6}$/)
    expect(pairingBody.expires_at).toBeGreaterThan(Date.now())

    const afterSave = await fetch(`${ctx.baseUrl}/api/settings/telegram`, {
      headers: { cookie: ctx.cookie },
    })
    const afterBody = (await afterSave.json()) as { config: { enabled: boolean } }
    expect(afterBody.config.enabled).toBe(true)
  })

  test('agent permission request creates a pending approval bound to the task journal', async () => {
    const ctx = await setup()
    const { token, workerId } = await startWorkerWithToken(ctx)

    const response = await postTeamRequest(ctx, workerId, token)
    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      ok: true
      request_id: string
      status: string
      task_id: null | string
    }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('pending')

    const list = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/approvals`, {
      headers: { cookie: ctx.cookie },
    })
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as {
      approvals: Array<{ command: string; id: string; task_id: null | string }>
    }
    const created = listBody.approvals.find((item) => item.id === body.request_id)
    expect(created?.command).toBe('npm install left-pad')
  })

  test('deciding an approval persists the verdict and rejects double-decisions', async () => {
    const ctx = await setup()
    const created = ctx.server.store.createApprovalRequest({
      agentId: `${ctx.workspaceId}:orchestrator`,
      command: 'rm -rf node_modules',
      workspaceId: ctx.workspaceId,
    })

    const approve = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/approvals/${created.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ decision: 'approved' }),
      }
    )
    expect(approve.status).toBe(200)
    expect(await approve.json()).toEqual({
      ok: true,
      request_id: created.id,
      status: 'approved',
    })

    // Already decided → conflict.
    const again = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/approvals/${created.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ decision: 'denied' }),
      }
    )
    expect(again.status).toBe(409)
  })

  test('team request requires agent authentication', async () => {
    const ctx = await setup()
    const response = await fetch(`${ctx.baseUrl}/api/team/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: ctx.workspaceId,
        from_agent_id: `${ctx.workspaceId}:orchestrator`,
        token: 'wrong-token',
        command: 'npm install evil',
      }),
    })
    expect([401, 403]).toContain(response.status)
  })

  test('permission requests are cooldown limited per agent (audit L-1)', async () => {
    const ctx = await setup()
    const { workerId, token } = await startWorkerWithToken(ctx)

    const first = await postTeamRequest(ctx, workerId, token)
    expect(first.status).toBe(202)

    const second = await postTeamRequest(ctx, workerId, token)
    expect(second.status).toBe(429)
    const body = (await second.json()) as { error_code?: string; error?: string }
    expect(body.error_code).toBe('rate_limited')
    expect(body.error).toContain('rate limited')
  })

  test('an agent with too many pending requests is capped (audit L-1)', async () => {
    const ctx = await setup()
    const { workerId, token } = await startWorkerWithToken(ctx)

    for (let index = 0; index < 5; index += 1) {
      ctx.server.store.createApprovalRequest({
        agentId: workerId,
        command: `cmd-${index}`,
        workspaceId: ctx.workspaceId,
      })
    }

    const response = await postTeamRequest(ctx, workerId, token)
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error_code?: string; error?: string }
    expect(body.error_code).toBe('rate_limited')
    expect(body.error).toContain('Too many pending')
  })

  test('expired approvals flip durably and journal the verdict for the worker (audit M-4)', {
    timeout: 40_000,
  }, async () => {
    const ctx = await setup()
    const { taskId, token, workerId } = await startWorkerWithToken(ctx)

    // Shrink the approval TTL through the settings API so any read expires it.
    const ttlResponse = await fetch(`${ctx.baseUrl}/api/settings/app-state/approval_ttl_ms`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ value: '1000' }),
    })
    expect(ttlResponse.status).toBe(204)

    const created = await postTeamRequest(ctx, workerId, token)
    expect(created.status).toBe(202)
    const { request_id: requestId } = (await created.json()) as { request_id: string }

    // Any approval read triggers expireStale → the wiring layer journals the
    // `[APPROVAL EXPIRED]` verdict so the waiting worker learns the outcome.
    const deadline = Date.now() + 5000
    let journalLine: string | undefined
    let expiredStatus = false
    while (Date.now() < deadline) {
      await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/approvals`, {
        headers: { cookie: ctx.cookie },
      })
      const pendingList = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/approvals`,
        { headers: { cookie: ctx.cookie } }
      )
      const pendingBody = (await pendingList.json()) as { approvals: Array<{ id: string }> }
      if (!pendingBody.approvals.some((item) => item.id === requestId)) expiredStatus = true

      const taskResponse = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${taskId}`,
        { headers: { cookie: ctx.cookie } }
      )
      const taskBody = (await taskResponse.json()) as {
        task: { logs: Array<{ message?: string } | string> | string[] }
      }
      const logs = Array.isArray(taskBody.task.logs) ? taskBody.task.logs : []
      for (const log of logs) {
        const message = typeof log === 'string' ? log : String(log)
        if (message.includes('[APPROVAL EXPIRED]')) {
          journalLine = message
          break
        }
      }
      if (journalLine && expiredStatus) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    expect(expiredStatus).toBe(true)
    expect(journalLine).toBeDefined()
    expect(journalLine).toContain(requestId.slice(0, 8))
  })
})
