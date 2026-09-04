import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createPtyOutputBus } from '../../src/server/pty-output-bus.js'
import {
  createWorkerOutputTracker,
  PROMPT_REPLY_WINDOW_MS,
} from '../../src/server/worker-output-tracker.js'

describe('worker output tracker spontaneous activity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('raw output and spontaneous output both update when no prompt was injected', () => {
    vi.setSystemTime(100_000)
    const bus = createPtyOutputBus()
    const tracker = createWorkerOutputTracker(bus)

    tracker.attach('ws-1', 'coder', 'run-1', '')
    bus.publish('run-1', 'starting work')

    expect(tracker.getLastPtyActivityAt('ws-1', 'coder')).toBe(100_000)
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(100_000)

    vi.advanceTimersByTime(60_000)
    bus.publish('run-1', 'editing files')
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(160_000)
  })

  test('a reply within the window after a prompt injection is not real work', () => {
    vi.setSystemTime(100_000)
    const bus = createPtyOutputBus()
    const tracker = createWorkerOutputTracker(bus)

    tracker.attach('ws-1', 'coder', 'run-1', '')
    bus.publish('run-1', 'doing work')
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(100_000)

    vi.advanceTimersByTime(60_000)
    tracker.notePromptInjection('ws-1', 'coder')
    vi.advanceTimersByTime(10_000)

    // Raw activity refreshes (the reply proves the process is alive)...
    bus.publish('run-1', 'ok, waiting')
    expect(tracker.getLastPtyActivityAt('ws-1', 'coder')).toBe(170_000)
    // ...but spontaneous activity does NOT (it is just a prompted acknowledgement).
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(100_000)

    // Once the reply window elapses, real work resumes updating spontaneous output.
    vi.advanceTimersByTime(PROMPT_REPLY_WINDOW_MS + 1)
    bus.publish('run-1', 'actual progress now')
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(
      170_000 + PROMPT_REPLY_WINDOW_MS + 1
    )
  })

  test('detach clears the tracked timestamps', () => {
    vi.setSystemTime(100_000)
    const bus = createPtyOutputBus()
    const tracker = createWorkerOutputTracker(bus)

    tracker.attach('ws-1', 'coder', 'run-1', '')
    bus.publish('run-1', 'x')
    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBe(100_000)

    tracker.detach('ws-1', 'coder')

    expect(tracker.getLastSpontaneousActivityAt('ws-1', 'coder')).toBeNull()
    expect(tracker.getLastPtyActivityAt('ws-1', 'coder')).toBeNull()
  })
})

describe('worker output tracker context-compaction detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('fires onContextCompacted when the CLI reports a compacted conversation', () => {
    const bus = createPtyOutputBus()
    const onContextCompacted = vi.fn()
    const tracker = createWorkerOutputTracker(
      bus,
      undefined,
      undefined,
      undefined,
      onContextCompacted
    )

    tracker.attach('ws-1', 'coder', 'run-1', '')
    bus.publish('run-1', 'Compacting conversation history…')
    expect(onContextCompacted).toHaveBeenCalledTimes(1)
    expect(onContextCompacted).toHaveBeenCalledWith('ws-1', 'coder')

    // Cooldown: repeated markers within the window do not spam re-injections.
    bus.publish('run-1', 'auto-compacted again')
    expect(onContextCompacted).toHaveBeenCalledTimes(1)
  })

  test('does not fire for ordinary output mentioning similar words', () => {
    const bus = createPtyOutputBus()
    const onContextCompacted = vi.fn()
    const tracker = createWorkerOutputTracker(
      bus,
      undefined,
      undefined,
      undefined,
      onContextCompacted
    )

    tracker.attach('ws-1', 'coder', 'run-1', '')
    bus.publish('run-1', 'I will keep the code compact and readable.')
    expect(onContextCompacted).not.toHaveBeenCalled()
  })
})
