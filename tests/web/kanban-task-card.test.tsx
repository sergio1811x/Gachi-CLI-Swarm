// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TaskRecordItem } from '../../web/src/api.js'
import { TaskCard } from '../../web/src/tasks/kanban/TaskCard.js'

afterEach(() => {
  cleanup()
})

const worker: TeamListItem = {
  id: 'agent-1',
  name: 'coder',
  role: 'coder',
  status: 'idle',
  pendingTaskCount: 0,
}

const task: TaskRecordItem = {
  id: 'task-1',
  workspaceId: 'ws-1',
  title: 'Fix login bug',
  description: 'Steps to reproduce...',
  status: 'backlog',
  priority: 'high',
  assignedAgentId: 'agent-1',
  logs: [],
  createdAt: 0,
  updatedAt: 0,
}

const baseProps = {
  task,
  worker,
  query: '',
  dispatching: false,
  dragging: false,
  entering: false,
  exiting: false,
  pulseColor: null,
  onOpenReport: vi.fn(),
  onDispatch: vi.fn(),
  onAccept: vi.fn(),
  onRework: vi.fn(),
  onOpenWorkerTerminal: undefined,
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
}

describe('TaskCard click handling', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test('a plain card click opens the detail modal', () => {
    const onOpen = vi.fn()
    render(<TaskCard {...baseProps} onOpen={onOpen} onDelete={vi.fn()} />)

    fireEvent.click(screen.getByText('Fix login bug'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('clicking the delete control deletes instead of opening', () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn()
    const { container } = render(<TaskCard {...baseProps} onOpen={onOpen} onDelete={onDelete} />)

    fireEvent.click(container.querySelector('.kb-card-delete') as HTMLElement)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  test('clicks inside the card do not get swallowed by its own role="button"', () => {
    // Regression: the guard selector used to include [role="button"], which
    // matched the card root itself and swallowed every plain click.
    const onOpen = vi.fn()
    render(<TaskCard {...baseProps} onOpen={onOpen} onDelete={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /fix login bug/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
