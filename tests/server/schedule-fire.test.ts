import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { scheduledMarker } from '../../src/server/agent-scheduler.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { taskStore } from '../../src/server/task-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('workspace schedule fires and anti-floods (T1)', () => {
  test('tick creates a ready card once; open copy blocks the next tick', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-sched-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(workspacePath, 'Sched')

    store.settings.setAppState(
      `schedule_${workspace.id}`,
      JSON.stringify({ goal: 'nightly dependency bump', intervalMinutes: 1440 })
    )

    // First tick → one ready card with the marker.
    store.runScheduleTick()
    let cards = taskStore.listTasks(workspace.id)
    const fired = cards.filter((task) => task.description.includes(scheduledMarker(workspace.id)))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.status).toBe('ready')
    expect(fired[0]?.title).toContain('nightly dependency bump')

    // Second immediate tick → anti-flood keeps it at one.
    store.runScheduleTick()
    cards = taskStore.listTasks(workspace.id)
    expect(
      cards.filter((task) => task.description.includes(scheduledMarker(workspace.id)))
    ).toHaveLength(1)

    // Close the card → the rule may fire again (interval still guards via
    // last-fired timestamp; simulate expiry by clearing it).
    store.settings.setAppState(`schedule_lastfired_${workspace.id}`, '')
    if (fired[0]) taskStore.deleteTask(workspace.id, fired[0].id)
    store.runScheduleTick()
    cards = taskStore.listTasks(workspace.id)
    expect(
      cards.filter((task) => task.description.includes(scheduledMarker(workspace.id)))
    ).toHaveLength(1)

    await store.close()
  })

  test('no schedule config → no-op', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-sched2-'))
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    const workspace = store.createWorkspace(dataDir, 'Empty')
    store.runScheduleTick()
    expect(taskStore.listTasks(workspace.id)).toHaveLength(0)
    await store.close()
  })
})
