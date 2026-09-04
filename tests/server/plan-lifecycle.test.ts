import { mkdtempSync, rmSync } from 'node:fs'
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

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gachi-plan-'))
  tempDirs.push(dataDir)
  const server = await startTestServer({ dataDir })
  servers.push(server)
  const cookie = await getUiCookie(server.baseUrl)
  const createResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Plan', path: dataDir }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { id: string }
  return { baseUrl: server.baseUrl, cookie, server, workspaceId: created.id }
}

describe('plan draft lifecycle (ROADMAP R2)', () => {
  test('plan creates a grouped backlog draft; approve promotes it to ready', async () => {
    const ctx = await setup()

    const planResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/plan`,
      {
        body: JSON.stringify({ title: 'Build the login page', description: 'OAuth + password' }),
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        method: 'POST',
      }
    )
    expect(planResponse.status).toBe(201)
    const plan = (await planResponse.json()) as {
      plan_group_id: string
      tasks: Array<{ id: string; status: string; dependencies: string[] }>
    }

    // Draft lands in backlog as one dependency-linked group.
    expect(plan.plan_group_id).toBeTruthy()
    expect(plan.tasks.length).toBeGreaterThanOrEqual(4)
    expect(new Set(plan.tasks.map((t) => t.status))).toEqual(new Set(['backlog']))

    const approveResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/plans/${plan.plan_group_id}/approve`,
      { headers: { 'content-type': 'application/json', cookie: ctx.cookie }, method: 'POST' }
    )
    expect(approveResponse.status).toBe(200)
    const approved = (await approveResponse.json()) as { approved: number; total: number }
    expect(approved.approved).toBe(approved.total)

    for (const task of plan.tasks) {
      const response = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${task.id}`,
        {
          headers: { cookie: ctx.cookie },
        }
      )
      const body = (await response.json()) as { task?: { status?: string } }
      expect(body.task?.status).toBe('ready')
    }
  })

  test('discard deletes only still-backlog cards of the group', async () => {
    const ctx = await setup()
    const planResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/plan`,
      {
        body: JSON.stringify({ title: 'Refactor auth' }),
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        method: 'POST',
      }
    )
    const plan = (await planResponse.json()) as {
      plan_group_id: string
      tasks: Array<{ id: string; status: string }>
    }

    // Human already promoted one card — discard must keep it.
    const promoted = plan.tasks[0]?.id
    if (!promoted) throw new Error('fixture task missing')
    const patch = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${promoted}`,
      {
        body: JSON.stringify({ status: 'ready' }),
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        method: 'PATCH',
      }
    )
    expect(patch.status).toBe(200)

    const discardResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/plans/${plan.plan_group_id}`,
      { headers: { cookie: ctx.cookie }, method: 'DELETE' }
    )
    expect(discardResponse.status).toBe(200)
    const result = (await discardResponse.json()) as { deleted: number; kept: number }
    expect(result.deleted).toBe(plan.tasks.length - 1)
    expect(result.kept).toBe(1)

    const keptResponse = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/tasks/${promoted}`,
      {
        headers: { cookie: ctx.cookie },
      }
    )
    expect((await keptResponse.json()) as { task: unknown }).toBeDefined()
  })

  test('404 for an unknown plan group', async () => {
    const ctx = await setup()
    const response = await fetch(
      `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/plans/00000000-0000-4000-8000-000000000000/approve`,
      { headers: { 'content-type': 'application/json', cookie: ctx.cookie }, method: 'POST' }
    )
    expect(response.status).toBe(404)
  })
})
