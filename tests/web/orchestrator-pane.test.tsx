// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'

afterEach(() => {
  cleanup()
})

const renderPane = (state: OrchestratorPaneState) => {
  const onStop = vi.fn()
  const onStart = vi.fn()
  const onRestart = vi.fn()
  const onRemoveWorkspace = vi.fn()
  const onConfigure = vi.fn()
  render(
    <OrchestratorPane
      state={state}
      onStop={onStop}
      onStart={onStart}
      onRestart={onRestart}
      onRemoveWorkspace={onRemoveWorkspace}
      onConfigure={onConfigure}
    />
  )
  return { onRemoveWorkspace, onStop, onStart, onRestart, onConfigure }
}

describe('OrchestratorPane three-state UI', () => {
  test('starting: shows passive startup state without a manual Start Orchestrator CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'starting' })

    expect(screen.getByTestId('orchestrator-starting-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Starting Orchestrator')
    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Orchestrator is offline')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('stopped: shows explicit Start Orchestrator CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'stopped' })

    expect(screen.getByTestId('orchestrator-stopped-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Orchestrator is stopped')
    const start = screen.getByTestId('orchestrator-start')
    expect(start).toHaveTextContent('Start Orchestrator')

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: PTY slot mounts; a Stop button is available, other overlays/empty bodies stay gone', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

    // Restart / status pill / empty-state overlays are still gone — the pane
    // is just a PTY in running state — but Stop is surfaced directly so a
    // stuck orchestrator can be killed without hunting for a palette command.
    expect(screen.queryByTestId('orchestrator-restart')).toBeNull()
    expect(screen.queryByTestId('orchestrator-running-actions')).toBeNull()
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-stopped-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    fireEvent.click(screen.getByTestId('orchestrator-stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onRemoveWorkspace, onStop, onStart, onRestart } = renderPane({
      kind: 'failed',
      error: errorMessage,
    })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('orchestrator-error-message')).toHaveTextContent(errorMessage)
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()

    const remove = screen.getByTestId('orchestrator-remove-workspace')
    expect(remove).toHaveTextContent('Remove workspace')
    fireEvent.click(remove)
    expect(onRemoveWorkspace).toHaveBeenCalledTimes(1)
  })

  test('failed: offers a Configure Command CTA so a missing/bad command can be fixed', () => {
    const { onConfigure } = renderPane({
      kind: 'failed',
      error: 'claude CLI not found in PATH',
    })

    const configureButton = screen.getByTestId('orchestrator-failed-configure')
    fireEvent.click(configureButton)
    expect(onConfigure).toHaveBeenCalledTimes(1)
  })
})
