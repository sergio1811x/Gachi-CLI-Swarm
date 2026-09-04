import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'
import { createTasksFileService } from '../../src/server/tasks-file.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []
const stores: RuntimeStore[] = []

afterEach(async () => {
  taskStore.clear()
  while (servers.length > 0) {
    servers.pop()?.close()
  }

  while (stores.length > 0) {
    await stores.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const startServer = async () => {
  const dataDir = join(tmpdir(), `gachi-task-store-api-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  tempDirs.push(dataDir)

  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })

  const store = createRuntimeStore({ dataDir })
  stores.push(store)
  const workspace = store.createWorkspace(workspacePath, 'TestWorkspace')
  const app = createApp({ store, tasksFileService: createTasksFileService() })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspace,
  }
}

describe('Task Store REST API', () => {
  test('POST, GET, PATCH, LOG и DELETE для задач через HTTP эндпоинты', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    // 1. Создание задачи через POST /api/workspaces/:ws/tasks
    const createRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        title: 'Первая задача',
        description: 'Описание первой задачи',
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = (await createRes.json()) as {
      task: { id: string; title: string; status: string }
    }
    expect(createBody.task.id).toBeDefined()
    expect(createBody.task.title).toBe('Первая задача')
    expect(createBody.task.status).toBe('backlog')

    const taskId = createBody.task.id

    // 2. Получение списка задач через GET /api/workspaces/:ws/tasks?format=store
    const listRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks?format=store`, {
      headers: { cookie },
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { tasks: Array<{ id: string; title: string }> }
    expect(listBody.tasks).toHaveLength(1)
    expect(listBody.tasks[0]?.id).toBe(taskId)

    // 3. Получение конкретной задачи через GET /api/workspaces/:ws/tasks/:taskId
    const getRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks/${taskId}`, {
      headers: { cookie },
    })
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { task: { id: string; title: string } }
    expect(getBody.task.title).toBe('Первая задача')

    // 4. Обновление задачи через PATCH /api/workspaces/:ws/tasks/:taskId
    // State machine: backlog → ready → assigned → running. Two valid steps.
    const patchRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        status: 'assigned',
        assigned_worker_id: 'worker-42',
      }),
    })
    expect(patchRes.status).toBe(200)
    const patchBody = (await patchRes.json()) as {
      task: { status: string; assignedAgentId: string }
    }
    expect(patchBody.task.status).toBe('assigned')
    expect(patchBody.task.assignedAgentId).toBe('worker-42')

    const runRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ status: 'running' }),
    })
    expect(runRes.status).toBe(200)
    expect(((await runRes.json()) as { task: { status: string } }).task.status).toBe('running')

    // 5. Добавление лога в задачу через POST /api/workspaces/:ws/tasks/:taskId/logs
    const logRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks/${taskId}/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify({
        message: 'Воркер начал работу',
      }),
    })
    expect(logRes.status).toBe(200)
    const logBody = (await logRes.json()) as { task: { logs: string[] } }
    expect(logBody.task.logs).toHaveLength(1)
    expect(logBody.task.logs[0]).toContain('Воркер начал работу')

    // 6. Удаление задачи через DELETE /api/workspaces/:ws/tasks/:taskId
    const deleteRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks/${taskId}`, {
      method: 'DELETE',
      headers: { cookie },
    })
    expect(deleteRes.status).toBe(200)

    // Проверка, что список пуст
    const listAfterDelete = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/tasks?format=store`,
      {
        headers: { cookie },
      }
    )
    const listAfterDeleteBody = (await listAfterDelete.json()) as { tasks: unknown[] }
    expect(listAfterDeleteBody.tasks).toHaveLength(0)
  })
})
