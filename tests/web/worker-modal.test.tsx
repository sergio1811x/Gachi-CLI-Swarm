// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'

const apiMocks = vi.hoisted(() => ({ configureAgentLaunch: vi.fn(async () => undefined) }))

vi.mock('../../web/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/api.js')>()),
  configureAgentLaunch: apiMocks.configureAgentLaunch,
}))

import { WorkerModal } from '../../web/src/worker/WorkerModal.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  apiMocks.configureAgentLaunch.mockClear()
})

const buildWorker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'working',
  ...overrides,
})

const renderModal = (
  options: {
    worker?: TeamListItem
    runId?: string | null
    starting?: boolean
    startError?: string | null
    workspaceId?: string
  } = {}
) => {
  const onClose = vi.fn()
  const onStart = vi.fn(async () => undefined)
  const onStop = vi.fn(async () => undefined)
  render(
    <WorkerModal
      onClose={onClose}
      onStart={onStart}
      onStop={onStop}
      runId={options.runId === undefined ? 'run-1' : options.runId}
      startError={options.startError ?? null}
      starting={options.starting ?? false}
      worker={options.worker ?? buildWorker()}
      workspaceId={options.workspaceId}
    />
  )
  return { onClose, onStart, onStop }
}

describe('WorkerModal — pure PTY view (control actions live on WorkerCard)', () => {
  test('mounts the PTY slot when runId is provided', () => {
    const runId = 'run-abc'
    renderModal({ runId })
    const slot = document.getElementById(`worker-pty-${runId}`)
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('worker')
  })

  test('renders the empty-state Start affordance when no PTY is running', () => {
    const stoppedWorker = buildWorker({ status: 'stopped' })
    const { onStart } = renderModal({ runId: null, worker: stoppedWorker })

    fireEvent.click(screen.getByTestId('worker-start-empty'))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(stoppedWorker)
  })

  test('switching CLI stops the live process before starting the configured engine', async () => {
    const calls: string[] = []
    const { onStart, onStop } = renderModal({ runId: 'run-1', workspaceId: 'workspace-1' })
    onStop.mockImplementation(async () => {
      calls.push('stop')
    })
    onStart.mockImplementation(async () => {
      calls.push('start')
    })
    apiMocks.configureAgentLaunch.mockImplementation(async () => {
      calls.push('configure')
    })

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'agy' } })

    await waitFor(() => expect(onStart).toHaveBeenCalledWith(buildWorker()))
    expect(onStop).toHaveBeenCalledWith(buildWorker())
    expect(apiMocks.configureAgentLaunch).toHaveBeenCalledWith('workspace-1', 'worker-1', {
      command_preset_id: 'agy',
    })
    expect(calls).toEqual(['configure', 'stop', 'start'])
  })

  test('Close button dispatches onClose via Dialog close', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getAllByTestId('worker-modal-close')[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape inside the terminal modal is reserved for the terminal instead of dialog close', () => {
    const { onClose } = renderModal({ runId: 'run-1' })

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Escape',
      key: 'Escape',
    })
    screen.getByRole('dialog', { name: 'Alice' }).dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('Close tooltip does not advertise Escape as a worker-modal shortcut', () => {
    vi.useFakeTimers()
    renderModal({ runId: 'run-1' })

    fireEvent.focus(screen.getAllByTestId('worker-modal-close')[0])
    act(() => vi.advanceTimersByTime(300))

    expect(screen.getAllByText('Close').length).toBeGreaterThan(0)
    expect(screen.queryByText('Close (Esc)')).toBeNull()

    vi.useRealTimers()
  })

  test('startError surfaces as an alert banner', () => {
    renderModal({ startError: 'claude CLI not found in PATH', runId: null })
    expect(screen.getByRole('alert')).toHaveTextContent('claude CLI not found in PATH')
  })

  test('control actions (Stop / Restart / Delete) are NOT rendered inside the modal', () => {
    renderModal()
    expect(screen.queryByTestId('worker-stop')).toBeNull()
    expect(screen.queryByTestId('worker-restart')).toBeNull()
    expect(screen.queryByTestId('worker-delete')).toBeNull()
    // (Card-level testids: worker-card-stop-*, worker-card-restart-*, worker-card-delete-*)
  })
})
