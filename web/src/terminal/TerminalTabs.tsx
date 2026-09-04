import { LoaderCircle, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { useI18n } from '../i18n.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { TerminalTab } from './useTerminalPanelTabs.js'

type TerminalTabsProps = {
  tabs: readonly TerminalTab[]
  activeId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onClosePanel: () => void
  onNewShell: () => void
  newShellPending: boolean
}

/**
 * VSCode-style tab strip. Active tab carries a 2px top accent rail in
 * `var(--accent)` + the surface background of the content area, so the tab
 * visually merges with the terminal content beneath it. Inactive tabs sit on
 * a slightly darker `var(--bg-2)` strip.
 *
 * Structure: each tab is a wrapper `<div role="tab">` containing two sibling
 * `<button>` elements (select + close). Buttons-inside-buttons is invalid
 * HTML — browsers hoist the inner button out and break the layout — so the
 * wrapper `<div>` carries the `role="tab"` + `aria-selected` + the
 * data-testid the panel tests assert on.
 */
export const TerminalTabs = ({
  tabs,
  activeId,
  onSelect,
  onClose,
  onClosePanel,
  onNewShell,
  newShellPending,
}: TerminalTabsProps) => {
  const { t } = useI18n()
  return (
    <div
      role="tablist"
      aria-label={t('terminalPanel.tablistAria')}
      className="scrollbar-thin flex h-9 min-h-9 w-full items-stretch overflow-x-auto"
      style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}
      data-testid="terminal-tab-strip"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId
        const closeAria = t('terminalPanel.closeTab', { name: tab.label })
        const handleClose = (event: ReactMouseEvent<HTMLButtonElement>) => {
          event.stopPropagation()
          onClose(tab.id)
        }
        return (
          // biome-ignore lint/a11y/useFocusableInteractive: the inner select <button> is the focus target; the wrapper carries role="tab" only as a screen-reader grouping for the two sibling buttons
          // biome-ignore lint/a11y/useKeyWithClickEvents: the inner select <button> handles keyboard activation
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-testid={`terminal-tab-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            className="group relative flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r text-xs"
            style={{
              background: selected ? 'var(--bg-1)' : 'transparent',
              borderRightColor: 'var(--border)',
              color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            {selected ? (
              <span
                data-tab-accent
                aria-hidden
                className="pointer-events-none absolute top-0 right-0 left-0 h-0.5"
                style={{ background: 'var(--accent)' }}
              />
            ) : null}
            <button
              type="button"
              data-testid={`terminal-tab-select-${tab.id}`}
              onClick={(event) => {
                // Stop the wrapper-div's onClick from re-firing onSelect.
                event.stopPropagation()
                onSelect(tab.id)
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pr-1 pl-3 text-left"
              style={{ color: 'inherit' }}
            >
              <TerminalIcon size={12} aria-hidden />
              <span className="truncate">{tab.label}</span>
            </button>
            <Tooltip label={closeAria}>
              <button
                type="button"
                aria-label={closeAria}
                data-testid={`terminal-tab-close-${tab.id}`}
                onClick={handleClose}
                className={`mr-1 rounded p-0.5 transition ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{ color: 'var(--text-secondary)' }}
              >
                <X size={12} aria-hidden />
              </button>
            </Tooltip>
          </div>
        )
      })}
      <div className="flex flex-1 items-center justify-end gap-1 px-2">
        <Tooltip label={t('terminalPanel.closePanel')}>
          <button
            type="button"
            aria-label={t('terminalPanel.closePanel')}
            data-testid="terminal-panel-close"
            onClick={onClosePanel}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border text-sec transition hover:text-pri disabled:opacity-50"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          >
            <X size={12} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip label={t('terminalPanel.newShell')}>
          <button
            type="button"
            aria-label={t('terminalPanel.newShell')}
            data-testid="terminal-tab-new-shell"
            onClick={onNewShell}
            disabled={newShellPending}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border text-sec transition hover:text-pri disabled:opacity-50"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          >
            {newShellPending ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <Plus size={12} aria-hidden />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
