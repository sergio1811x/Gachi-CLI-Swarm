// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { TerminalView } from '../../web/src/terminal/TerminalView.js'

let latestCustomKeyHandler: ((event: KeyboardEvent) => boolean) | undefined
let latestCustomWheelHandler: ((event: WheelEvent) => boolean) | undefined
let latestOnBinaryHandler: ((chunk: string) => void) | undefined
let latestOnDataHandler: ((chunk: string) => void) | undefined
let terminalMouseReport = '\x1b[M !!'
let terminalWrites: string[] = []
let terminalLoadEvents: string[] = []
let terminalBufferType: 'alternate' | 'normal' = 'normal'
let terminalMouseTrackingMode: 'any' | 'drag' | 'none' | 'vt200' | 'x10' = 'none'
let terminalApplicationCursorKeysMode = false
let terminalDisposeCount = 0
let terminalOpenCount = 0
let websocketCloseCount = 0

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly OPEN = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  sent: Array<string | Uint8Array> = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    terminalLoadEvents.push('websocket')
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.onopen?.()
    })
  }

  close() {
    this.readyState = 3
    websocketCloseCount += 1
  }

  send(payload: string | Uint8Array) {
    if (this.readyState !== this.OPEN) return
    this.sent.push(payload)
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  constructor(readonly callback: () => void) {
    MockResizeObserver.instances.push(this)
  }

  disconnect() {}
  observe() {}
  trigger() {
    this.callback()
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 132
    rows = 43
    private customWheelHandler: ((event: WheelEvent) => boolean) | undefined
    unicode = { activeVersion: '' }
    get buffer() {
      return { active: { type: terminalBufferType } }
    }
    get modes() {
      return {
        applicationCursorKeysMode: terminalApplicationCursorKeysMode,
        mouseTrackingMode: terminalMouseTrackingMode,
      }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      latestCustomKeyHandler = handler
    }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
      latestCustomWheelHandler = handler
      this.customWheelHandler = handler
    }
    loadAddon(addon: { addonName?: string }) {
      terminalLoadEvents.push(addon.addonName ?? 'unknown')
    }
    onBinary(handler: (chunk: string) => void) {
      latestOnBinaryHandler = handler
      return { dispose() {} }
    }
    onData(handler: (chunk: string) => void) {
      latestOnDataHandler = handler
      return { dispose() {} }
    }
    refresh() {}
    open(element: HTMLElement) {
      terminalLoadEvents.push('open')
      terminalOpenCount += 1
      element.addEventListener('wheel', (event) => {
        if (this.customWheelHandler?.(event) === false) {
          event.preventDefault()
          event.stopPropagation()
        }
      })
      element.addEventListener('mousedown', () => {
        latestOnBinaryHandler?.(terminalMouseReport)
      })
    }
    write(chunk?: string, callback?: () => void) {
      if (chunk !== undefined) terminalWrites.push(chunk)
      callback?.()
    }
    dispose() {
      terminalDisposeCount += 1
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    addonName = 'fit'
    fit() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    addonName = 'unicode11'
  },
}))

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    addonName = 'clipboard'
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    addonName = 'webLinks'
  },
}))

afterEach(() => {
  cleanup()
  MockWebSocket.instances = []
  MockResizeObserver.instances = []
  latestCustomKeyHandler = undefined
  latestCustomWheelHandler = undefined
  latestOnBinaryHandler = undefined
  latestOnDataHandler = undefined
  terminalMouseReport = '\x1b[M !!'
  terminalWrites = []
  terminalLoadEvents = []
  terminalApplicationCursorKeysMode = false
  terminalBufferType = 'normal'
  terminalDisposeCount = 0
  terminalMouseTrackingMode = 'none'
  terminalOpenCount = 0
  websocketCloseCount = 0
  vi.unstubAllGlobals()
})

const addPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `orch-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const addWorkerPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `worker-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const addShellPortalSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `shell-pty-${runId}`
  document.body.appendChild(slot)
  return slot
}

const binaryInput = (chunk: string) =>
  Uint8Array.from(chunk, (character) => character.charCodeAt(0) & 0xff)

describe('TerminalView', () => {
  test('opens io and control sockets for the provided run id', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-123')

    render(<TerminalView runId="run-123" title="Alice" />)

    await waitFor(() => {
      const urls = MockWebSocket.instances.map((socket) => new URL(socket.url))
      expect(urls.map((url) => url.pathname)).toEqual([
        '/ws/terminal/run-123/io',
        '/ws/terminal/run-123/control',
      ])
      expect(urls[0]?.searchParams.get('clientId')).toBeTruthy()
      expect(urls[1]?.searchParams.get('clientId')).toBe(urls[0]?.searchParams.get('clientId'))
      expect(urls[0]?.searchParams.get('cols')).toBe('132')
      expect(urls[0]?.searchParams.get('rows')).toBe('43')
    })
  })

  test('sends the initial fit resize after the control socket opens', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-resize')

    render(<TerminalView runId="run-resize" title="Alice" />)

    await waitFor(() => {
      const controlSocket = MockWebSocket.instances[1]
      expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
        type: 'resize',
        cols: 132,
        rows: 43,
      })
    })
  })

  test('loads critical addons before connecting sockets and visual addons after open', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-staged-addons')

    render(<TerminalView runId="run-staged-addons" title="Alice" />)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('open')
    })
    const openIndex = terminalLoadEvents.indexOf('open')
    expect(terminalLoadEvents.indexOf('fit')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('fit')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('unicode11')).toBeLessThan(openIndex)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeGreaterThanOrEqual(0)
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(openIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toContain('websocket')
    })
    const websocketIndex = terminalLoadEvents.indexOf('websocket')
    expect(terminalLoadEvents.indexOf('clipboard')).toBeLessThan(websocketIndex)

    await waitFor(() => {
      expect(terminalLoadEvents).toEqual(expect.arrayContaining(['webLinks']))
    })
    expect(terminalLoadEvents.indexOf('webLinks')).toBeGreaterThan(openIndex)
    // The WebGL renderer is deliberately not loaded — see useTerminalRun.ts.
    expect(terminalLoadEvents).not.toContain('webgl')
  })

  test('resizes again when the terminal container changes size', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    addPortalSlot('run-observer')

    render(<TerminalView runId="run-observer" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
    })

    MockResizeObserver.instances[0]?.trigger()

    await waitFor(() => {
      expect(MockWebSocket.instances[1]?.sent).toHaveLength(2)
    })
  })

  test('does not render an inline terminal before a portal slot exists', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)

    render(<TerminalView runId="run-detached" title="Alice" />)

    expect(document.querySelector('[data-testid="terminal-run-detached"]')).toBeNull()
    expect(document.querySelector('section[aria-label="Terminal Alice"]')).toBeNull()
    expect(MockWebSocket.instances).toHaveLength(0)

    const slot = addPortalSlot('run-detached')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-detached"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    expect(MockWebSocket.instances.map((socket) => new URL(socket.url).pathname)).toEqual([
      '/ws/terminal/run-detached/io',
      '/ws/terminal/run-detached/control',
    ])
  })

  test('observes portal slots without a polling interval when MutationObserver is available', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    render(<TerminalView runId="run-observed-slot" title="Alice" />)

    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
    const slot = addPortalSlot('run-observed-slot')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-observed-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('uses the last matching portal slot when duplicate slots exist', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const firstSlot = addWorkerPortalSlot('run-duplicate-slot')
    const secondSlot = addWorkerPortalSlot('run-duplicate-slot')

    render(<TerminalView runId="run-duplicate-slot" title="Alice" />)

    await waitFor(() => {
      expect(firstSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).toBeNull()
      expect(secondSlot.querySelector('[data-testid="terminal-run-duplicate-slot"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  test('attaches to shell terminal portal slots', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addShellPortalSlot('run-shell')

    render(<TerminalView runId="run-shell" title="Shell" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-shell"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(new URL(MockWebSocket.instances[0]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/io'
      )
      expect(new URL(MockWebSocket.instances[1]?.url ?? '').pathname).toBe(
        '/ws/terminal/run-shell/control'
      )
    })
  })

  test('keeps the same xterm session alive when the portal slot is recreated', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    let slot = addPortalSlot('run-stable')

    render(<TerminalView runId="run-stable" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockResizeObserver.instances).toHaveLength(1)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    const sentBeforeVisibleResize = controlSocket?.sent.length ?? 0
    MockResizeObserver.instances[0]?.trigger()
    await waitFor(() => {
      expect(controlSocket?.sent).toHaveLength(sentBeforeVisibleResize + 1)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(websocketCloseCount).toBe(0)
    expect(terminalDisposeCount).toBe(0)
    const sentBeforeHiddenResize = controlSocket?.sent.length ?? 0
    window.dispatchEvent(new Event('resize'))
    MockResizeObserver.instances[0]?.trigger()
    await new Promise((resolve) => window.setTimeout(resolve, 75))
    expect(controlSocket?.sent).toHaveLength(sentBeforeHiddenResize)

    slot = addPortalSlot('run-stable')

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-stable"]')).not.toBeNull()
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(terminalOpenCount).toBe(1)
    expect(terminalDisposeCount).toBe(0)
    await waitFor(() => {
      expect(controlSocket?.sent.length).toBeGreaterThan(sentBeforeHiddenResize)
    })
    const sentBeforeProtocolMessages = controlSocket?.sent.length ?? 0

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })
    ioSocket?.onmessage?.({ data: 'live-after-reattach' })
    expect(terminalWrites).toEqual(['restored-history', 'live-after-reattach'])
    const controlMessagesAfterReattach = controlSocket?.sent
      .slice(sentBeforeProtocolMessages)
      .map((payload) => JSON.parse(String(payload)))
    expect(controlMessagesAfterReattach).toEqual([
      { type: 'restore_complete' },
      { type: 'output_ack', bytes: new TextEncoder().encode('live-after-reattach').byteLength },
    ])

    latestOnDataHandler?.('typed-after-reattach')
    expect(ioSocket?.sent).toContain('typed-after-reattach')
    latestCustomKeyHandler?.(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
    )
    expect(ioSocket?.sent).toContain('\u001b[13;2u')
  })

  test('disposes the terminal session when TerminalView unmounts', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-unmount')

    const view = render(<TerminalView runId="run-unmount" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-unmount"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).not.toBeNull()
    })

    view.unmount()

    expect(document.querySelector('[data-terminal-host-run-id="run-unmount"]')).toBeNull()
    expect(document.getElementById('gachi-terminal-parking-lot')).toBeNull()
    expect(websocketCloseCount).toBe(2)
    expect(terminalDisposeCount).toBe(1)
  })

  test('disposes a parked terminal when no portal slot returns', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    const slot = addPortalSlot('run-abandoned')

    render(<TerminalView runId="run-abandoned" title="Alice" />)

    await waitFor(() => {
      expect(slot.querySelector('[data-testid="terminal-run-abandoned"]')).not.toBeNull()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    slot.remove()

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).not.toBeNull()
    })

    await waitFor(
      () => {
        expect(document.querySelector('[data-terminal-host-run-id="run-abandoned"]')).toBeNull()
        expect(document.getElementById('gachi-terminal-parking-lot')).toBeNull()
        expect(websocketCloseCount).toBe(2)
        expect(terminalDisposeCount).toBe(1)
      },
      { timeout: 1500 }
    )
  })

  test('buffers live output until the restore snapshot is written', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-restore-order')

    render(<TerminalView runId="run-restore-order" title="Alice" />)

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2)
    })
    const [ioSocket, controlSocket] = MockWebSocket.instances
    ioSocket?.onmessage?.({ data: 'live-after-attach' })

    expect(terminalWrites).toEqual([])

    controlSocket?.onmessage?.({
      data: JSON.stringify({ type: 'restore', snapshot: 'restored-history' }),
    })

    expect(terminalWrites).toEqual(['restored-history', 'live-after-attach'])
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'restore_complete',
    })
    expect(controlSocket?.sent.map((payload) => JSON.parse(String(payload)))).toContainEqual({
      type: 'output_ack',
      bytes: new TextEncoder().encode('live-after-attach').byteLength,
    })
  })

  test('maps Shift+Enter to a modified Enter sequence instead of submit Enter', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    addPortalSlot('run-shift-enter')

    render(<TerminalView runId="run-shift-enter" title="Alice" />)

    await waitFor(() => {
      expect(latestCustomKeyHandler).toBeDefined()
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
    })

    const keydownHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
    )
    const keypressHandled = latestCustomKeyHandler?.(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, shiftKey: true })
    )

    expect(keydownHandled).toBe(false)
    expect(keypressHandled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[13;2u'])
  })

  test('falls back to arrow-key wheel input for alternate-screen TUIs without mouse tracking', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-alt')

    render(<TerminalView runId="run-wheel-alt" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-alt"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B', '\u001b[A'])
  })

  test('maps OpenCode wheel input to the message viewport scroll keys', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-opencode')

    render(<TerminalView inputProfile="opencode" runId="run-wheel-opencode" title="OpenCode" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-opencode"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', '\u001b[5~'])
  })

  test('keeps OpenCode wheel fallback active when mouse tracking is reported', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    addPortalSlot('run-wheel-opencode-mouse')

    render(
      <TerminalView inputProfile="opencode" runId="run-wheel-opencode-mouse" title="OpenCode" />
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-opencode-mouse"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.wheel(terminal, { deltaY: -120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', '\u001b[5~'])
  })

  test.each([
    { legacy: '\x1b[M !!', sgr: '\x1b[<0;1;1M' },
    { legacy: '\x1b[M#!!', sgr: '\x1b[<3;1;1m' },
    { legacy: '\x1b[M@!!', sgr: '\x1b[<32;1;1M' },
    { legacy: '\x1b[MC!!', sgr: '\x1b[<35;1;1M' },
    { legacy: '\x1b[M`!!', sgr: '\x1b[<64;1;1M' },
  ])('normalizes OpenCode legacy mouse input $sgr', async ({ legacy, sgr }) => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    terminalMouseReport = legacy
    addPortalSlot('run-opencode-mouse-click')

    render(
      <TerminalView inputProfile="opencode" runId="run-opencode-mouse-click" title="OpenCode" />
    )

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-opencode-mouse-click"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await waitFor(() => {
      expect(latestCustomWheelHandler).toBeDefined()
      expect(latestOnBinaryHandler).toBeDefined()
    })

    fireEvent.wheel(terminal, { deltaY: 120 })
    fireEvent.mouseDown(terminal)

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[6~', sgr])
  })

  test('passes default terminal binary mouse input through unchanged', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = 'any'
    addPortalSlot('run-default-mouse-click')

    render(<TerminalView runId="run-default-mouse-click" title="Shell" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-default-mouse-click"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await waitFor(() => {
      expect(latestOnBinaryHandler).toBeDefined()
    })

    fireEvent.mouseDown(terminal)

    expect(MockWebSocket.instances[0]?.sent).toEqual([binaryInput('\x1b[M !!')])
  })

  test('uses application cursor arrow sequences for alternate-screen wheel fallback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalApplicationCursorKeysMode = true
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-app-cursor')

    render(<TerminalView runId="run-wheel-app-cursor" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-app-cursor"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1 })
    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: -1 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001bOB', '\u001bOA'])
  })

  test('does not amplify small trackpad wheel deltas into one input per event', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-trackpad')

    render(<TerminalView runId="run-wheel-trackpad" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-trackpad"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    for (let index = 0; index < 5; index++) {
      fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })
    }
    expect(MockWebSocket.instances[0]?.sent).toEqual([])

    fireEvent.wheel(terminal, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 10 })

    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes alternate-screen fallback wheel events before page scroll handlers run', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-consume')

    render(<TerminalView runId="run-wheel-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual(['\u001b[B'])
  })

  test('consumes small alternate-screen trackpad wheel deltas even before emitting input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    addPortalSlot('run-wheel-small-consume')

    render(<TerminalView runId="run-wheel-small-consume" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-small-consume"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    let bubbled = false
    terminal.parentElement?.addEventListener('wheel', () => {
      bubbled = true
    })

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 10,
    })
    terminal.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(bubbled).toBe(false)
    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test('keeps normal scrollback wheel events out of PTY input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'normal'
    addPortalSlot('run-wheel-normal')

    render(<TerminalView runId="run-wheel-normal" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-normal"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })

  test.each([
    'any',
    'drag',
    'vt200',
    'x10',
  ] as const)('does not duplicate xterm %s mouse tracking wheel events', async (mouseTrackingMode) => {
    vi.stubGlobal('WebSocket', MockWebSocket as never)
    terminalBufferType = 'alternate'
    terminalMouseTrackingMode = mouseTrackingMode
    addPortalSlot('run-wheel-mouse')

    render(<TerminalView runId="run-wheel-mouse" title="Alice" />)

    const terminal = await waitFor(() => {
      const node = document.querySelector('[data-testid="terminal-run-wheel-mouse"]')
      expect(MockWebSocket.instances[0]?.readyState).toBe(1)
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.wheel(terminal, { deltaY: 120 })

    expect(MockWebSocket.instances[0]?.sent).toEqual([])
  })
})
