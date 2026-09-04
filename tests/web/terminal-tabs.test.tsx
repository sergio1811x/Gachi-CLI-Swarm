// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TerminalTabs } from '../../web/src/terminal/TerminalTabs.js'
import type { TerminalTab } from '../../web/src/terminal/useTerminalPanelTabs.js'

afterEach(() => cleanup())

const buildWorkerTab = (overrides: Partial<TerminalTab> = {}): TerminalTab =>
  ({
    id: 'worker:w1',
    kind: 'worker',
    workerId: 'w1',
    runId: 'run-1',
    label: 'Alice',
    ...overrides,
  }) as TerminalTab

const buildShellTab = (overrides: Partial<TerminalTab> = {}): TerminalTab =>
  ({
    id: 'shell:run-x',
    kind: 'shell',
    runId: 'run-x',
    label: 'shell',
    ...overrides,
  }) as TerminalTab

describe('TerminalTabs', () => {
  test('clicking a tab fires onSelect with its id', () => {
    const onSelect = vi.fn()
    render(
      <TerminalTabs
        tabs={[buildWorkerTab(), buildShellTab()]}
        activeId="worker:w1"
        onSelect={onSelect}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-tab-shell:run-x'))
    expect(onSelect).toHaveBeenCalledWith('shell:run-x')
  })

  test('close button on the active tab fires onClose without bubbling to onSelect', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <TerminalTabs
        tabs={[buildWorkerTab()]}
        activeId="worker:w1"
        onSelect={onSelect}
        onClose={onClose}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-tab-close-worker:w1'))
    expect(onClose).toHaveBeenCalledWith('worker:w1')
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('panel close button closes the terminal panel without closing the active tab', () => {
    const onClose = vi.fn()
    const onClosePanel = vi.fn()
    render(
      <TerminalTabs
        tabs={[buildWorkerTab(), buildShellTab()]}
        activeId="shell:run-x"
        onSelect={vi.fn()}
        onClose={onClose}
        onClosePanel={onClosePanel}
        onNewShell={vi.fn()}
        newShellPending={false}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-panel-close'))
    expect(onClosePanel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('new-shell button fires onNewShell', () => {
    const onNewShell = vi.fn()
    render(
      <TerminalTabs
        tabs={[]}
        activeId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={onNewShell}
        newShellPending={false}
      />
    )
    fireEvent.click(screen.getByTestId('terminal-tab-new-shell'))
    expect(onNewShell).toHaveBeenCalledTimes(1)
  })

  test('active tab marks aria-selected and exposes the active accent rail', () => {
    render(
      <TerminalTabs
        tabs={[buildWorkerTab(), buildShellTab()]}
        activeId="shell:run-x"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
      />
    )
    expect(screen.getByTestId('terminal-tab-worker:w1').getAttribute('aria-selected')).toBe('false')
    const active = screen.getByTestId('terminal-tab-shell:run-x')
    expect(active.getAttribute('aria-selected')).toBe('true')
    expect(active.querySelector('[data-tab-accent]')).not.toBeNull()
  })

  test('close button is a sibling of the select button (no nested <button> in <button>)', () => {
    // Regression: an earlier draft nested the close <button> inside the tab
    // <button>, which is invalid HTML and breaks layout in real browsers.
    // Assert the structural shape: close button's parent is the tab wrapper,
    // not the select button.
    render(
      <TerminalTabs
        tabs={[buildWorkerTab()]}
        activeId="worker:w1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onClosePanel={vi.fn()}
        onNewShell={vi.fn()}
        newShellPending={false}
      />
    )
    const closeBtn = screen.getByTestId('terminal-tab-close-worker:w1')
    const selectBtn = screen.getByTestId('terminal-tab-select-worker:w1')
    expect(closeBtn.parentElement).toBe(selectBtn.parentElement)
    expect(closeBtn.parentElement?.tagName).toBe('DIV')
    // And no button descends from another button anywhere in the tab.
    expect(selectBtn.querySelector('button')).toBeNull()
  })
})
