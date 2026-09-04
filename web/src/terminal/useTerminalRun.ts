import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { uploadWorkspaceAttachment } from '../api.js'
import { resolveTerminalShortcut } from './shortcuts.js'
import { createTerminalClient } from './terminal-client.js'
import {
  attachAlternateScreenWheelFallback,
  type TerminalWheelInputProfile,
} from './wheelFallback.js'

const LEGACY_MOUSE_REPORT_PATTERN = new RegExp(
  `${String.fromCharCode(0x1b)}\\[M([\\s\\S])([\\s\\S])([\\s\\S])`,
  'g'
)

const legacyMouseReportToSgr = (
  report: string,
  codeChar: string,
  colChar: string,
  rowChar: string
) => {
  const code = codeChar.charCodeAt(0) - 32
  const col = colChar.charCodeAt(0) - 32
  const row = rowChar.charCodeAt(0) - 32
  if (code < 0 || col < 1 || row < 1) return report
  const isRelease = (code & 3) === 3 && (code & 32) === 0 && (code & 64) === 0
  const final = isRelease ? 'm' : 'M'
  return `\x1b[<${code};${col};${row}${final}`
}

const normalizeBinaryTerminalInput = (
  chunk: string,
  inputProfile: TerminalWheelInputProfile
): { binary: boolean; chunk: string } => {
  if (inputProfile !== 'opencode') return { binary: true, chunk }
  const normalized = chunk.replace(LEGACY_MOUSE_REPORT_PATTERN, legacyMouseReportToSgr)
  return {
    binary: normalized === chunk,
    chunk: normalized,
  }
}

export const useTerminalRun = (
  runId: string,
  inputProfile: TerminalWheelInputProfile = 'default'
) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'stopped'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false
    let onWindowResize: (() => void) | undefined
    let binaryInputSubscription: { dispose: () => void } | undefined
    let inputSubscription: { dispose: () => void } | undefined
    let client: ReturnType<typeof createTerminalClient> | undefined
    let terminal: XtermTerminal | undefined
    let fitAddon: XtermFitAddon | undefined
    let resizeObserver: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    let resizeTimer: number | undefined
    let wheelFallbackDispose: (() => void) | undefined
    let helperTextarea: HTMLTextAreaElement | null = null
    let onCompositionStart: ((event: Event) => void) | undefined
    let onCompositionEnd: ((event: Event) => void) | undefined
    let onPasteListener: ((event: ClipboardEvent) => void) | undefined
    let onContextMenuListener: ((event: MouseEvent) => void) | undefined
    const isComposingRef = { current: false }

    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-unicode11'),
      import('@xterm/addon-clipboard'),
    ]).then(([xtermModule, fitModule, unicode11Module, clipboardModule]) => {
      if (disposed || !containerRef.current) return

      // Read xterm background from CSS so it stays in sync if the palette
      // shifts. Falls back to bg-crust's literal value if computed style is
      // unavailable (jsdom). Without this, xterm's canvas sat at #0f0f11 and
      // the wrapping container at #1b1b1b, so unfilled rows showed a seam.
      const rootStyles =
        typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
      const bgCrust = rootStyles?.getPropertyValue('--bg-crust').trim() || '#0e0e0e'
      const textPrimary = rootStyles?.getPropertyValue('--text-primary').trim() || '#ebebeb'
      const nextTerminal = new xtermModule.Terminal({
        allowProposedApi: true,
        convertEol: false,
        fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        letterSpacing: 0,
        lineHeight: 1,
        scrollback: 10_000,
        theme: {
          background: bgCrust,
          foreground: textPrimary,
        },
      })
      // xterm reads its theme once at construction — it does not watch CSS
      // custom properties. Re-apply on every `data-theme` flip (the Settings
      // popover's Theme switch) so an already-open terminal pane follows the
      // app instead of staying stuck on whatever theme was active when it
      // was created.
      const applyThemeFromCss = () => {
        const styles = getComputedStyle(document.documentElement)
        const background = styles.getPropertyValue('--bg-crust').trim() || bgCrust
        const foreground = styles.getPropertyValue('--text-primary').trim() || textPrimary
        nextTerminal.options.theme = { background, foreground }
      }
      themeObserver = new MutationObserver(applyThemeFromCss)
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })

      const nextFitAddon = new fitModule.FitAddon()
      nextTerminal.loadAddon(nextFitAddon)
      nextTerminal.loadAddon(new unicode11Module.Unicode11Addon())
      nextTerminal.unicode.activeVersion = '11'
      nextTerminal.loadAddon(new clipboardModule.ClipboardAddon())
      nextTerminal.open(containerRef.current)
      nextFitAddon.fit()
      terminal = nextTerminal
      fitAddon = nextFitAddon
      wheelFallbackDispose = attachAlternateScreenWheelFallback({
        element: containerRef.current,
        profile: inputProfile,
        sendInput: (chunk) => client?.sendInput(chunk),
        terminal: nextTerminal,
      })

      void import('@xterm/addon-web-links')
        .then((webLinksModule) => {
          if (disposed || terminal !== nextTerminal) return
          nextTerminal.loadAddon(new webLinksModule.WebLinksAddon())
        })
        .catch(() => {
          // Keep the core terminal usable when optional addons fail to load.
        })

      // Deliberately NOT loading @xterm/addon-webgl. The GPU-accelerated
      // renderer produces stale/blank glyph-atlas artifacts (empty boxes,
      // "jumping" text) under frequent resize + rapid scroll — exactly the
      // pattern the panel sees when a worker's PTY streams fast output while
      // its host pane is being resized. The default 2D canvas renderer is
      // slower per-frame but never desyncs its backing texture, so it wins
      // for a terminal that has to stay legible over raw throughput.

      // Take over IME composition so xterm's built-in CompositionHelper does
      // not emit spurious DEL (0x7f) bytes after each commit. Without this,
      // typing CJK in Claude Code's TUI prompt would commit the CJK chars
      // and then send a growing run of DELs that erased surrounding text.
      helperTextarea =
        containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (helperTextarea) {
        const localTextarea = helperTextarea
        onCompositionStart = () => {
          isComposingRef.current = true
        }
        onCompositionEnd = (event: Event) => {
          const composed = (event as CompositionEvent).data
          if (composed) client?.sendInput(composed)
          // Clear the textarea so xterm's built-in helper has nothing to
          // commit on its deferred setTimeout(0) read, and so its tracked
          // value never accumulates across compositions.
          localTextarea.value = ''
          // Release the flag in a later macrotask so the built-in helper's
          // own setTimeout(0) work fires while we are still filtering.
          setTimeout(() => {
            isComposingRef.current = false
          }, 0)
        }
        helperTextarea.addEventListener('compositionstart', onCompositionStart, { capture: true })
        helperTextarea.addEventListener('compositionend', onCompositionEnd, { capture: true })
      }

      const handleImageBlob = async (blob: Blob, filename?: string) => {
        return new Promise<void>((resolve) => {
          const reader = new FileReader()
          reader.onload = async () => {
            const base64 = reader.result as string
            try {
              const res = await uploadWorkspaceAttachment('', base64, filename)
              if (res?.relative_path) {
                client?.sendInput(res.relative_path + ' ')
              }
            } catch (err) {
              console.error('Failed to upload pasted image', err)
            }
            resolve()
          }
          reader.readAsDataURL(blob)
        })
      }

      const handlePaste = async (dataTransfer?: DataTransfer | null) => {
        if (dataTransfer) {
          const items = Array.from(dataTransfer.items || [])
          const imageItem = items.find((item) => item.type.startsWith('image/'))
          if (imageItem) {
            const file = imageItem.getAsFile()
            if (file) {
              await handleImageBlob(file, file.name)
              return
            }
          }
          const text = dataTransfer.getData('text/plain')
          if (text) {
            client?.sendInput(text)
            return
          }
        }

        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            if (navigator.clipboard.read) {
              try {
                const clipItems = await navigator.clipboard.read()
                for (const item of clipItems) {
                  const imageType = item.types.find((t) => t.startsWith('image/'))
                  if (imageType) {
                    const blob = await item.getType(imageType)
                    await handleImageBlob(
                      blob,
                      `clipboard_image.${imageType.split('/')[1] || 'png'}`
                    )
                    return
                  }
                }
              } catch {}
            }

            const text = await navigator.clipboard.readText()
            if (text) {
              client?.sendInput(text)
            }
          }
        } catch (err) {
          console.error('Failed to paste from clipboard', err)
        }
      }

      if (typeof nextTerminal.attachCustomKeyEventHandler === 'function') {
        nextTerminal.attachCustomKeyEventHandler((event) => {
          const isCtrlOrCmd = event.ctrlKey || event.metaKey

          // Match by PHYSICAL key code, not event.key: on non-English keyboard
          // layouts (e.g. Russian Ctrl+V → event.key === 'м') the character
          // differs and layout-sensitive matching silently breaks copy/paste.
          const isPhysicalC = event.key === 'c' || event.key === 'C' || event.code === 'KeyC'
          const isPhysicalV = event.key === 'v' || event.key === 'V' || event.code === 'KeyV'

          // 1. Copy selection on Ctrl+C / Cmd+C without sending interrupt \x03
          if (event.type === 'keydown' && isCtrlOrCmd && !event.shiftKey && isPhysicalC) {
            if (nextTerminal.hasSelection()) {
              const selected = nextTerminal.getSelection()
              if (selected) {
                void navigator.clipboard?.writeText(selected)
                return false
              }
            }
          }

          // 2. Paste with Ctrl+V / Cmd+V / Shift+Insert
          if (
            event.type === 'keydown' &&
            ((isCtrlOrCmd && !event.shiftKey && isPhysicalV) ||
              (event.shiftKey && (event.key === 'Insert' || event.code === 'Insert')))
          ) {
            // Return FALSE so xterm does not consume the key: the browser then
            // dispatches a native `paste` event on the focused helper textarea,
            // which the capture listener below turns into input via
            // `event.clipboardData` — no clipboard-read permission required
            // (unlike the `navigator.clipboard.readText()` fallback).
            helperTextarea?.focus()
            let pastedViaNativeEvent = false
            const markPasted = () => {
              pastedViaNativeEvent = true
            }
            window.addEventListener('paste', markPasted, { once: true, capture: true })
            setTimeout(() => {
              window.removeEventListener('paste', markPasted, { capture: true })
              if (!pastedViaNativeEvent) {
                void handlePaste()
              }
            }, 60)
            return false
          }

          const action = resolveTerminalShortcut(event)
          switch (action.kind) {
            case 'send':
              event.preventDefault()
              client?.sendInput(action.bytes)
              return false
            case 'clear':
              event.preventDefault()
              nextTerminal.clear()
              return false
            case 'block':
              return false
            case 'passthrough':
              return true
          }
        })
      }

      onPasteListener = (event: ClipboardEvent) => {
        event.preventDefault()
        event.stopPropagation()
        void handlePaste(event.clipboardData)
      }

      onContextMenuListener = (event: MouseEvent) => {
        // Suppress the browser's native context menu so its "Paste" item cannot
        // inject text into the terminal unexpectedly. Right-click should never
        // paste — copy of the current selection is done programmatically below.
        event.preventDefault()
        if (nextTerminal.hasSelection()) {
          const selected = nextTerminal.getSelection()
          if (selected) {
            void navigator.clipboard?.writeText(selected)
          }
        }
      }

      if (helperTextarea) {
        helperTextarea.addEventListener('paste', onPasteListener, { capture: true })
      }
      containerRef.current.addEventListener('paste', onPasteListener, { capture: true })
      containerRef.current.addEventListener('contextmenu', onContextMenuListener)

      const isContainerResizable = (): boolean => {
        const container = containerRef.current
        if (!container?.isConnected) return false
        return !container.closest('[data-terminal-host-parked="true"]')
      }
      const getContainerPixels = (): { pixelHeight?: number; pixelWidth?: number } => {
        if (!containerRef.current) return {}
        const pixelWidth = containerRef.current.clientWidth
        const pixelHeight = containerRef.current.clientHeight
        const pixels: { pixelHeight?: number; pixelWidth?: number } = {}
        if (pixelHeight > 0) pixels.pixelHeight = pixelHeight
        if (pixelWidth > 0) pixels.pixelWidth = pixelWidth
        return pixels
      }
      const resize = () => {
        if (!containerRef.current || !isContainerResizable()) return
        fitAddon?.fit()
        // fit() recalculates cols/rows but the canvas renderer's dirty-region
        // tracking can leave stale pixels behind when the resize lands mid-
        // stream (fast PTY output + a panel drag/portal move in the same
        // frame) — the exact "text doubles / drifts" pattern reported after
        // resizing. A full refresh forces every visible row to repaint from
        // the terminal's actual buffer, discarding whatever the canvas had
        // painted before the resize.
        terminal?.refresh(0, (terminal.rows ?? 1) - 1)
        const { pixelHeight, pixelWidth } = getContainerPixels()
        client?.resize(terminal?.cols ?? 80, terminal?.rows ?? 24, pixelWidth, pixelHeight)
      }
      const scheduleResize = () => {
        if (resizeTimer) window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => {
          resizeTimer = undefined
          resize()
        }, 50)
      }

      client = createTerminalClient({
        initialSize: {
          cols: nextTerminal.cols,
          rows: nextTerminal.rows,
          ...getContainerPixels(),
        },
        onError(message) {
          setError(message)
        },
        onExit() {
          setStatus('stopped')
        },
        onOutput(chunk, acknowledge) {
          nextTerminal.write(chunk, () => acknowledge(new TextEncoder().encode(chunk).byteLength))
        },
        onRestore(snapshot) {
          nextTerminal.write(snapshot)
        },
        runId,
      })
      inputSubscription = nextTerminal.onData((chunk) => {
        if (isComposingRef.current) return
        client?.sendInput(chunk)
      })
      if (typeof nextTerminal.onBinary === 'function') {
        binaryInputSubscription = nextTerminal.onBinary((chunk) => {
          const normalized = normalizeBinaryTerminalInput(chunk, inputProfile)
          if (normalized.binary) client?.sendBinaryInput(normalized.chunk)
          else client?.sendInput(normalized.chunk)
        })
      }
      setStatus('running')
      resize()
      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(scheduleResize)
        resizeObserver.observe(containerRef.current)
      }
      onWindowResize = () => resize()
      window.addEventListener('resize', onWindowResize)
    })

    return () => {
      disposed = true
      if (onWindowResize) window.removeEventListener('resize', onWindowResize)
      themeObserver?.disconnect()
      resizeObserver?.disconnect()
      if (resizeTimer) window.clearTimeout(resizeTimer)
      wheelFallbackDispose?.()
      if (helperTextarea && onCompositionStart) {
        helperTextarea.removeEventListener('compositionstart', onCompositionStart, {
          capture: true,
        } as EventListenerOptions)
      }
      if (helperTextarea && onCompositionEnd) {
        helperTextarea.removeEventListener('compositionend', onCompositionEnd, {
          capture: true,
        } as EventListenerOptions)
      }
      if (helperTextarea && onPasteListener) {
        helperTextarea.removeEventListener('paste', onPasteListener, {
          capture: true,
        } as EventListenerOptions)
      }
      if (containerRef.current && onPasteListener) {
        containerRef.current.removeEventListener('paste', onPasteListener)
      }
      if (containerRef.current && onContextMenuListener) {
        containerRef.current.removeEventListener('contextmenu', onContextMenuListener)
      }
      binaryInputSubscription?.dispose()
      inputSubscription?.dispose()
      client?.dispose()
      terminal?.dispose()
      fitAddon?.dispose()
    }
  }, [runId, inputProfile])

  return { containerRef, error, status }
}
