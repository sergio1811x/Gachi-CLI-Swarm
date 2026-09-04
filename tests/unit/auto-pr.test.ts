import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentRunRecordStore } from '../../src/server/agent-run-record-store.js'
import {
  createRuntimeSupervisor,
  type RuntimeSupervisorDeps,
} from '../../src/server/runtime-supervisor.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createAgentWorktree } from '../../src/server/worktree-manager.js'

const tempDirs: string[] = []
const dbs: import('better-sqlite3').Database[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Real git repo whose agent worktree holds one commit ahead of main. */
const makeRepoWithWorkerCommit = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-autopr-'))
  tempDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  git(['init'], dir)
  git(['config', 'user.email', 'test@test'], dir)
  git(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'README.md'), '# init\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)

  const wt = createAgentWorktree(dir, 'worker-a')
  writeFileSync(join(wt, 'feature.txt'), 'done work\n')
  git(['add', '.'], wt)
  git(['commit', '-m', 'feat: worker change'], wt)
  return dir
}

const buildFixture = (options: {
  enabled?: boolean
  publish?: () => { url: string; number: number | null }
}) => {
  const repo = makeRepoWithWorkerCommit()
  const db = new Database(':memory:')
  dbs.push(db)
  initializeRuntimeDatabase(db)
  const recordStore = createAgentRunRecordStore(db)

  const journal: string[] = []
  const publish = vi.fn(options.publish ?? (() => ({ number: 7, url: 'https://x/pull/7' })))
  const enabled = options.enabled === true

  const deps = {
    agentHeartbeatStore: { get: () => undefined, record: () => {} },
    agentLifecycleStore: { get: () => undefined, transition: () => {} },
    recordStore,
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
      getLiveRun: () => {
        throw new Error('no live run in fixture')
      },
      getPtyOutputBus: () => ({
        subscribe: () => () => {},
      }),
      stopAgentRun: () => {},
      waitForAgentRunExit: async () => {},
    } as never,
    workspaceStorePort: {
      hasAgent: () => true,
      markAgentStopped: () => {},
      getAgent: () => undefined,
    },
    workspaceStorePath: () => repo,
    taskStorePort: {
      getAssignedTaskForWorker: () => ({ id: 'task-1', status: 'running' }) as never,
      getTask: () => undefined,
      releaseTask: () => {},
      updateTask: () => {},
      addTaskLog: (_wsId: string, _taskId: string, message: string) => {
        journal.push(message)
      },
    },
    autoPr: {
      isEnabled: () => enabled,
      publishBranch: publish as unknown as RuntimeSupervisorDeps['autoPr']['publishBranch'],
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return {
    journal,
    publish,
    startAndExit: () => {
      supervisor.handleRunStarted('run-1', 'worker-a', 'ws1', Date.now(), null)
      supervisor.handleRunExited('run-1', 'worker-a', 'ws1', 0, Date.now())
    },
    repo,
  }
}

describe('auto-PR after clean merge (opt-in)', () => {
  test('flag off → merge lands but nothing is published or journaled', () => {
    const fx = buildFixture({ enabled: false })
    fx.startAndExit()

    expect(git(['log', '--oneline', '-3'], fx.repo)).toContain('feat: worker change')
    expect(fx.publish).not.toHaveBeenCalled()
    expect(fx.journal.filter((e) => e.startsWith('[PR]'))).toHaveLength(0)
  })

  test('flag on → branch published and [PR] journaled into the task', () => {
    const fx = buildFixture({ enabled: true })
    fx.startAndExit()

    expect(git(['log', '--oneline', '-3'], fx.repo)).toContain('feat: worker change')
    expect(fx.publish).toHaveBeenCalledOnce()
    expect(fx.journal).toContain('[PR] https://x/pull/7')
  })

  test('publish failure journals [PR FAILED] and does not break the pipeline', () => {
    const fx = buildFixture({
      enabled: true,
      publish: () => {
        throw new Error('gh not installed')
      },
    })
    expect(() => fx.startAndExit()).not.toThrow()
    expect(
      fx.journal.some((e) => e.startsWith('[PR FAILED]') && e.includes('gh not installed'))
    ).toBe(true)
  })
})
