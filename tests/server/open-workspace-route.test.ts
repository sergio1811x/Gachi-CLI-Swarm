import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  OpenCommandResult,
  OpenWorkspaceInput,
} from '../../src/server/open-target-commands.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanup: Array<() => Promise<void>> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop()
    if (fn) await fn()
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

interface RouteHarness {
  baseUrl: string
  cookie: string
  serviceCalls: OpenWorkspaceInput[]
  workspaceId: string
  workspacePath: string
}

const startHarness = async (
  serviceResponse: OpenCommandResult | (() => OpenCommandResult)
): Promise<RouteHarness> => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-open-ws-'))
  tempDirs.push(workspacePath)

  const serviceCalls: OpenWorkspaceInput[] = []
  const server = await startTestServer({
    openWorkspaceService: async (input) => {
      serviceCalls.push(input)
      return typeof serviceResponse === 'function' ? serviceResponse() : serviceResponse
    },
  })
  cleanup.push(server.close)

  const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
  const cookie = await getUiCookie(server.baseUrl)

  return {
    baseUrl: server.baseUrl,
    cookie,
    serviceCalls,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  }
}

const postOpen = (harness: RouteHarness, body: unknown) =>
  fetch(`${harness.baseUrl}/api/workspaces/${harness.workspaceId}/open`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie: harness.cookie },
    method: 'POST',
  })

describe('POST /api/workspaces/:workspaceId/open', () => {
  test('happy path forwards the resolved workspace path to the service and returns 200', async () => {
    const harness = await startHarness({ ok: true, effectiveTargetId: 'cursor' })

    const response = await postOpen(harness, { target_id: 'cursor' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      effective_target_id: 'cursor',
    })
    expect(harness.serviceCalls).toHaveLength(1)
    expect(harness.serviceCalls[0]).toEqual({
      path: harness.workspacePath,
      targetId: 'cursor',
    })
  })

  test('unknown target id returns 400 and does not invoke the service', async () => {
    const harness = await startHarness({ ok: true, effectiveTargetId: 'vscode' })

    const response = await postOpen(harness, { target_id: 'sublime' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Unknown open target',
      target_id: 'sublime',
    })
    expect(harness.serviceCalls).toHaveLength(0)
  })

  test('missing workspace returns 404', async () => {
    const harness = await startHarness({ ok: true, effectiveTargetId: 'finder' })

    const response = await fetch(`${harness.baseUrl}/api/workspaces/does-not-exist/open`, {
      body: JSON.stringify({ target_id: 'finder' }),
      headers: { 'content-type': 'application/json', cookie: harness.cookie },
      method: 'POST',
    })

    expect(response.status).toBe(404)
    expect(harness.serviceCalls).toHaveLength(0)
  })

  test('service failure surfaces error_code at 502 and never leaks stderr to the wire', async () => {
    const harness = await startHarness({
      ok: false,
      effectiveTargetId: 'cursor',
      errorCode: 'app-not-installed',
      stderr: 'Unable to find application named "Cursor"',
    })

    const response = await postOpen(harness, { target_id: 'cursor' })

    expect(response.status).toBe(502)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual({
      ok: false,
      effective_target_id: 'cursor',
      error_code: 'app-not-installed',
    })
    // Hardening: even though the fake provided stderr, the route must NOT
    // forward it to the browser — the frontend renders i18n by error_code.
    expect(body.stderr).toBeUndefined()
  })

  test('non-string target_id is rejected with 400 before invoking the service', async () => {
    const harness = await startHarness({ ok: true, effectiveTargetId: 'finder' })

    const missing = await postOpen(harness, {})
    expect(missing.status).toBe(400)

    const wrongType = await postOpen(harness, { target_id: 42 })
    expect(wrongType.status).toBe(400)

    expect(harness.serviceCalls).toHaveLength(0)
  })

  test('missing UI cookie returns 403 without calling the service', async () => {
    const harness = await startHarness({ ok: true, effectiveTargetId: 'finder' })

    const response = await fetch(`${harness.baseUrl}/api/workspaces/${harness.workspaceId}/open`, {
      body: JSON.stringify({ target_id: 'finder' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(403)
    expect(harness.serviceCalls).toHaveLength(0)
  })
})
