type TerminalLike = {
  buffer?: {
    active?: {
      type?: string
    }
  }
  attachCustomWheelEventHandler?: (handler: (event: WheelEvent) => boolean) => void
  modes?: {
    applicationCursorKeysMode?: boolean
    mouseTrackingMode?: string
  }
}

const PIXELS_PER_WHEEL_LINE = 16
const TRACKPAD_DAMPING = 0.3

export type TerminalWheelInputProfile = 'default' | 'opencode'

type WheelFallbackResult = {
  input: string | null
  handled: boolean
}

const arrowSequence = (
  applicationCursorKeysMode: boolean | undefined,
  direction: 'down' | 'up'
) => {
  const finalByte = direction === 'up' ? 'A' : 'B'
  return applicationCursorKeysMode ? `\u001bO${finalByte}` : `\u001b[${finalByte}`
}

const profileSequence = (
  terminal: TerminalLike,
  profile: TerminalWheelInputProfile,
  direction: 'down' | 'up'
) => {
  if (profile === 'opencode') {
    return direction === 'up' ? '\u001b[5~' : '\u001b[6~'
  }
  return arrowSequence(terminal.modes?.applicationCursorKeysMode, direction)
}

export const createAlternateScreenWheelInputResolver = (
  terminal: TerminalLike,
  profile: TerminalWheelInputProfile = 'default'
) => {
  let partialLines = 0

  return (event: Pick<WheelEvent, 'deltaMode' | 'deltaY' | 'shiftKey'>): WheelFallbackResult => {
    if (terminal.buffer?.active?.type !== 'alternate') {
      partialLines = 0
      return { handled: false, input: null }
    }
    if (
      profile !== 'opencode' &&
      terminal.modes?.mouseTrackingMode &&
      terminal.modes.mouseTrackingMode !== 'none'
    ) {
      partialLines = 0
      return { handled: false, input: null }
    }
    if (event.deltaY === 0 || event.shiftKey) return { handled: false, input: null }

    let amount = event.deltaY
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      amount /= PIXELS_PER_WHEEL_LINE
      if (Math.abs(event.deltaY) < 50) amount *= TRACKPAD_DAMPING
      partialLines += amount
      amount = Math.trunc(partialLines)
      partialLines %= 1
    } else {
      partialLines = 0
    }

    if (amount === 0) return { handled: true, input: null }
    return {
      handled: true,
      input: profileSequence(terminal, profile, amount < 0 ? 'up' : 'down'),
    }
  }
}

export const getAlternateScreenWheelInput = (
  terminal: TerminalLike,
  event: Pick<WheelEvent, 'deltaMode' | 'deltaY' | 'shiftKey'>,
  profile: TerminalWheelInputProfile = 'default'
): string | null => {
  const resolve = createAlternateScreenWheelInputResolver(terminal, profile)
  return resolve(event).input
}

export const attachAlternateScreenWheelFallback = ({
  element,
  profile = 'default',
  sendInput,
  terminal,
}: {
  element: HTMLElement
  profile?: TerminalWheelInputProfile
  sendInput: (chunk: string) => void
  terminal: TerminalLike
}): (() => void) => {
  const resolveWheelInput = createAlternateScreenWheelInputResolver(terminal, profile)

  const handleWheel = (event: WheelEvent): boolean => {
    const { handled, input } = resolveWheelInput(event)
    if (!handled) return true
    event.preventDefault()
    event.stopPropagation()
    if (input) sendInput(input)
    return false
  }

  if (typeof terminal.attachCustomWheelEventHandler === 'function') {
    terminal.attachCustomWheelEventHandler(handleWheel)
    return () => {}
  }

  const onWheel = (event: WheelEvent) => {
    if (handleWheel(event)) return
    event.stopImmediatePropagation()
  }

  element.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => element.removeEventListener('wheel', onWheel, { capture: true })
}
