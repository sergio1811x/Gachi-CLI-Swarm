import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildWorkerDispatchPayload } from '../../src/server/agent-stdin-dispatcher.js'
import { buildOrchestratorHeartbeatPayload } from '../../src/server/gachi-team-guidance.js'
import { taskStore } from '../../src/server/task-store.js'
import { createWorkerOutputTracker } from '../../src/server/worker-output-tracker.js'
import {
  createWorkerReportNudge,
  WORKER_NUDGE_QUIET_TICKS,
} from '../../src/server/worker-report-nudge.js'

describe('Улучшения взаимодействия оркестратора и воркеров', () => {
  beforeEach(() => {
    taskStore.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('1. Контекстная сводка задач в Heartbeat payload', () => {
    const defaultPayload = buildOrchestratorHeartbeatPayload()
    expect(defaultPayload).toContain('Gachi Kanban: обновление состояния задач')

    const summary = '- Task #abc12345 "Рефакторинг": status=in_progress (assigned: @coder)'
    const payloadWithSummary = buildOrchestratorHeartbeatPayload(summary)
    expect(payloadWithSummary).toContain('Gachi Kanban: обновление состояния задач')
    expect(payloadWithSummary).toContain(summary)
  })

  test('2. Автоматический парсинг [TASK:LOG] и [PROGRESS] из PTY вывода воркера', () => {
    const task = taskStore.createTask('ws-1', {
      title: 'Сборка проекта',
      assignedAgentId: 'worker-1',
      status: 'assigned',
    })
    taskStore.updateTask('ws-1', task.id, { status: 'running' })

    const subscribers = new Map<string, (chunk: string) => void>()
    const fakeBus = {
      emit: vi.fn(),
      subscribe: (runId: string, listener: (chunk: string) => void) => {
        subscribers.set(runId, listener)
        return () => subscribers.delete(runId)
      },
    }

    const tracker = createWorkerOutputTracker(fakeBus as any)
    tracker.attach('ws-1', 'worker-1', 'run-100', '')

    const listener = subscribers.get('run-100')
    expect(listener).toBeDefined()

    // Эмулируем вывод воркера с маркой лога задачи
    listener?.(
      'Compiling typescript...\r\n[TASK:LOG] Завершена компиляция модулей\r\n[PROGRESS] 80%\r\n'
    )

    const updatedTask = taskStore.getTask('ws-1', task.id)
    expect(updatedTask?.logs).toHaveLength(2)
    expect(updatedTask?.logs[0]).toContain('Завершена компиляция модулей')
    expect(updatedTask?.logs[1]).toContain('80%')

    tracker.closeAll()
  })

  test('3. Логирование предупреждения о бездействии (stall watchdog) в задачу', async () => {
    const task = taskStore.createTask('ws-1', {
      title: 'Долгая операция',
      assignedAgentId: 'worker-stalled',
      status: 'assigned',
    })
    taskStore.updateTask('ws-1', task.id, { status: 'running' })

    const workspaceSnapshot = {
      id: 'ws-1',
      path: '/tmp/ws-1',
      summary: { id: 'ws-1', name: 'ws-1', path: '/tmp/ws-1' },
      agents: [
        {
          id: 'worker-stalled',
          workspaceId: 'ws-1',
          name: 'stalled_worker',
          role: 'coder' as const,
          status: 'working' as const,
          pendingTaskCount: 0,
        },
      ],
    }

    const writeNudge = vi.fn()

    const nudge = createWorkerReportNudge({
      getWorkspaceSnapshot: () => workspaceSnapshot as any,
      listWorkspaces: () => [{ id: 'ws-1' }],
      writeWorkerReportNudge: writeNudge,
      isAgentQuiet: () => true,
      hasActiveRun: () => true,
      intervalMs: 1000,
    })

    // Продвигаем таймеры до порога тиков бездействия
    await vi.advanceTimersByTimeAsync(1000 * WORKER_NUDGE_QUIET_TICKS)

    expect(writeNudge).toHaveBeenCalledTimes(1)
    const updatedTask = taskStore.getTask('ws-1', task.id)
    expect(updatedTask?.logs.some((l) => l.includes('Отправлено напоминание'))).toBe(true)

    nudge.stop()
  })

  test('4. Включение контекста задачи в Dispatch Payload', () => {
    const payloadWithoutTask = buildWorkerDispatchPayload(
      'orchestrator',
      'Senior Coder',
      'disp-1',
      'Написать функцию fib'
    )
    expect(payloadWithoutTask).toContain('Your role: Senior Coder')
    expect(payloadWithoutTask).not.toContain('Task context:')

    const payloadWithTask = buildWorkerDispatchPayload(
      'orchestrator',
      'Senior Coder',
      'disp-1',
      'Написать функцию fib',
      { id: '12345678-90ab-cdef-1234-567890abcdef', title: 'Оптимизация алгоритмов' }
    )
    expect(payloadWithTask).toContain('Task context: #12345678 "Оптимизация алгоритмов"')
    expect(payloadWithTask).toContain('Task:\nНаписать функцию fib')
  })

  test('5. Уведомление оркестратора при изменении очереди задач', async () => {
    const { buildOrchestratorTaskQueueUpdatePayload } = await import(
      '../../src/server/gachi-team-guidance.js'
    )
    const payload = buildOrchestratorTaskQueueUpdatePayload(
      'New Task Created',
      {
        id: '98765432-1111-2222-3333-444455556666',
        title: 'Сделать аутентификацию',
        status: 'ready',
        details: 'Нужно добавить JWT токены',
      },
      '- Task #98765432 "Сделать аутентификацию": status=ready'
    )

    expect(payload).toContain('[Gachi system message: task queue update - New Task Created]')
    expect(payload).toContain('Task #98765432: "Сделать аутентификацию"')
    expect(payload).toContain('Status: ready')
    expect(payload).toContain('[Active Queue Summary]')
    expect(payload).toContain(
      'Please review the updated task queue and coordinate workers accordingly.'
    )
  })

  test('6. Точная изоляция dispatch_id при параллельных отчётах двух воркеров', () => {
    // Воркер 1: User Sim A
    const dispatchIdA = '175ffb7a-1400-4ab2-b9b5-40039621d333'
    const taskA = taskStore.createTask('ws-test', {
      title: 'Задача для Sim A',
      assignedAgentId: 'worker-sim-a',
      status: 'running',
      dispatchId: dispatchIdA,
    })

    // Воркер 2: User Sim B
    const dispatchIdB = '0b5b111f-2f93-4f27-93e0-af23f0b71f4d'
    const taskB = taskStore.createTask('ws-test', {
      title: 'Задача для Sim B',
      assignedAgentId: 'worker-sim-b',
      status: 'running',
      dispatchId: dispatchIdB,
    })

    // Оба воркера сдают отчёты (переходят в review)
    taskStore.updateTask('ws-test', taskA.id, { status: 'review', result: 'Отчёт A' })
    taskStore.updateTask('ws-test', taskB.id, { status: 'review', result: 'Отчёт B' })

    // Поиск по dispatchIdA находит ИСКЛЮЧИТЕЛЬНО задачу taskA
    const foundTaskA = taskStore.getTaskByDispatchId('ws-test', dispatchIdA)
    expect(foundTaskA?.id).toBe(taskA.id)
    expect(foundTaskA?.title).toBe('Задача для Sim A')

    // Поиск по dispatchIdB находит ИСКЛЮЧИТЕЛЬНО задачу taskB
    const foundTaskB = taskStore.getTaskByDispatchId('ws-test', dispatchIdB)
    expect(foundTaskB?.id).toBe(taskB.id)
    expect(foundTaskB?.title).toBe('Задача для Sim B')

    // Поиск по несуществующему dispatchId возвращает undefined
    const notFound = taskStore.getTaskByDispatchId('ws-test', 'unknown-dispatch-id')
    expect(notFound).toBeUndefined()
  })
})
