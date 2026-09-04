// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { TerminalBottomPanel } from '../../web/src/terminal/TerminalBottomPanel.js'
import type { TerminalTab } from '../../web/src/terminal/useTerminalPanelTabs.js'

// jsdom lacks PointerEvent; alias to MouseEvent (same shape we use: clientY, bubbles).
if (typeof globalThis.PointerEvent === 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: jsdom test polyfill
  ;(globalThis as any).PointerEvent = class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init: MouseEventInit = {}) {
      super(type, init)
    }
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const workerTab: TerminalTab = {
  id: 'worker:w1',
  kind: 'worker',
  workerId: 'w1',
  runId: 'run-1',
  label: 'Alice',
}
const shellTab: TerminalTab = { id: 'shell:run-s', kind: 'shell', runId: 'run-s', label: 'shell' }

describe('TerminalBottomPanel', () => {
  test('renders the worker-pty portal slot for an active worker tab with a runId', () => {
    render(
      <TerminalBottomPanel
        tabs={[workerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    const slot = document.getElementById('worker-pty-run-1')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('worker')
  })

  test('renders the shell-pty portal slot for an active shell tab', () => {
    render(
      <TerminalBottomPanel
        tabs={[shellTab]}
        activeId="shell:run-s"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    const slot = document.getElementById('shell-pty-run-s')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('shell')
  })

  test('panel close button closes the whole terminal panel, not the active tab', () => {
    const onClose = vi.fn()
    const onClosePanel = vi.fn()
    render(
      <TerminalBottomPanel
        tabs={[shellTab]}
        activeId="shell:run-s"
        onSelect={vi.fn()}
        onClose={onClose}
        onClosePanel={onClosePanel}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-panel-close'))
    expect(onClosePanel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('shows the stopped-worker empty state when the active worker tab has no runId', () => {
    const stoppedWorkerTab: TerminalTab = { ...workerTab, runId: null }
    render(
      <TerminalBottomPanel
        tabs={[stoppedWorkerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    expect(document.querySelector('[data-pty-slot]')).toBeNull()
    expect(screen.getByTestId('terminal-panel-stopped-worker')).toBeInTheDocument()
  })

  test('stopped-worker empty state surfaces a Start button that fires onStartWorker(workerId)', () => {
    const stoppedWorkerTab: TerminalTab = { ...workerTab, runId: null }
    const onStartWorker = vi.fn()
    render(
      <TerminalBottomPanel
        tabs={[stoppedWorkerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={onStartWorker}
        startingWorkerId={null}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-panel-start-worker'))
    expect(onStartWorker).toHaveBeenCalledWith('w1')
  })

  test('panel renders nothing when tab list is empty', () => {
    const { container } = render(
      <TerminalBottomPanel
        tabs={[]}
        activeId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  test('resize handle is keyboard-focusable and exposes role separator', () => {
    render(
      <TerminalBottomPanel
        tabs={[workerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    const handle = screen.getByTestId('terminal-panel-resize-handle')
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
  })

  test('pointerdown on resize handle enters dragging state until pointerup', () => {
    render(
      <TerminalBottomPanel
        tabs={[workerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    const handle = screen.getByTestId('terminal-panel-resize-handle')
    expect(handle.getAttribute('data-resizing')).toBeNull()

    fireEvent.pointerDown(handle, { clientY: 400 })
    expect(handle.getAttribute('data-resizing')).toBe('true')
    expect(document.body.style.cursor).toBe('ns-resize')

    // Release: drag state and body styles must be restored.
    fireEvent.pointerUp(document)
    expect(handle.getAttribute('data-resizing')).toBeNull()
    expect(document.body.style.cursor).toBe('')
  })

  test('Cmd+W on the panel container closes the active tab', () => {
    const onClose = vi.fn()
    render(
      <TerminalBottomPanel
        tabs={[workerTab]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={onClose}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
        onStartWorker={vi.fn()}
        startingWorkerId={null}
      />
    )
    const panel = screen.getByTestId('terminal-bottom-panel')
    fireEvent.keyDown(panel, { key: 'w', metaKey: true })
    expect(onClose).toHaveBeenCalledWith('worker:w1')
  })
})
