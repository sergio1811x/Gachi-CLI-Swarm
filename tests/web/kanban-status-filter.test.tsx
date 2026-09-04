// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TaskRecordItem } from '../../web/src/api.js'
import { KanbanBoard } from '../../web/src/tasks/KanbanBoard.js'

const listTasks = vi.fn()
const deleteTask = vi.fn()

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
    deleteTask: (...args: unknown[]) => deleteTask(...args),
  }
})

class FakeWebSocket {
  onopen: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onmessage: unknown = null
  close() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const task = (id: string, title: string, status: TaskRecordItem['status']): TaskRecordItem => ({
  id,
  workspaceId: 'ws-1',
  title,
  description: '',
  status,
  logs: [],
  createdAt: 0,
  updatedAt: 0,
})

const tasksFor = (): TaskRecordItem[] => [
  task('t-failed-1', 'Fail A', 'failed'),
  task('t-failed-2', 'Fail B', 'failed'),
  task('t-done-1', 'Done A', 'done'),
  task('t-run-1', 'Run A', 'running'),
]

describe('kanban category filter + bulk delete', () => {
  test('selecting the failed category hides other columns and bulk delete removes only filtered cards', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    listTasks.mockResolvedValue(tasksFor())
    deleteTask.mockResolvedValue(undefined)

    render(<KanbanBoard workspaceId="ws-1" />)

    await screen.findByText('Fail A')
    expect(screen.getByText('Done A')).toBeInTheDocument()
    expect(screen.getByText('Run A')).toBeInTheDocument()

    // The failed chip shows the live per-category counter.
    const failedChip = screen.getByTestId('status-filter-failed')
    expect(failedChip.textContent).toContain('2')

    // Selecting a category filters the board…
    fireEvent.click(failedChip)
    await waitFor(() => {
      expect(screen.queryByText('Done A')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Run A')).not.toBeInTheDocument()
    expect(screen.getByText('Fail A')).toBeInTheDocument()
    expect(screen.getByText('Fail B')).toBeInTheDocument()

    // …and turns the bulk action into an explicit labeled delete for the
    // filtered set only.
    const bulk = screen.getByTitle(/Удалить все отфильтрованные/)
    expect(bulk.textContent).toContain('Удалить')

    fireEvent.click(bulk) // arm
    const armed = screen.getByTitle(/Ещё раз — удалить 2/)
    fireEvent.click(armed) // fire

    await waitFor(() => {
      expect(deleteTask).toHaveBeenCalledTimes(2)
    })
    const deletedIds = deleteTask.mock.calls.map((call) => call[1])
    expect(deletedIds).toEqual(['t-failed-1', 't-failed-2'])
  })

  test('the Все chip clears the category filter and brings every card back', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    listTasks.mockResolvedValue(tasksFor())

    render(<KanbanBoard workspaceId="ws-1" />)

    await screen.findByText('Fail A')
    fireEvent.click(screen.getByTestId('status-filter-done'))
    await waitFor(() => {
      expect(screen.queryByText('Fail A')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('status-filter-all'))
    await waitFor(() => {
      expect(screen.getByText('Fail A')).toBeInTheDocument()
    })
    expect(screen.getByText('Done A')).toBeInTheDocument()
    expect(screen.getByText('Run A')).toBeInTheDocument()
  })
})
