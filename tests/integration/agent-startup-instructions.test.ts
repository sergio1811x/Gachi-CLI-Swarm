import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runGachiCommand } from '../../src/cli/gachi.js'
import { IS_WINDOWS } from '../helpers/platform.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
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
  delete process.env.GACH_DATA_DIR
  delete process.env.GACH_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe.skipIf(IS_WINDOWS)('agent startup instructions', () => {
  test('new orchestrator and worker runs receive team command guidance over real PTY stdin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-agent-startup-instructions-'))
    const workspacePath = join(dataDir, 'workspace')
    const binDir = join(dataDir, 'bin')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    tempDirs.push(dataDir)

    const fakeClaude = join(binDir, 'claude')
    writeFileSync(
      fakeClaude,
      [
        '#!/usr/bin/env node',
        "process.stdin.setEncoding('utf8')",
        'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
        'let submitReadyAt = 0',
        "process.stdout.write('❯ ')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        "  if (chunk.includes('\\u001b[201~')) {",
        "    process.stdout.write('\\n[Pasted text #1 +1 lines]\\n')",
        '    submitReadyAt = Date.now() + 500',
        '  }',
        "  const isSubmit = submitReadyAt > 0 && (chunk === '\\r' || chunk === '\\n' || chunk === '\\r\\n')",
        "  if (isSubmit && Date.now() >= submitReadyAt) process.stdout.write('\\nSUBMITTED\\n❯ ')",
        "  else if (isSubmit) process.stdout.write('\\nEARLY_ENTER_IGNORED\\n❯ ')",
        '})',
        'process.stdin.resume()',
      ].join('\n')
    )
    chmodSync(fakeClaude, 0o755)

    process.env.GACH_DATA_DIR = dataDir
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    const instance = await runGachiCommand(['--port', '0'])

    try {
      const baseUrl = `http://127.0.0.1:${instance.port}`
      const uiCookie = await getUiCookie(baseUrl)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const orchestratorId = `${workspace.id}:orchestrator`

      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart: false, name: 'Alice', role: 'coder' }),
      })
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as { id: string }

      const configure = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/config`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({
              command: 'claude',
              args: [],
            }),
          }
        )
        expect(response.status).toBe(204)
      }
      const start = async (agentId: string) => {
        const response = await fetch(
          `${baseUrl}/api/workspaces/${workspace.id}/agents/${agentId}/start`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: uiCookie },
            body: JSON.stringify({ gachi_port: String(instance.port) }),
          }
        )
        expect(response.status).toBe(201)
        const payload = (await response.json()) as { run_id: string }
        return { runId: payload.run_id }
      }

      await configure(orchestratorId)
      await configure(worker.id)
      const orchestratorRun = await start(orchestratorId)
      const workerRun = await start(worker.id)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${orchestratorRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = body.output.replaceAll('IN:', '')
        expect(output).toContain('[Gachi system message: startup instructions]')
        expect(output).toContain('You are Orchestrator (orchestrator) in workspace Alpha.')
        expect(output).toContain('team send <worker-name> "<task>"')
        expect(output).toContain('team cancel --dispatch <id> "<reason>"')
        expect(output).toContain('team list')
        expect(output).toContain('Maintain .gachi/tasks.md')
        expect(output).toContain('workers are the real CLI agents shown as cards on the right')
        expect(output).toContain('run `team list` first to confirm the real workers')
        expect(output).toContain(
          'Small, low-risk tasks that you can finish yourself in a few minutes you should just do yourself'
        )
        expect(output).toContain('or when the user explicitly asks for a worker to handle it')
        expect(output).toContain(
          'If there is only one available worker, dispatch directly with `team send <worker-name>'
        )
        expect(output).toContain("Do not use your CLI's built-in subagent tools")
        expect(output).not.toContain('team report')
        expect(output).toContain('SUBMITTED')
      }, 6000)

      await waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/runtime/runs/${workerRun.runId}`, {
          headers: { cookie: uiCookie },
        })
        const body = (await response.json()) as { output: string }
        const output = body.output.replaceAll('IN:', '')
        expect(output).toContain('[Gachi system message: startup instructions]')
        expect(output).toContain('You are Alice (coder) in workspace Alpha.')
        expect(output).toContain('You must run `team report "<result>"` when a task is done')
        expect(output).toContain(
          'When no task is active, report connect/standby/blocked state with `team status "<current status>"`'
        )
        expect(output).not.toContain('--success')
        expect(output).not.toContain('--failed')
        expect(output).not.toContain('team send <worker-name>')
        expect(output).toContain('SUBMITTED')
      }, 6000)
    } finally {
      await instance.close()
    }
  })
})
