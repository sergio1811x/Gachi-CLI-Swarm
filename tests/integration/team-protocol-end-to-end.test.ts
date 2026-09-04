import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { IS_WINDOWS } from '../helpers/platform.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => Promise<void> | void,
  timeoutMs = 2000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw lastError
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe.skipIf(IS_WINDOWS)('team protocol end to end', () => {
  test('real gachi runtime records send/report messages and updates worker status', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-team-e2e-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'dummy-worker.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('WORKER:' + chunk)",
        '})',
      ].join('\n')
    )

    const orchScript = join(workspacePath, 'dummy-orch.js')
    writeFileSync(
      orchScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('ORCH:' + chunk)",
        '})',
      ].join('\n')
    )

    process.env.GACH_DATA_DIR = dataDir
    const instance = await runGachiCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${instance.port}`
      const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const cookie = sessionResponse.headers.get('set-cookie')
      if (!cookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      const orchConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${orchScript}"`],
          }),
        }
      )
      expect(orchConfig.status).toBe(204)

      const workerConfig = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${workerScript}"`],
          }),
        }
      )
      expect(workerConfig.status).toBe(204)

      const orchStart = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ gachi_port: String(instance.port) }),
        }
      )
      expect(orchStart.status).toBe(201)

      const workerStart = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ gachi_port: String(instance.port) }),
        }
      )
      expect(workerStart.status).toBe(201)
      const workerStartBody = (await workerStart.json()) as { run_id: string }

      const sendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: instance.store.peekAgentToken(orchestratorId),
          to: 'Alice',
          text: 'implement login endpoint',
        }),
      })
      expect(sendResponse.status).toBe(202)
      const sendBody = (await sendResponse.json()) as { dispatch_id: string; ok: true }
      expect(sendBody.dispatch_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )

      await waitFor(async () => {
        const workerRunResponse = await fetch(
          `${baseUrl}/api/runtime/runs/${workerStartBody.run_id}`,
          { headers: { cookie } }
        )
        const body = (await workerRunResponse.json()) as { output: string }
        expect(body.output).toContain(`dispatch_id: ${sendBody.dispatch_id}`)
        expect(body.output).toContain(`team report "<result>" --dispatch ${sendBody.dispatch_id}`)
      })

      const activeDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
        { headers: { cookie } }
      )
      expect(activeDispatchesResponse.status).toBe(200)
      const activeDispatches = (await activeDispatchesResponse.json()) as Array<{
        id: string
        workspace_id: string
        from_agent_id: string
        to_agent_id: string
        state: string
        text: string
        report_text: string | null
        artifacts: string[]
      }>
      expect(activeDispatches).toEqual([
        expect.objectContaining({
          id: sendBody.dispatch_id,
          workspace_id: workspace.id,
          from_agent_id: orchestratorId,
          to_agent_id: worker.id,
          state: 'submitted',
          text: 'implement login endpoint',
          report_text: null,
          artifacts: [],
        }),
      ])
      const anonymousDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`
      )
      expect(anonymousDispatchesResponse.status).toBe(403)

      const secondSendResponse = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: instance.store.peekAgentToken(orchestratorId),
          to: 'Alice',
          text: 'add more tests',
        }),
      })
      expect(secondSendResponse.status).toBe(202)
      const secondSendBody = (await secondSendResponse.json()) as {
        dispatch_id: string
        ok: true
      }

      const reportResponse = await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: worker.id,
          token: instance.store.peekAgentToken(worker.id),
          result: 'additional tests completed',
          dispatch_id: secondSendBody.dispatch_id,
          artifacts: ['tests/auth.test.ts'],
        }),
      })
      expect(reportResponse.status).toBe(202)
      const reportBody = (await reportResponse.json()) as { dispatch_id: string; ok: true }
      expect(reportBody.dispatch_id).toBe(secondSendBody.dispatch_id)

      const cancelResponse = await fetch(`${baseUrl}/api/team/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: orchestratorId,
          token: instance.store.peekAgentToken(orchestratorId),
          dispatch_id: sendBody.dispatch_id,
          reason: 'direction changed, login endpoint task cancelled',
        }),
      })
      expect(cancelResponse.status).toBe(202)
      const cancelBody = (await cancelResponse.json()) as { dispatch_id: string; ok: true }
      expect(cancelBody.dispatch_id).toBe(sendBody.dispatch_id)

      const reportedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches`,
        { headers: { cookie } }
      )
      expect(reportedDispatchesResponse.status).toBe(200)
      const reportedDispatches = (await reportedDispatchesResponse.json()) as Array<{
        id: string
        state: string
        report_text: string | null
        artifacts: string[]
      }>
      expect(reportedDispatches).toEqual([
        expect.objectContaining({
          id: sendBody.dispatch_id,
          state: 'cancelled',
          report_text: 'direction changed, login endpoint task cancelled',
          artifacts: [],
        }),
        expect.objectContaining({
          id: secondSendBody.dispatch_id,
          state: 'reported',
          report_text: 'additional tests completed',
          artifacts: ['tests/auth.test.ts'],
        }),
      ])

      const pagedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?limit=1&offset=1`,
        { headers: { cookie } }
      )
      expect(pagedDispatchesResponse.status).toBe(200)
      const pagedDispatches = (await pagedDispatchesResponse.json()) as Array<{ id: string }>
      expect(pagedDispatches).toEqual([expect.objectContaining({ id: secondSendBody.dispatch_id })])

      const submittedDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=submitted`,
        { headers: { cookie } }
      )
      expect(submittedDispatchesResponse.status).toBe(200)
      const submittedDispatches = (await submittedDispatchesResponse.json()) as Array<{
        id: string
        state: string
      }>
      expect(submittedDispatches).toEqual([])

      const cancelledDispatchesResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=cancelled`,
        { headers: { cookie } }
      )
      expect(cancelledDispatchesResponse.status).toBe(200)
      const cancelledDispatches = (await cancelledDispatchesResponse.json()) as Array<{
        id: string
        state: string
      }>
      expect(cancelledDispatches).toEqual([
        expect.objectContaining({ id: sendBody.dispatch_id, state: 'cancelled' }),
      ])

      const invalidStateResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?state=working`,
        { headers: { cookie } }
      )
      expect(invalidStateResponse.status).toBe(400)

      const deprecatedStatusResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?status=submitted`,
        { headers: { cookie } }
      )
      expect(deprecatedStatusResponse.status).toBe(400)

      const malformedLimitResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?limit=1abc`,
        { headers: { cookie } }
      )
      expect(malformedLimitResponse.status).toBe(400)

      const hugeOffsetResponse = await fetch(
        `${baseUrl}/api/ui/workspaces/${workspace.id}/dispatches?offset=999999999999999999999`,
        { headers: { cookie } }
      )
      expect(hugeOffsetResponse.status).toBe(400)

      const cancelledReportResponse = await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspace.id,
          from_agent_id: worker.id,
          token: instance.store.peekAgentToken(worker.id),
          result: 'login endpoint completed',
          dispatch_id: sendBody.dispatch_id,
          artifacts: ['src/auth.ts'],
        }),
      })
      expect(cancelledReportResponse.status).toBe(409)

      await waitFor(async () => {
        const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
          headers: { cookie },
        })
        expect(teamResponse.status).toBe(200)
        const team = (await teamResponse.json()) as Array<{
          id: string
          pending_task_count: number
          status: string
        }>

        expect(team).toContainEqual(
          expect.objectContaining({
            id: worker.id,
            pending_task_count: 0,
            status: 'idle',
          })
        )
      })

      const runtimeStore = createRuntimeStore({ dataDir })
      const persistedDispatches = runtimeStore.listDispatches(workspace.id)
      expect(persistedDispatches).toEqual([
        expect.objectContaining({
          id: sendBody.dispatch_id,
          reportText: 'direction changed, login endpoint task cancelled',
          status: 'cancelled',
        }),
        expect.objectContaining({
          id: secondSendBody.dispatch_id,
          reportText: 'additional tests completed',
          status: 'reported',
        }),
      ])
      const messages = runtimeStore.listMessagesForRecovery(workspace.id, 0)
      expect(messages).toHaveLength(3)
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'send', to: worker.id, text: 'implement login endpoint' })
      )
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'send', to: worker.id, text: 'add more tests' })
      )
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'report',
          from: worker.id,
          text: 'additional tests completed',
        })
      )
      const report = messages.find((message) => message.type === 'report')
      expect(report).not.toHaveProperty('status')
      await runtimeStore.close()
    } finally {
      delete process.env.GACH_DATA_DIR
      delete process.env.GACH_DATA_DIR
      await instance.close()
    }
  })
})
