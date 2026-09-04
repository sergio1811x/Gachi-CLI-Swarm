import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 4000,
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

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const openSocket = async (url: string, cookie: string) => {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

const openSocketAndReadFirstMessage = async (url: string, cookie: string) => {
  return await new Promise<{ message: string; socket: WebSocket }>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } })
    socket.once('message', (chunk) => resolve({ message: chunk.toString(), socket }))
    socket.once('error', reject)
  })
}

const expectUpgradeStatus = async (
  url: string,
  cookie: string,
  statusCode: number,
  headers: Record<string, string> = {}
) => {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, ...headers } })
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(statusCode)
        response.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once('open', () => reject(new Error('Expected websocket upgrade to fail')))
    socket.once('error', () => {})
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('tasks watcher websocket', () => {
  test('rejects task watcher upgrades from non-local origins', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 403, {
        Origin: 'https://attacker.example',
      })
    } finally {
      await server.close()
    }
  })

  test('allows task watcher upgrades from a local origin before workspace lookup', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 404, {
        Origin: server.baseUrl,
      })
    } finally {
      await server.close()
    }
  })

  test('rejects task watcher upgrades from non-local hosts', async () => {
    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      await expectUpgradeStatus(toWsUrl(server.baseUrl, '/ws/tasks/missing'), cookie, 403, {
        Host: 'attacker.example',
      })
    } finally {
      await server.close()
    }
  })

  test('sends the current tasks snapshot when a socket opens', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-tasks-snapshot-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.gachi'), { recursive: true })
    writeFileSync(join(workspacePath, '.gachi', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      const { message, socket } = await openSocketAndReadFirstMessage(
        toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`),
        cookie
      )

      expect(JSON.parse(message)).toEqual({
        type: 'tasks-snapshot',
        content: '- [ ] initial\n',
        revision: expect.any(String),
      })
      socket.close()
    } finally {
      await server.close()
    }
  })

  test('external .gachi/tasks.md change broadcasts tasks-updated over websocket', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'gachi-tasks-watcher-ws-'))
    tempDirs.push(workspacePath)
    mkdirSync(join(workspacePath, '.gachi'), { recursive: true })
    writeFileSync(join(workspacePath, '.gachi', 'tasks.md'), '- [ ] initial\n', 'utf8')

    const server = await startTestServer()
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Alpha', path: workspacePath }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }
      await server.store.startWorkspaceWatch(workspace.id)
      const socket = await openSocket(toWsUrl(server.baseUrl, `/ws/tasks/${workspace.id}`), cookie)
      const messages: string[] = []
      socket.on('message', (chunk) => messages.push(chunk.toString()))
      let writeCount = 0
      const updateTasks = () => {
        writeCount += 1
        writeFileSync(
          join(workspacePath, '.gachi', 'tasks.md'),
          `- [x] updated externally ${writeCount}\n`,
          'utf8'
        )
      }
      updateTasks()
      const writer = setInterval(updateTasks, 100)

      try {
        await waitFor(() => {
          const payload = messages.map(
            (message) => JSON.parse(message) as { content: string; type: string }
          )
          expect(
            payload.some(
              (message) =>
                message.type === 'tasks-updated' &&
                message.content.startsWith('- [x] updated externally ')
            )
          ).toBe(true)
        })
      } finally {
        clearInterval(writer)
        socket.close()
      }
    } finally {
      await server.close()
    }
  })
})
