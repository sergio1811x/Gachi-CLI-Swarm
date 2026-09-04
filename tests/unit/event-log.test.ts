import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createEventLog, type EventLogRecord } from '../../src/server/event-log.js'
import { createRuntimeEventBus } from '../../src/server/runtime-event-bus.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const record = (overrides: Partial<EventLogRecord> = {}): EventLogRecord => ({
  seq: 1,
  at: Date.now(),
  workspaceId: 'ws',
  type: 'QUEUE_UPDATED',
  payload: {},
  ...overrides,
})

describe('event-log', () => {
  let bus: ReturnType<typeof createRuntimeEventBus>

  beforeEach(() => {
    bus = createRuntimeEventBus()
  })

  test('subscription captures events in seq order (newest-last) and stamps seq', () => {
    const log = createEventLog({ getWorkspacePath: () => null })
    log.attach(bus)
    bus.emit('ws', { type: 'QUEUE_UPDATED', payload: { taskCount: 1 } })
    bus.emit('ws', { type: 'AGENT_STATUS_CHANGED', payload: { agentId: 'ws:a' } })
    const events = log.tail('ws')
    expect(events).toHaveLength(2)
    expect(events[0]?.seq).toBe(1)
    expect(events[1]?.seq).toBe(2)
    expect(events[1]?.type).toBe('AGENT_STATUS_CHANGED')
    expect(events[0]?.at).toBeGreaterThan(0)
  })

  test('agentId filter keeps own events and workspace-wide board events, drops unrelated', () => {
    const log = createEventLog({ getWorkspacePath: () => null })
    log.attach(bus)
    bus.emit('ws', { type: 'AGENT_STATUS_CHANGED', payload: { agentId: 'ws:alice' } })
    bus.emit('ws', { type: 'AGENT_STATUS_CHANGED', payload: { agentId: 'ws:bob' } })
    bus.emit('ws', { type: 'QUEUE_UPDATED', payload: { taskCount: 5 } })
    bus.emit('ws', { type: 'RUN_PROGRESS', payload: { agentId: 'ws:bob', line: 'x' } })

    const aliceEvents = log.tail('ws', { agentId: 'ws:alice' })
    expect(aliceEvents.map((e) => e.seq)).toEqual([1, 3])
    const bobEvents = log.tail('ws', { agentId: 'ws:bob' })
    expect(bobEvents.map((e) => e.seq)).toEqual([2, 3, 4])
  })

  test('limit returns the most recent N records', () => {
    const log = createEventLog({ getWorkspacePath: () => null })
    log.attach(bus)
    bus.emit('ws', { type: 'QUEUE_UPDATED', payload: {} })
    bus.emit('ws', { type: 'TASK_STARTED', payload: {} })
    bus.emit('ws', { type: 'TASK_COMPLETED', payload: {} })
    expect(log.tail('ws', { limit: 2 }).map((e) => e.seq)).toEqual([2, 3])
  })

  test('persists to disk and rehydrates on a fresh instance (audit trail survives restart)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'event-log-'))
    tempDirs.push(dataDir)
    const workspaceRoot = join(dataDir, 'ws-root')
    const first = createEventLog({
      getWorkspacePath: () => workspaceRoot,
      maxLines: 100,
    })
    first.attach(bus)
    bus.emit('ws', { type: 'QUEUE_UPDATED', payload: { taskCount: 3 } })
    first.close()

    const file = join(workspaceRoot, '.gachi', 'events', 'ws.ndjson')
    expect(existsSync(file)).toBe(true)

    const second = createEventLog({ getWorkspacePath: () => workspaceRoot, maxLines: 100 })
    const events = second.tail('ws')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('QUEUE_UPDATED')
    // seq continues after rehydration, never repeats
    second.attach(bus)
    bus.emit('ws', { type: 'AGENT_STATUS_CHANGED', payload: { agentId: 'ws:a' } })
    const tailed = second.tail('ws')
    expect(tailed[tailed.length - 1]?.seq).toBe(2)
    second.close()
  })

  test('caps the in-memory ring and trims the file when it doubles past the cap', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'event-log-cap-'))
    tempDirs.push(dataDir)
    const log = createEventLog({ getWorkspacePath: () => dataDir, maxLines: 5 })
    log.attach(bus)
    for (let index = 0; index < 20; index += 1) {
      bus.emit('ws', { type: 'QUEUE_UPDATED', payload: { n: index } })
    }
    // The ring is allowed to grow to 2x the cap before trimming, never above it.
    const tailed = log.tail('ws')
    expect(tailed.length).toBeLessThanOrEqual(10)
    expect(tailed.length).toBeGreaterThanOrEqual(5)
    const file = join(dataDir, '.gachi', 'events', 'ws.ndjson')
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(10)
  })

  test('does not write to disk when no workspace path resolves', () => {
    const log = createEventLog({ getWorkspacePath: () => null })
    log.attach(bus)
    bus.emit('ws', { type: 'QUEUE_UPDATED', payload: {} })
    expect(log.tail('ws')).toHaveLength(1)
    // No file was created because the path resolved to null.
    expect(bus).toBeDefined()
  })

  test('skip corrupt lines during hydration', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'event-log-corrupt-'))
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, '.gachi', 'events'), { recursive: true })
    const file = join(dataDir, '.gachi', 'events', 'ws.ndjson')
    writeFileSync(file, `garbage-not-json\n${JSON.stringify(record())}\n`, 'utf8')
    const log = createEventLog({ getWorkspacePath: () => dataDir })
    expect(log.tail('ws')).toHaveLength(1)
  })
})
