// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useShortcutAction } from '../../web/src/pwa/use-shortcut-action.js'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('useShortcutAction', () => {
  test('does nothing while `ready` is false', () => {
    window.history.replaceState({}, '', '/?action=add-workspace')
    const onAddWorkspace = vi.fn()

    renderHook(() => useShortcutAction({ onAddWorkspace, ready: false }))

    expect(onAddWorkspace).not.toHaveBeenCalled()
    // URL untouched while we're not ready yet.
    expect(window.location.search).toBe('?action=add-workspace')
  })

  test('?action=add-workspace fires onAddWorkspace once and clears the query string', () => {
    window.history.replaceState({}, '', '/?action=add-workspace')
    const onAddWorkspace = vi.fn()

    renderHook(() => useShortcutAction({ onAddWorkspace, ready: true }))

    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('')
  })

  test('unknown ?action values are ignored and the URL is left untouched', () => {
    window.history.replaceState({}, '', '/?action=delete-everything')
    const onAddWorkspace = vi.fn()

    renderHook(() => useShortcutAction({ onAddWorkspace, ready: true }))

    expect(onAddWorkspace).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?action=delete-everything')
  })

  test('extra query params alongside a known action are dropped (URL cleaned), action still fires', () => {
    window.history.replaceState({}, '', '/?action=add-workspace&path=%2Fevil&fbclid=x')
    const onAddWorkspace = vi.fn()

    renderHook(() => useShortcutAction({ onAddWorkspace, ready: true }))

    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('')
    // The handler signature is parameterless — there's no way for `?path=...`
    // to influence the workspace creation, but the URL cleanup is the visible
    // contract that confirms we ignored it.
  })

  test('rerenders and toggling `ready` do not double-fire after one dispatch', () => {
    window.history.replaceState({}, '', '/?action=add-workspace')
    const onAddWorkspace = vi.fn()

    const { rerender } = renderHook(({ ready }) => useShortcutAction({ onAddWorkspace, ready }), {
      initialProps: { ready: true },
    })

    rerender({ ready: false })
    rerender({ ready: true })
    rerender({ ready: true })

    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  test('an empty query string after ready=true triggers nothing', () => {
    const onAddWorkspace = vi.fn()
    renderHook(() => useShortcutAction({ onAddWorkspace, ready: true }))
    expect(onAddWorkspace).not.toHaveBeenCalled()
  })
})
