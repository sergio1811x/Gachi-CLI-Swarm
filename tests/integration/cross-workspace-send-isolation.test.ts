import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { IS_WINDOWS } from '../helpers/platform.js'

const tempDirs: string[] = []

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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe.skipIf(IS_WINDOWS)('cross workspace send isolation', () => {
  test('team send Alice reaches only the current workspace Alice run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-send-isolation-'))
    tempDirs.push(dataDir)
    process.env.GACH_DATA_DIR = dataDir
    const instance = await runGachiCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${instance.port}`
      const uiSessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const uiCookie = uiSessionResponse.headers.get('set-cookie')
      if (!uiCookie) {
        throw new Error('Expected UI session cookie')
      }
      const workspaceAPath = join(dataDir, 'workspace-a')
      const workspaceBPath = join(dataDir, 'workspace-b')
      mkdirSync(workspaceAPath, { recursive: true })
      mkdirSync(workspaceBPath, { recursive: true })

      const workerScriptA = join(workspaceAPath, 'echo-a.js')
      const workerScriptB = join(workspaceBPath, 'echo-b.js')
      writeFileSync(
        workerScriptA,
        "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('A:' + c))\n"
      )
      writeFileSync(
        workerScriptB,
        "process.stdin.setEncoding('utf8')\nprocess.stdin.on('data', c => process.stdout.write('B:' + c))\n"
      )

      const createWorkspace = async (name: string, path: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name, path }),
        })
        return (await response.json()) as { id: string }
      }

      const a = await createWorkspace('A', workspaceAPath)
      const b = await createWorkspace('B', workspaceBPath)

      const addWorker = async (workspaceId: string) => {
        const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({ name: 'Alice', role: 'coder' }),
        })
        return (await response.json()) as { id: string }
      }

      const workerA = await addWorker(a.id)
      const workerB = await addWorker(b.id)

      const config = async (workspaceId: string, agentId: string, scriptPath: string) => {
        await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: uiCookie },
          body: JSON.stringify({
            command: '/bin/bash',
            args: ['-lc', `"${process.execPath}" "${scriptPath}"`],
          }),
        })
      }

      await config(a.id, workerA.id, workerScriptA)
      await config(b.id, workerB.id, workerScriptB)
      await config(a.id, `${a.id}:orchestrator`, workerScriptA)

      const start = async (workspaceId: string, agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ gachi_port: String(instance.port) }),
          }
        )
        const payload = (await response.json()) as { run_id: string }
        return { runId: payload.run_id }
      }

      const runA = await start(a.id, workerA.id)
      const runB = await start(b.id, workerB.id)
      await start(a.id, `${a.id}:orchestrator`)

      await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: a.id,
          from_agent_id: `${a.id}:orchestrator`,
          token: instance.store.peekAgentToken(`${a.id}:orchestrator`),
          to: 'Alice',
          text: 'implement login',
        }),
      })

      await waitFor(
        async () => {
          const responseA = await fetch(`${baseUrl}/api/runtime/runs/${runA.runId}`, {
            headers: { cookie: uiCookie },
          })
          const responseB = await fetch(`${baseUrl}/api/runtime/runs/${runB.runId}`, {
            headers: { cookie: uiCookie },
          })
          const bodyA = (await responseA.json()) as { output: string }
          const bodyB = (await responseB.json()) as { output: string }

          expect(bodyA.output).toContain('A:')
          expect(bodyA.output).toContain('@Orchestrator')
          expect(bodyA.output).toContain('implement login')
          expect(bodyB.output).not.toContain('implement login')
        },
        2000,
        25
      )
    } finally {
      delete process.env.GACH_DATA_DIR
      delete process.env.GACH_DATA_DIR
      await instance.close()
    }
  })
})
