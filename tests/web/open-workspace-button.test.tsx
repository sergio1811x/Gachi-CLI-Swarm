// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceSummary } from '../../src/shared/types.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { OpenWorkspaceButton } from '../../web/src/workspace/OpenWorkspaceButton.js'
import { PREFERRED_OPEN_TARGET_STORAGE_KEY } from '../../web/src/workspace/open-targets.js'

const renderHarness = (children: ReactNode) =>
  render(
    <I18nProvider>
      <ToastProvider>
        {children}
        <Toaster />
      </ToastProvider>
    </I18nProvider>
  )

const mkWorkspace = (overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: 'ws-1',
  name: 'Alpha',
  path: '/Users/admin/code/alpha',
  ...overrides,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface OpenCall {
  url: string
  method: string
  body: unknown
}

const stubOpenFetch = (responder: (call: OpenCall) => Response | Promise<Response>): OpenCall[] => {
  const calls: OpenCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: OpenCall = { url, method, body }
    calls.push(call)
    return responder(call)
  })
  return calls
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('OpenWorkspaceButton', () => {
  test('main click POSTs target_id to /api/workspaces/:id/open and skips toast on 200', async () => {
    const calls = stubOpenFetch(() => json({ ok: true, effective_target_id: 'finder' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    await waitFor(() => expect(calls).toHaveLength(1))

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/api/workspaces/ws-1/open')
    expect(calls[0]?.body).toEqual({ target_id: 'finder' })

    // No error toast on success.
    expect(screen.queryByTestId('toaster')).toBeNull()
  })

  test('selecting Cursor via the chevron persists the preference and updates the next click payload', async () => {
    const calls = stubOpenFetch(() => json({ ok: true, effective_target_id: 'cursor' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const menu = screen.getByTestId('topbar-open-workspace-menu')
    fireEvent.click(within(menu).getByTestId('topbar-open-workspace-option-cursor'))

    // Popover closes after selection.
    expect(screen.queryByTestId('topbar-open-workspace-menu')).toBeNull()

    expect(window.localStorage.getItem(PREFERRED_OPEN_TARGET_STORAGE_KEY)).toBe('cursor')

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toEqual({ target_id: 'cursor' })
  })

  test('502 with error_code surfaces a localized error toast (not raw stderr)', async () => {
    stubOpenFetch(() =>
      json(
        {
          ok: false,
          effective_target_id: 'cursor',
          error_code: 'app-not-installed',
          stderr: 'Unable to find application named "Cursor"',
        },
        502
      )
    )

    // Seed the preference so we open with Cursor on first click.
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, 'cursor')

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    const toaster = await screen.findByTestId('toaster')
    // Localized i18n message format includes the app name and never the raw English stderr.
    expect(toaster.textContent).toContain('Cursor')
    expect(toaster.textContent).not.toContain('Unable to find application named')
  })

  test('chevron and main button are disabled when no workspace is selected', () => {
    const calls = stubOpenFetch(() => json({ ok: true }, 200))

    renderHarness(<OpenWorkspaceButton workspace={null} />)

    const main = screen.getByTestId('topbar-open-workspace') as HTMLButtonElement
    const chev = screen.getByTestId('topbar-open-workspace-chevron') as HTMLButtonElement
    expect(main.disabled).toBe(true)
    expect(chev.disabled).toBe(true)

    fireEvent.click(main)
    expect(calls).toHaveLength(0)
  })

  test('stored preference is honored on mount', () => {
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, 'zed')
    stubOpenFetch(() => json({ ok: true, effective_target_id: 'zed' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    // Verify by opening the chevron menu and confirming `zed` is the checked item.
    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const checked = screen
      .getByTestId('topbar-open-workspace-menu')
      .querySelector('[aria-checked="true"]')
    expect(checked?.getAttribute('data-testid')).toBe('topbar-open-workspace-option-zed')
  })

  test('legacy ghostie key is normalized to ghostty on load (mac platform)', () => {
    // Force navigator to mac so ghostty IS in the supported whitelist; without
    // this, a Linux/Windows test runner would silently fall back to finder
    // and the "did normalization run?" question becomes unobservable.
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537',
      platform: 'MacIntel',
      language: 'en-US',
    })
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, 'ghostie')
    stubOpenFetch(() => json({ ok: true, effective_target_id: 'ghostty' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const checked = screen
      .getByTestId('topbar-open-workspace-menu')
      .querySelector('[aria-checked="true"]')
    expect(checked?.getAttribute('data-testid')).toBe('topbar-open-workspace-option-ghostty')
  })

  test('stale intellij_idea preference falls back to the platform default (target removed)', () => {
    // IntelliJ IDEA was dropped from the supported targets after 1.3.0, so a
    // previously-saved `intellij_idea` (or `intellijidea`) preference now
    // resolves to the mac default (finder) rather than ghosting the open click.
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537',
      platform: 'MacIntel',
      language: 'en-US',
    })
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, 'intellij_idea')
    stubOpenFetch(() => json({ ok: true, effective_target_id: 'finder' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const checked = screen
      .getByTestId('topbar-open-workspace-menu')
      .querySelector('[aria-checked="true"]')
    expect(checked?.getAttribute('data-testid')).toBe('topbar-open-workspace-option-finder')
  })

  test('localStorage write failures still update the in-memory selection', () => {
    const originalSet = window.localStorage.setItem.bind(window.localStorage)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((k, v) => {
      if (k === PREFERRED_OPEN_TARGET_STORAGE_KEY) throw new Error('QuotaExceededError')
      originalSet(k, v)
    })
    const calls = stubOpenFetch(() => json({ ok: true, effective_target_id: 'cursor' }, 200))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const menu = screen.getByTestId('topbar-open-workspace-menu')
    fireEvent.click(within(menu).getByTestId('topbar-open-workspace-option-cursor'))

    // Re-open the menu — the selection must reflect the in-memory state even
    // though persistence was rejected. This is the property under test, not
    // "the click didn't throw".
    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron'))
    const checked = screen
      .getByTestId('topbar-open-workspace-menu')
      .querySelector('[aria-checked="true"]')
    expect(checked?.getAttribute('data-testid')).toBe('topbar-open-workspace-option-cursor')

    // And the next Open click uses the new selection, proving the handler
    // fully consumed the choice rather than silently aborting.
    fireEvent.click(screen.getByTestId('topbar-open-workspace-chevron')) // close menu
    fireEvent.click(screen.getByTestId('topbar-open-workspace'))
    return waitFor(() => {
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toEqual({ target_id: 'cursor' })
    })
  })

  test('rapid double-click on Open only fires one fetch (in-flight guard)', async () => {
    // Hold the fetch promise open so the second click happens while the first
    // is still in flight.
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((r) => {
      resolve = r
    })
    const calls = stubOpenFetch(() => pending)

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))
    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    // Even though we fired two clicks synchronously, only one request is in
    // flight. (Disabling the button is necessary but not sufficient — this
    // also catches a regression where the handler short-circuits but the
    // disabled state is set after a microtask boundary.)
    expect(calls).toHaveLength(1)

    resolve(json({ ok: true, effective_target_id: 'finder' }, 200))
    await waitFor(() => expect(calls).toHaveLength(1))
  })

  test('non-200/502 status throws and surfaces error.message in a toast', async () => {
    stubOpenFetch(() => json({ error: 'boom' }, 500))

    renderHarness(<OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    const toaster = await screen.findByTestId('toaster')
    expect(toaster.textContent).toContain('boom')
  })
})
