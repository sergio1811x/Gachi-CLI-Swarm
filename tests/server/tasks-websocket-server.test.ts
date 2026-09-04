import { createServer } from 'node:http'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { createTasksWebSocketServer } from '../../src/server/tasks-websocket-server.js'

const servers: Array<{ close: () => void }> = []

const toWsUrl = (baseUrl: string, suffix: string) => baseUrl.replace('http://', 'ws://') + suffix

const listen = async (server: ReturnType<typeof createServer>) =>
  await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

const openSocketAndReadFirstMessage = async (url: string) =>
  await new Promise<{ message: string; socket: WebSocket }>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { cookie: 'gachi_ui_token=test-token' },
    })
    socket.once('message', (chunk) => resolve({ message: chunk.toString(), socket }))
    socket.once('error', reject)
  })

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
})

describe('tasks websocket server', () => {
  test('falls back to an empty snapshot when reading tasks fails', async () => {
    const httpServer = createServer()
    const tasksServer = createTasksWebSocketServer(
      httpServer,
      {
        getWorkspaceSnapshot: () => ({ summary: { path: '/unreadable-workspace' } }),
        validateUiToken: () => true,
      } as unknown as RuntimeStore,
      {
        readTasks: () => {
          throw new Error('permission denied')
        },
      }
    )
    servers.push(tasksServer, httpServer)
    const baseUrl = await listen(httpServer)

    const { message, socket } = await openSocketAndReadFirstMessage(
      toWsUrl(baseUrl, '/ws/tasks/workspace-1')
    )

    expect(JSON.parse(message)).toEqual({
      type: 'tasks-snapshot',
      content: '',
    })
    socket.close()
  })
})
