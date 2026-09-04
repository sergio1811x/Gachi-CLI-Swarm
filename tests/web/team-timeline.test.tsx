// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import { TeamTimeline } from '../../web/src/worker/TeamTimeline.js'

const worker: TeamListItem = {
  id: 'worker-1',
  name: 'Backend',
  role: 'coder',
  status: 'working',
  pendingTaskCount: 1,
  currentTaskId: 'task-7',
  lastDispatchedAt: Date.now() - 20_000,
  lastPtyLine: 'Running integration tests',
  lastPtyOutputAt: Date.now() - 5_000,
}

describe('TeamTimeline', () => {
  test('surfaces real runtime activity and opens the selected worker', () => {
    const onOpenWorker = vi.fn()
    render(<TeamTimeline workers={[worker]} onOpenWorker={onOpenWorker} />)

    expect(screen.getByRole('region', { name: 'Team members' })).toBeInTheDocument()
    expect(screen.getByText('Running integration tests')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Running integration tests'))
    expect(onOpenWorker).toHaveBeenCalledWith(worker)
  })
})
