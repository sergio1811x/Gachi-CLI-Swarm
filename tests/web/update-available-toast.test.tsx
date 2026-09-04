// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TerminalRunSummary } from '../../web/src/api.js'
import {
  __resetServiceWorkerUpdateStateForTests,
  __setServiceWorkerUpdateForTests,
} from '../../web/src/pwa/register-service-worker.js'
import { UpdateAvailableToast } from '../../web/src/pwa/UpdateAvailableToast.js'

const stoppedRun: TerminalRunSummary = {
  agentId: 'agent-1',
  endedAt: 100,
  exitCode: 0,
  pid: 0,
  runId: 'run-stopped',
  startedAt: 50,
  status: 'stopped',
  workspaceId: 'ws-1',
} as unknown as TerminalRunSummary

const workingRun: TerminalRunSummary = {
  agentId: 'agent-2',
  endedAt: null,
  exitCode: null,
  pid: 4242,
  runId: 'run-working',
  startedAt: 50,
  status: 'working',
  workspaceId: 'ws-1',
} as unknown as TerminalRunSummary

beforeEach(() => {
  __resetServiceWorkerUpdateStateForTests()
})

afterEach(() => {
  cleanup()
  __resetServiceWorkerUpdateStateForTests()
})

describe('UpdateAvailableToast', () => {
  test('renders nothing when there is no pending SW update', () => {
    const { container } = render(<UpdateAvailableToast terminalRuns={[]} />)
    expect(container.firstChild).toBeNull()
  })

  test('renders the toast once an update is published', () => {
    render(<UpdateAvailableToast terminalRuns={[]} />)
    expect(screen.queryByTestId('update-available-toast')).toBeNull()
    act(() => {
      __setServiceWorkerUpdateForTests(() => {})
    })
    expect(screen.getByTestId('update-available-toast')).toBeTruthy()
  })

  test('reload button is enabled and triggers apply() when all runs are stopped', () => {
    const apply = vi.fn()
    render(<UpdateAvailableToast terminalRuns={[stoppedRun]} />)
    act(() => {
      __setServiceWorkerUpdateForTests(apply)
    })
    const button = screen.getByTestId('update-available-reload') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  test('reload button stays disabled and apply is never called while any run is working', () => {
    const apply = vi.fn()
    render(<UpdateAvailableToast terminalRuns={[workingRun, stoppedRun]} />)
    act(() => {
      __setServiceWorkerUpdateForTests(apply)
    })
    const button = screen.getByTestId('update-available-reload') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(apply).not.toHaveBeenCalled()
  })

  test('after clicking reload, the button becomes disabled and shows the reloading label', () => {
    const apply = vi.fn()
    render(<UpdateAvailableToast terminalRuns={[stoppedRun]} />)
    act(() => {
      __setServiceWorkerUpdateForTests(apply)
    })
    const button = screen.getByTestId('update-available-reload') as HTMLButtonElement
    const labelBefore = button.textContent
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    // The label transitions to the reloading string. We compare against the
    // initial label rather than hard-coding to avoid coupling to wording.
    expect(button.textContent).not.toBe(labelBefore)
  })
})
