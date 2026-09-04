/**
 * Browser-side keyboard shortcut resolver for the terminal. macOS users
 * muscle-memory editing keys from Terminal.app / iTerm2 (Cmd+Backspace,
 * Cmd+Left, etc.), but browsers swallow Cmd-prefixed keys before xterm.js
 * can react. This pure function maps a `KeyboardEvent` to a terminal action
 * so `useTerminalRun` can reclaim those keys and emit the readline-standard
 * byte sequences every CLI agent we ship (Claude Code / Codex / OpenCode ) honors.
 *
 * Cross-platform: Shift+Enter is mapped on every platform so multi-line CLI
 * prompts work. All Cmd/Option mappings only fire on macOS — Linux/Windows
 * users already get the equivalent Ctrl/Alt bytes straight through xterm.js,
 * and remapping there would risk double-emission.
 */

export type TerminalShortcutAction =
  | { kind: 'send'; bytes: string }
  | { kind: 'clear' }
  | { kind: 'block' }
  | { kind: 'passthrough' }

// TODO: navigator.platform was deprecated in 2022 but still ships in every
// browser. Migrate to navigator.userAgentData?.platform once Chromium adoption
// of UA-CH is the norm (Firefox/Safari are still gating it).
export const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

// Readline-standard byte sequences. Every CLI agent we ship honors these,
// so emitting them is the safest possible interception target. Constants
// rather than inline magic numbers so the test file can import + compare.
export const SHORTCUT_BYTES = {
  /** Ctrl+U — kill from cursor back to line start (readline `unix-line-discard`). */
  killToLineStart: '\x15',
  /** Ctrl+A — beginning of line. */
  lineStart: '\x01',
  /** Ctrl+E — end of line. */
  lineEnd: '\x05',
  /** Alt+Backspace — kill the previous whitespace-delimited word. */
  killWordBack: '\x1b\x7f',
  /** Alt+b — move cursor one word back. */
  wordBack: '\x1bb',
  /** Alt+f — move cursor one word forward. */
  wordForward: '\x1bf',
  /** CSI u (xterm extended keys) — Shift+Enter for multi-line input. */
  shiftEnter: '\x1b[13;2u',
} as const

export const resolveTerminalShortcut = (
  event: KeyboardEvent,
  options: { isMac?: boolean } = {}
): TerminalShortcutAction => {
  const isMac = options.isMac ?? isMacPlatform()

  // Cross-platform: Shift+Enter → CSI u sequence so multi-line input works
  // in CLI agents that opt into the modifyOtherKeys protocol.
  if (event.key === 'Enter' && event.shiftKey) {
    return event.type === 'keypress'
      ? { kind: 'send', bytes: SHORTCUT_BYTES.shiftEnter }
      : { kind: 'block' }
  }

  if (!isMac || event.type !== 'keydown') return { kind: 'passthrough' }

  const cmdOnly = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  const optOnly = event.altKey && !event.metaKey && !event.ctrlKey

  if (cmdOnly) {
    switch (event.key) {
      case 'Backspace':
        return { kind: 'send', bytes: SHORTCUT_BYTES.killToLineStart }
      case 'ArrowLeft':
        return { kind: 'send', bytes: SHORTCUT_BYTES.lineStart }
      case 'ArrowRight':
        return { kind: 'send', bytes: SHORTCUT_BYTES.lineEnd }
      case 'k':
      case 'K':
        return { kind: 'clear' }
    }
  }

  if (optOnly) {
    switch (event.key) {
      case 'Backspace':
        return { kind: 'send', bytes: SHORTCUT_BYTES.killWordBack }
      case 'ArrowLeft':
        return { kind: 'send', bytes: SHORTCUT_BYTES.wordBack }
      case 'ArrowRight':
        return { kind: 'send', bytes: SHORTCUT_BYTES.wordForward }
    }
  }

  return { kind: 'passthrough' }
}
