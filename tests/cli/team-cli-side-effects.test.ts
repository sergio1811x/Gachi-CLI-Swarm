import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { runTeamCommand } from '../../src/cli/team.js'
import { IS_WINDOWS } from '../helpers/platform.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalEnv = { ...process.env }

const waitFor = async (
  assertion: () => void | Promise<void>,
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
  process.env = { ...originalEnv }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe.skipIf(IS_WINDOWS)('team send CLI side effects (R1.3)', () => {
  test('team send injects prompt into worker stdin, records message, bumps pending count, omits uuid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-team-cli-side-effects-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => process.stdout.write('WRK:' + chunk))",
      ].join('\n')
    )
    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env.GACH_DATA_DIR = dataDir
    const instance = await runGachiCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${instance.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, scriptPath: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${scriptPath}"`],
          }),
        })
      const startAgent = async (agentId: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ gachi_port: String(instance.port) }),
        })

      await configure(orchestratorId, orchScript)
      await configure(worker.id, workerScript)
      const orchStart = await startAgent(orchestratorId)
      expect(orchStart.status).toBe(201)
      const workerStart = await startAgent(worker.id)
      expect(workerStart.status).toBe(201)

      const orchToken = instance.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        GACH_DATA_DIR: dataDir,
        GACH_AGENT_ID: orchestratorId,
        GACH_AGENT_TOKEN: orchToken,
        GACH_PORT: String(instance.port),
        GACH_PROJECT_ID: workspace.id,
      }

      await runTeamCommand(['send', 'Alice', 'implement login'])

      await waitFor(async () => {
        const runResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
          headers: { cookie: uiCookie },
        })
        expect(runResponse.status).toBe(200)
        const team = (await runResponse.json()) as Array<{
          id: string
          pending_task_count: number
          status: string
        }>
        const aliceRow = team.find((item) => item.id === worker.id)
        expect(aliceRow?.pending_task_count).toBe(1)
        expect(aliceRow?.status).toBe('working')
      })

      const dispatch = instance.store.listDispatches(workspace.id)[0]
      expect(dispatch?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      await waitFor(async () => {
        const run = instance.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(run?.output).toContain('WRK:')
        expect(run?.output).toContain('@Orchestrator')
        expect(run?.output).toContain('Your role: ')
        expect(run?.output).toContain('implement login')
        expect(run?.output).toContain(`dispatch_id: ${dispatch?.id}`)
        expect(run?.output).toContain(`team report "<result>" --dispatch ${dispatch?.id}`)
        // The injected prompt may include the dispatch id so workers can report
        // the exact task, but it must not leak workspace or agent ids.
        const injected = (run?.output ?? '').replace(/^WRK:/gm, '')
        expect(injected).not.toContain(workspace.id)
        expect(injected).not.toContain(worker.id)
        expect(injected).not.toContain(orchestratorId)
      })

      const messages = instance.store.listMessagesForRecovery(workspace.id, 0)
      const sendMessage = messages.find(
        (item) => item.type === 'send' && item.text === 'implement login'
      )
      expect(sendMessage).toBeDefined()
      if (sendMessage && sendMessage.type === 'send') {
        expect(sendMessage.to).toBe(worker.id)
        expect(sendMessage.from).toBe(orchestratorId)
      }
    } finally {
      delete process.env.GACH_DATA_DIR
      delete process.env.GACH_DATA_DIR
      await instance.close()
    }
  })

  test('team send starts a stopped worker before injecting the task prompt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-team-cli-autostart-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const workerScript = join(workspacePath, 'worker-autostart-echo.js')
    writeFileSync(
      workerScript,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdout.write('WORKER_READY\\n')",
        "process.stdin.on('data', (chunk) => process.stdout.write('WRK:' + chunk))",
      ].join('\n')
    )
    const orchScript = join(workspacePath, 'orch-passive.js')
    writeFileSync(orchScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

    process.env.GACH_DATA_DIR = dataDir
    const instance = await runGachiCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${instance.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'AutoStart', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string, scriptPath: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${scriptPath}"`],
          }),
        })
      const startAgent = async (agentId: string) =>
        fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ gachi_port: String(instance.port) }),
        })

      await configure(orchestratorId, orchScript)
      await configure(worker.id, workerScript)
      const orchStart = await startAgent(orchestratorId)
      expect(orchStart.status).toBe(201)
      expect(instance.store.getActiveRunByAgentId(workspace.id, worker.id)).toBeUndefined()

      const orchToken = instance.store.peekAgentToken(orchestratorId)
      if (!orchToken) {
        throw new Error('Expected orchestrator token after start')
      }
      process.env = {
        ...originalEnv,
        GACH_DATA_DIR: dataDir,
        GACH_AGENT_ID: orchestratorId,
        GACH_AGENT_TOKEN: orchToken,
        GACH_PORT: String(instance.port),
        GACH_PROJECT_ID: workspace.id,
      }

      await runTeamCommand(['send', 'Alice', 'evaluate the project structure'])

      await waitFor(async () => {
        const workerRun = instance.store.getActiveRunByAgentId(workspace.id, worker.id)
        expect(workerRun).toBeDefined()
        expect(workerRun?.output).toContain('WORKER_READY')
        expect(workerRun?.output).toContain('WRK:')
        expect(workerRun?.output).toContain('evaluate the project structure')
      })

      const teamResponse = await fetch(`${baseUrl}/api/ui/workspaces/${workspace.id}/team`, {
        headers: { cookie: uiCookie },
      })
      expect(teamResponse.status).toBe(200)
      const team = (await teamResponse.json()) as Array<{
        id: string
        pending_task_count: number
        status: string
      }>
      const aliceRow = team.find((item) => item.id === worker.id)
      expect(aliceRow?.pending_task_count).toBe(1)
      expect(aliceRow?.status).toBe('working')
    } finally {
      delete process.env.GACH_DATA_DIR
      delete process.env.GACH_DATA_DIR
      await instance.close()
    }
  })
})
