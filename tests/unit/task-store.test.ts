import { beforeEach, describe, expect, test } from 'vitest'
import { TaskDependencyError, TaskStore } from '../../src/server/task-store.js'

describe('TaskStore in-memory', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  test('создает задачу в backlog', () => {
    const task = store.createTask('ws-1', {
      title: 'Написать тесты',
      description: 'Покрыть функционал TaskStore',
    })

    expect(task.id).toBeDefined()
    expect(task.workspaceId).toBe('ws-1')
    expect(task.title).toBe('Написать тесты')
    expect(task.description).toBe('Покрыть функционал TaskStore')
    expect(task.status).toBe('backlog')
    expect(task.logs).toEqual([])
  })

  test('review→assigned reopen is legal (team send poke regression)', () => {
    const task = store.createTask('ws-1', { title: 'Previous work' })
    store.updateTask('ws-1', task.id, { status: 'ready' })
    store.updateTask('ws-1', task.id, { status: 'assigned' })
    store.updateTask('ws-1', task.id, { status: 'running' })
    store.updateTask('ws-1', task.id, { status: 'review' })
    const reopened = store.updateTask('ws-1', task.id, { status: 'assigned' })
    expect(reopened.status).toBe('assigned')
  })

  test('возвращает список задач для конкретного workspaceId', () => {
    store.createTask('ws-1', { title: 'Задача 1' })
    store.createTask('ws-2', { title: 'Задача другого воркспейса' })
    store.createTask('ws-1', { title: 'Задача 2' })

    const ws1Tasks = store.listTasks('ws-1')
    const ws2Tasks = store.listTasks('ws-2')

    expect(ws1Tasks).toHaveLength(2)
    expect(ws1Tasks.map((t) => t.title)).toEqual(['Задача 1', 'Задача 2'])
    expect(ws2Tasks).toHaveLength(1)
  })

  test('обновляет статус и назначенного воркера', () => {
    const task = store.createTask('ws-1', { title: 'Рефакторинг' })
    const updated = store.updateTask('ws-1', task.id, {
      status: 'assigned',
      assignedAgentId: 'worker-1',
    })

    expect(updated?.status).toBe('assigned')
    expect(updated?.assignedAgentId).toBe('worker-1')

    const fetched = store.getTask('ws-1', task.id)
    expect(fetched?.status).toBe('assigned')
    expect(fetched?.assignedAgentId).toBe('worker-1')
  })

  test('stores Kanban orchestration metadata on each task', () => {
    const task = store.createTask('ws-1', {
      dependencies: ['task-architecture'],
      priority: 'critical',
      requiredSkills: ['typescript', 'sqlite'],
      reviewRequired: true,
      role: 'coder',
      title: 'Implement API',
    })

    expect(task).toMatchObject({
      dependencies: ['task-architecture'],
      priority: 'critical',
      requiredSkills: ['typescript', 'sqlite'],
      reviewRequired: true,
      role: 'coder',
    })
  })

  test('blocks a task from starting until all dependency cards are done', () => {
    const dependency = store.createTask('ws-1', { title: 'Architecture' })
    const task = store.createTask('ws-1', { dependencies: [dependency.id], title: 'API' })

    store.updateTask('ws-1', task.id, { status: 'ready' })
    store.updateTask('ws-1', task.id, { status: 'assigned' })
    expect(() => store.updateTask('ws-1', task.id, { status: 'running' })).toThrow(
      TaskDependencyError
    )
    store.updateTask('ws-1', dependency.id, { status: 'ready' })
    store.updateTask('ws-1', dependency.id, { status: 'assigned' })
    store.updateTask('ws-1', dependency.id, { status: 'running' })
    expect(() => store.updateTask('ws-1', dependency.id, { status: 'done' })).toThrow(
      'Invalid task transition: running -> done'
    )
    store.updateTask('ws-1', dependency.id, { status: 'review' })
    store.updateTask('ws-1', dependency.id, { status: 'done' })

    store.updateTask('ws-1', task.id, { status: 'assigned' })
    expect(store.updateTask('ws-1', task.id, { status: 'running' })?.status).toBe('running')
  })

  test('blocks assigned -> done for review-required tasks but not review-exempt cards', () => {
    const reviewed = store.createTask('ws-1', { title: 'Needs review', reviewRequired: true })
    store.updateTask('ws-1', reviewed.id, { status: 'ready' })
    store.updateTask('ws-1', reviewed.id, { status: 'assigned' })
    expect(() => store.updateTask('ws-1', reviewed.id, { status: 'done' })).toThrow(
      'Task requires review before done: assigned -> done'
    )

    // Reviewer child cards are review-exempt (reviewRequired=false) and may
    // settle directly from assigned (reviewer APPROVE path).
    const child = store.createTask('ws-1', {
      parentTaskId: reviewed.id,
      reviewRequired: false,
      title: 'Review: Needs review',
    })
    expect(store.updateTask('ws-1', child.id, { status: 'assigned' })?.status).toBe('assigned')
    expect(store.updateTask('ws-1', child.id, { status: 'done' })?.status).toBe('done')

    // The normal path still works: review -> done.
    store.updateTask('ws-1', reviewed.id, { status: 'review' })
    expect(store.updateTask('ws-1', reviewed.id, { status: 'done' })?.status).toBe('done')
  })

  test('добавляет логи в задачу', () => {
    const task = store.createTask('ws-1', { title: 'Задача с логами' })
    store.addLog('ws-1', task.id, 'Старт выполнения')
    store.addLog('ws-1', task.id, 'Прогресс 50%')

    const fetched = store.getTask('ws-1', task.id)
    expect(fetched?.logs).toHaveLength(2)
    expect(fetched?.logs[0]).toContain('Старт выполнения')
    expect(fetched?.logs[1]).toContain('Прогресс 50%')
  })

  test('находит первую открытую свободную задачу', () => {
    const task1 = store.createTask('ws-1', { title: 'Задача 1' })
    const task2 = store.createTask('ws-1', { title: 'Задача 2' })

    store.updateTask('ws-1', task1.id, { assignedAgentId: 'worker-1', status: 'assigned' })
    store.updateTask('ws-1', task2.id, { status: 'ready' })

    const openTask = store.findOpenTask('ws-1')
    expect(openTask?.id).toBe(task2.id)
  })

  test('находит назначенную задачу для воркера', () => {
    const task = store.createTask('ws-1', {
      title: 'Задача в работе',
      assignedAgentId: 'worker-123',
    })
    store.updateTask('ws-1', task.id, { status: 'assigned' })

    const assigned = store.getAssignedTaskForWorker('ws-1', 'worker-123')
    expect(assigned?.id).toBe(task.id)
  })

  test('удаляет задачу', () => {
    const task = store.createTask('ws-1', { title: 'Удаляемая задача' })
    const deleted = store.deleteTask('ws-1', task.id)
    expect(deleted).toBe(true)

    const list = store.listTasks('ws-1')
    expect(list).toHaveLength(0)
  })

  test('автоматически удаляет задачи старше 24 часов (TTL)', () => {
    const taskFresh = store.createTask('ws-1', { title: 'Свежая задача' })
    const taskOld = store.createTask('ws-1', { title: 'old completed task', status: 'done' })
    const taskActive = store.createTask('ws-1', { title: 'old active task' })

    // Имитируем возраст старой задачи > 24 часов (25 часов назад)
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000
    taskOld.createdAt = twentyFiveHoursAgo

    const tasks = store.listTasks('ws-1')
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([taskFresh.id, taskActive.id])
    )
    expect(store.getTask('ws-1', taskOld.id)).toBeUndefined()
  })

  test('сохраняет задачи в SQLite и восстанавливает их после перезагрузки', () => {
    const memoryDbStorage = new Map<string, string>()
    const mockDb = {
      prepare: (_sql: string) => ({
        get: (key: string) => {
          const val = memoryDbStorage.get(key)
          return val ? { value: val } : undefined
        },
        run: (json: string, _ts: number) => {
          memoryDbStorage.set('kanban_tasks_v1', json)
        },
      }),
    }

    const storeInstance1 = new TaskStore()
    storeInstance1.init(mockDb)

    const created = storeInstance1.createTask('ws-persisted', {
      title: 'Персистентная задача',
      description: 'Не должна исчезать после перезапуска',
    })
    storeInstance1.addComment('ws-persisted', created.id, 'Orchestrator', 'Важный комментарий')

    // Имитируем перезапуск приложения с новым экземпляром TaskStore
    const storeInstance2 = new TaskStore()
    storeInstance2.init(mockDb)

    const restoredTasks = storeInstance2.listTasks('ws-persisted')
    expect(restoredTasks).toHaveLength(1)
    expect(restoredTasks[0].id).toBe(created.id)
    expect(restoredTasks[0].title).toBe('Персистентная задача')
    expect(restoredTasks[0].comments).toHaveLength(1)
    expect(restoredTasks[0].comments?.[0].message).toBe('Важный комментарий')
  })

  test('атомарно захватывает задачу через claimTask и предотвращает двойной захват', () => {
    const task = store.createTask('ws-1', {
      title: 'Конкурентная задача',
      status: 'ready',
    })

    // Первый воркер захватывает
    const claimedByWorker1 = store.claimTask('ws-1', task.id, 'worker-1')
    expect(claimedByWorker1).toBeDefined()
    expect(claimedByWorker1?.status).toBe('claimed')
    expect(claimedByWorker1?.claimedBy).toBe('worker-1')
    expect(claimedByWorker1?.attempts).toBe(1)

    // Второй воркер пытается захватить ту же задачу — получает undefined
    const claimedByWorker2 = store.claimTask('ws-1', task.id, 'worker-2')
    expect(claimedByWorker2).toBeUndefined()

    // Проверяем, что задача осталась у worker-1
    const current = store.getTask('ws-1', task.id)
    expect(current?.assignedAgentId).toBe('worker-1')
    expect(current?.claimedBy).toBe('worker-1')
  })

  test('releaseTask возвращает в ready при сбое доставки, сохраняет affinity и фейлит только явно (permanent)', () => {
    const task = store.createTask('ws-1', {
      title: 'Падающая задача',
      status: 'ready',
    })

    // Сбой доставки (попытка 1) — задача возвращается в READY. Sticky
    // affinity: привязка к воркеру СОХРАНЯЕТСЯ, чтобы карточка не ушла
    // случайному агенту (H-1); снимается только permanent или deleteWorker.
    store.claimTask('ws-1', task.id, 'worker-1')
    const released1 = store.releaseTask('ws-1', task.id, 'Process crashed')
    expect(released1?.status).toBe('ready')
    expect(released1?.claimedBy).toBeUndefined()
    expect(released1?.assignedAgentId).toBe('worker-1')

    // Повторные сбои доставки НИКОГДА не переводят задачу в FAILED навсегда —
    // иначе флейковый воркер сжигает попытки и задача пропадает из очереди.
    store.claimTask('ws-1', task.id, 'worker-2')
    expect(store.releaseTask('ws-1', task.id, 'Out of memory')?.status).toBe('ready')
    store.claimTask('ws-1', task.id, 'worker-3')
    expect(store.releaseTask('ws-1', task.id, 'Fatal error')?.status).toBe('ready')
    store.claimTask('ws-1', task.id, 'worker-4')
    expect(store.releaseTask('ws-1', task.id, 'Timed out')?.status).toBe('ready')

    // Перевод в FAILED — только явное решение через options.permanent.
    store.claimTask('ws-1', task.id, 'worker-5')
    const failed = store.releaseTask('ws-1', task.id, 'Отменена вручную', { permanent: true })
    expect(failed?.status).toBe('failed')
    // Permanent-фейл развязывает карточку с воркером.
    expect(failed?.assignedAgentId).toBeUndefined()
  })
})
