// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  TERMINAL_PANEL_MIN_HEIGHT,
  useTerminalPanelHeight,
} from '../../web/src/terminal/useTerminalPanelHeight.js'

const HEIGHT_KEY = 'gachi.terminal-panel.height'
const COLLAPSED_KEY = 'gachi.terminal-panel.collapsed'

// jsdom lacks PointerEvent; alias to MouseEvent (same shape we use: clientY, bubbles).
if (typeof globalThis.PointerEvent === 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: jsdom test polyfill
  ;(globalThis as any).PointerEvent = class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init: MouseEventInit = {}) {
      super(type, init)
    }
  }
}

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
})

afterEach(() => {
  window.localStorage.clear()
})

describe('useTerminalPanelHeight', () => {
  test('uses viewport-based default on first read', () => {
    const { result } = renderHook(() => useTerminalPanelHeight())
    expect(result.current.height).toBe(Math.floor(900 * 0.35))
    expect(result.current.collapsed).toBe(false)
  })

  test('clamps stored height below minimum back up to min', () => {
    window.localStorage.setItem(HEIGHT_KEY, '40')
    const { result } = renderHook(() => useTerminalPanelHeight())
    expect(result.current.height).toBe(TERMINAL_PANEL_MIN_HEIGHT)
  })

  test('persists height changes to localStorage', () => {
    const { result } = renderHook(() => useTerminalPanelHeight())
    act(() => result.current.setHeight(420))
    expect(window.localStorage.getItem(HEIGHT_KEY)).toBe('420')
  })

  test('toggling collapsed persists', () => {
    const { result } = renderHook(() => useTerminalPanelHeight())
    act(() => result.current.setCollapsed(true))
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('1')
    expect(result.current.collapsed).toBe(true)
  })

  test('beginDrag stores body cursor/userSelect and restores on pointerup', () => {
    const { result } = renderHook(() => useTerminalPanelHeight())
    document.body.style.userSelect = 'text'
    document.body.style.cursor = 'auto'
    act(() => {
      const event = new PointerEvent('pointerdown', { clientY: 500, bubbles: true })
      result.current.beginDrag(event as unknown as React.PointerEvent<HTMLDivElement>)
    })
    expect(document.body.style.cursor).toBe('ns-resize')
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup'))
    })
    expect(document.body.style.cursor).toBe('auto')
    expect(document.body.style.userSelect).toBe('text')
  })
})
