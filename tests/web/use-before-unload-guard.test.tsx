// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetBeforeUnloadGuardForTests,
  allowNextUnloadSilently,
  silentReload,
  useBeforeUnloadGuard,
} from '../../web/src/useBeforeUnloadGuard.js'

let originalLocation: Location
let reloadSpy: ReturnType<typeof vi.fn>

const installLocationSpy = () => {
  originalLocation = window.location
  reloadSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
}

const restoreLocation = () => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  })
}

const dispatchBeforeUnload = () => {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  Object.defineProperty(event, 'returnValue', {
    configurable: true,
    value: undefined,
    writable: true,
  })
  const allowed = window.dispatchEvent(event)
  return { allowed, event }
}

beforeEach(() => {
  __resetBeforeUnloadGuardForTests()
})

afterEach(() => {
  cleanup()
})

describe('useBeforeUnloadGuard', () => {
  test('prevents tab close while protected work is running', () => {
    renderHook(() => useBeforeUnloadGuard(true))

    const { allowed, event } = dispatchBeforeUnload()

    expect(allowed).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(event.returnValue).toBe('')
  })

  test('does not intercept tab close when guard is disabled', () => {
    const { rerender } = renderHook(({ enabled }) => useBeforeUnloadGuard(enabled), {
      initialProps: { enabled: true },
    })
    rerender({ enabled: false })

    const { allowed, event } = dispatchBeforeUnload()

    expect(allowed).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  test('allowNextUnloadSilently lets a single beforeunload pass through and then re-arms', () => {
    renderHook(() => useBeforeUnloadGuard(true))

    allowNextUnloadSilently()

    const first = dispatchBeforeUnload()
    expect(first.allowed).toBe(true)
    expect(first.event.defaultPrevented).toBe(false)

    // The flag is one-shot: the next unload should go back to being blocked.
    const second = dispatchBeforeUnload()
    expect(second.allowed).toBe(false)
    expect(second.event.defaultPrevented).toBe(true)
  })

  test('silentReload arms the guard and triggers window.location.reload atomically', () => {
    installLocationSpy()
    try {
      renderHook(() => useBeforeUnloadGuard(true))

      silentReload()
      expect(reloadSpy).toHaveBeenCalledTimes(1)

      // The reload jsdom-stubbed away; verify the flag was armed by dispatching
      // a beforeunload and asserting it slipped past the guard.
      const { allowed, event } = dispatchBeforeUnload()
      expect(allowed).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      restoreLocation()
    }
  })
})
