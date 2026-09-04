// @vitest-environment jsdom

import { describe, expect, test } from 'vitest'

import { resolveTerminalShortcut, SHORTCUT_BYTES } from '../../web/src/terminal/shortcuts.js'

const ev = (
  type: 'keydown' | 'keypress' | 'keyup',
  key: string,
  modifiers: { meta?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } = {}
): KeyboardEvent =>
  new KeyboardEvent(type, {
    key,
    metaKey: modifiers.meta ?? false,
    altKey: modifiers.alt ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
  })

describe('resolveTerminalShortcut — cross-platform Shift+Enter', () => {
  test('emits CSI u sequence on keypress', () => {
    const action = resolveTerminalShortcut(ev('keypress', 'Enter', { shift: true }))
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.shiftEnter })
  })

  test('blocks the keydown so xterm does not emit a plain CR', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Enter', { shift: true }))
    expect(action).toEqual({ kind: 'block' })
  })

  test('plain Enter (no shift) passes through', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Enter'))
    expect(action).toEqual({ kind: 'passthrough' })
  })
})

describe('resolveTerminalShortcut — macOS Cmd mappings', () => {
  test('Cmd+Backspace → kill to line start', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Backspace', { meta: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.killToLineStart })
  })

  test('Cmd+ArrowLeft → line start', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'ArrowLeft', { meta: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.lineStart })
  })

  test('Cmd+ArrowRight → line end', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'ArrowRight', { meta: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.lineEnd })
  })

  test('Cmd+K → terminal clear', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'k', { meta: true }), { isMac: true })
    expect(action).toEqual({ kind: 'clear' })
  })

  test('Cmd+Shift+K passes through (extra modifier disables the binding)', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'k', { meta: true, shift: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'passthrough' })
  })
})

describe('resolveTerminalShortcut — macOS Option mappings', () => {
  test('Option+Backspace → kill word back', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Backspace', { alt: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.killWordBack })
  })

  test('Option+ArrowLeft → word back', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'ArrowLeft', { alt: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.wordBack })
  })

  test('Option+ArrowRight → word forward', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'ArrowRight', { alt: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.wordForward })
  })
})

describe('resolveTerminalShortcut — platform gating', () => {
  test('Cmd+Backspace on non-mac platform passes through (Linux ctrl+u already works)', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Backspace', { meta: true }), {
      isMac: false,
    })
    expect(action).toEqual({ kind: 'passthrough' })
  })

  test('Option+Backspace on non-mac also passes through', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'Backspace', { alt: true }), {
      isMac: false,
    })
    expect(action).toEqual({ kind: 'passthrough' })
  })

  test('Shift+Enter is still mapped on non-mac (cross-platform)', () => {
    const action = resolveTerminalShortcut(ev('keypress', 'Enter', { shift: true }), {
      isMac: false,
    })
    expect(action).toEqual({ kind: 'send', bytes: SHORTCUT_BYTES.shiftEnter })
  })
})

describe('resolveTerminalShortcut — non-keydown events', () => {
  test('keyup of a mapped key passes through', () => {
    const action = resolveTerminalShortcut(ev('keyup', 'Backspace', { meta: true }), {
      isMac: true,
    })
    expect(action).toEqual({ kind: 'passthrough' })
  })

  test('plain alphanumeric keydown passes through', () => {
    const action = resolveTerminalShortcut(ev('keydown', 'a'), { isMac: true })
    expect(action).toEqual({ kind: 'passthrough' })
  })
})

describe('SHORTCUT_BYTES — exact byte sequences', () => {
  test('readline-standard byte values', () => {
    expect(SHORTCUT_BYTES.killToLineStart).toBe('\x15') // Ctrl+U
    expect(SHORTCUT_BYTES.lineStart).toBe('\x01') // Ctrl+A
    expect(SHORTCUT_BYTES.lineEnd).toBe('\x05') // Ctrl+E
    expect(SHORTCUT_BYTES.killWordBack).toBe('\x1b\x7f')
    expect(SHORTCUT_BYTES.wordBack).toBe('\x1bb')
    expect(SHORTCUT_BYTES.wordForward).toBe('\x1bf')
    expect(SHORTCUT_BYTES.shiftEnter).toBe('\x1b[13;2u')
  })
})
