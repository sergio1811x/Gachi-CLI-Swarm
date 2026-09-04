import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-team-model-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const wsResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Model', path: dataDir }),
  })
  expect(wsResponse.status).toBe(201)
  const { id } = (await wsResponse.json()) as { id: string }

  // Worker with a known name.
  const workerResponse = await fetch(`${server.baseUrl}/api/workspaces/${id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'alice', role: 'coder' }),
  })
  expect(workerResponse.status).toBe(201)
  const worker = (await workerResponse.json()) as { id: string }

  return {
    baseUrl: server.baseUrl,
    cookie,
    server,
    workerId: worker.id,
    workspaceId: id,
  }
}

describe('team model endpoint (orchestrator-only)', () => {
  test('worker tokens are rejected by the role gate', async () => {
    const ctx = await setup()
    // Forge a worker-caller identity against the real agent-token validator.
    const validateSpy = vi
      .spyOn(ctx.server.store, 'validateAgentToken')
      .mockImplementation((_agentId, token) => token === 'worker-token')
    void validateSpy
    // authenticateCliAgent resolves the caller through getAgent before the
    // role gate — return the real worker summary so we reach ForbiddenError.
    vi.spyOn(ctx.server.store, 'getAgent').mockImplementation((wsId, agentId) =>
      agentId === `${wsId}:${ctx.workerId}`
        ? ({
            id: ctx.workerId,
            name: 'alice',
            role: 'coder',
          } as never)
        : undefined
    )

    const response = await fetch(`${ctx.baseUrl}/api/team/model`, {
      body: JSON.stringify({
        project_id: ctx.workspaceId,
        from_agent_id: `${ctx.workspaceId}:${ctx.workerId}`,
        token: 'worker-token',
        target: 'orchestrator',
        model: 'claude-sonnet-4',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(403)
  })

  test('unknown worker surfaces a typed error', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.server.store, 'validateAgentToken').mockImplementation(
      (_agentId, token) => token === 'orch-token'
    )
    // Caller must BE the orchestrator to pass requireCommandForRole('model').
    const orchestratorId = `${ctx.workspaceId}:orchestrator`
    vi.spyOn(ctx.server.store, 'getAgent').mockImplementation((wsId, agentId) =>
      agentId === `${wsId}:orchestrator`
        ? ({
            id: orchestratorId,
            name: 'Orchestrator',
            role: 'orchestrator',
          } as never)
        : undefined
    )

    const response = await fetch(`${ctx.baseUrl}/api/team/model`, {
      body: JSON.stringify({
        project_id: ctx.workspaceId,
        from_agent_id: orchestratorId,
        token: 'orch-token',
        target: 'no-such-worker',
        model: 'any-model',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    // BadRequestError maps to 400 with the message intact.
    expect([400, 409]).toContain(response.status)
    const body = (await response.json()) as { error?: string; ok?: boolean }
    expect(body.error ?? '').toContain('Worker not found')
  })

  test('happy path delegates to agentSwitchModel and reports the result', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.server.store, 'validateAgentToken').mockImplementation(
      (_agentId, token) => token === 'orch-token'
    )
    const switchMock = vi
      .spyOn(ctx.server.store, 'agentSwitchModel')
      .mockResolvedValue({ model: 'claude-sonnet-4', restarted: false } as never)

    const response = await fetch(`${ctx.baseUrl}/api/team/model`, {
      body: JSON.stringify({
        project_id: ctx.workspaceId,
        from_agent_id: `${ctx.workspaceId}:orchestrator`,
        token: 'orch-token',
        target: 'alice',
        model: 'claude-sonnet-4',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      model: string
      restarted: boolean
      agent_id?: string
    }
    expect(body.model).toBe('claude-sonnet-4')
    expect(body.restarted).toBe(false)
    expect(switchMock).toHaveBeenCalledWith(ctx.workspaceId, ctx.workerId, 'claude-sonnet-4')
  })
})
