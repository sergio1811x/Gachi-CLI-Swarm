import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
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

interface TestContext {
  agentId: string
  baseUrl: string
  cookie: string
  store: ReturnType<typeof createRuntimeStore>
  workspaceId: string
}

const setup = async (): Promise<TestContext> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-agent-control-'))
  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  tempDirs.push(dataDir)

  const store = createRuntimeStore({ dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'Control')
  const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
  if (!orchestrator) {
    throw new Error('Expected default orchestrator')
  }

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

  return {
    agentId: orchestrator.id,
    baseUrl,
    cookie,
    store,
    workspaceId: workspace.id,
  }
}

const postControl = async (
  ctx: TestContext,
  segment: string,
  body: Record<string, unknown>
): Promise<Response> =>
  fetch(
    `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/control/${segment}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify(body),
    }
  )

describe('agent control plane api', () => {
  test('GET /api/agents/capabilities lists engines with snake_case features', async () => {
    const ctx = await setup()
    const response = await fetch(`${ctx.baseUrl}/api/agents/capabilities`, {
      headers: { cookie: ctx.cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      capabilities: Array<{ provider: string; features: Record<string, boolean> }>
    }
    const claude = body.capabilities.find((record) => record.provider === 'claude')
    expect(claude?.features.model_switch).toBe(true)
    expect(claude?.features.context_control).toBe(true)

    const agy = body.capabilities.find((record) => record.provider === 'agy')
    // agy carries a control profile now (compress + -m model arg).
    expect(agy?.features.model_switch).toBe(true)
  })

  test('switching the model persists it in launch args and reports state', async () => {
    const ctx = await setup()
    const configResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ command: 'claude' }),
      }
    )
    expect(configResponse.status).toBe(204)

    const switchResponse = await postControl(ctx, 'model', { model: 'opus' })
    expect(switchResponse.status).toBe(200)
    expect(await switchResponse.json()).toEqual({ model: 'opus', restarted: false })

    const stored = ctx.store.peekAgentLaunchConfig(ctx.workspaceId, ctx.agentId)
    expect(stored?.args).toEqual(['--model', 'opus'])

    const stateResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/control`,
      { headers: { cookie: ctx.cookie } }
    )
    expect(stateResponse.status).toBe(200)
    const state = (await stateResponse.json()) as {
      capability: null | { provider: string; suggested_models: string[] }
      model: null
      provider: null
      running: boolean
    }
    expect(state.model).toBe('opus')
    expect(state.provider).toBe('claude')
    expect(state.running).toBe(false)
    expect(state.capability?.suggested_models.length ?? 0).toBeGreaterThan(0)
  })

  test('model switch replaces a previous pin instead of stacking flags', async () => {
    const ctx = await setup()
    await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ command: 'claude' }),
    })

    expect((await postControl(ctx, 'model', { model: 'sonnet' })).status).toBe(200)
    expect((await postControl(ctx, 'model', { model: 'haiku' })).status).toBe(200)

    const stored = ctx.store.peekAgentLaunchConfig(ctx.workspaceId, ctx.agentId)
    expect(stored?.args).toEqual(['--model', 'haiku'])
  })

  test('reasoning switch works for codex and rejects unsupported levels', async () => {
    const ctx = await setup()
    await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ command_preset_id: 'codex' }),
    })

    const ok = await postControl(ctx, 'reasoning', { level: 'high' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ level: 'high', restarted: false })
    let stored = ctx.store.peekAgentLaunchConfig(ctx.workspaceId, ctx.agentId)
    expect(stored?.args).toContain('model_reasoning_effort=high')

    // Codex cannot express VERY_HIGH — a typed conflict, not a silent no-op.
    const unsupported = await postControl(ctx, 'reasoning', { level: 'VERY_HIGH' })
    expect(unsupported.status).toBe(409)

    // Claude has no reasoning flags at all.
    await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ command: 'claude' }),
    })
    const noSupport = await postControl(ctx, 'reasoning', { level: 'low' })
    expect(noSupport.status).toBe(409)
    stored = ctx.store.peekAgentLaunchConfig(ctx.workspaceId, ctx.agentId)
    expect(stored?.args).not.toContain('model_reasoning_effort=low')
  })

  test('context actions require a live run and an engine that supports them', async () => {
    const ctx = await setup()
    await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ command: 'claude' }),
    })

    const notRunning = await postControl(ctx, 'context', { action: 'compact' })
    expect(notRunning.status).toBe(409)

    const badAction = await postControl(ctx, 'context', { action: 'wipe' })
    expect(badAction.status).toBe(400)
  })

  test('control endpoints reject requests without a UI session', async () => {
    const ctx = await setup()
    const response = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/agents/${ctx.agentId}/control`,
      { method: 'GET' }
    )
    expect(response.status).toBe(403)
  })
})
