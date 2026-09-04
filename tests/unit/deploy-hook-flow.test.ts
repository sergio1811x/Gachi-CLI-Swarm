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

const makeRepoWithWorkerCommit = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-deploy-'))
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
  command?: string | null
  result?: { ok: boolean; output: string; durationMs: number }
}) => {
  const repo = makeRepoWithWorkerCommit()
  const db = new Database(':memory:')
  dbs.push(db)
  initializeRuntimeDatabase(db)
  const recordStore = createAgentRunRecordStore(db)

  const journal: string[] = []
  const execute = vi.fn(async () => options.result ?? { ok: true, output: '', durationMs: 5 })

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
    deployHook: {
      getCommand: () => (options.command === undefined ? null : options.command),
      execute: execute as unknown as RuntimeSupervisorDeps['deployHook']['execute'],
    },
  } as unknown as RuntimeSupervisorDeps

  const supervisor = createRuntimeSupervisor(deps)
  return {
    journal,
    execute,
    startAndExit: () => {
      supervisor.handleRunStarted('run-1', 'worker-a', 'ws1', Date.now(), null)
      supervisor.handleRunExited('run-1', 'worker-a', 'ws1', 0, Date.now())
    },
    repo,
  }
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('deploy hook after clean merge (R4)', () => {
  test('no configured command → hook never runs', async () => {
    const fx = buildFixture({})
    fx.startAndExit()
    await flushAsync()

    expect(git(['log', '--oneline', '-3'], fx.repo)).toContain('feat: worker change')
    expect(fx.execute).not.toHaveBeenCalled()
    expect(fx.journal.filter((e) => e.startsWith('[DEPLOY'))).toHaveLength(0)
  })

  test('configured hook runs post-merge and journals success output into the task', async () => {
    const fx = buildFixture({
      command: 'npm run deploy',
      result: { ok: true, output: 'uploaded 12 files', durationMs: 4200 },
    })
    fx.startAndExit()
    await flushAsync()

    expect(fx.execute).toHaveBeenCalledOnce()
    expect(fx.execute.mock.calls[0][0]).toBe('npm run deploy')
    expect(
      fx.journal.some((e) => e.startsWith('[DEPLOY] ok') && e.includes('uploaded 12 files'))
    ).toBe(true)
  })

  test('hook failure journals [DEPLOY FAILED] and does not break run handling', async () => {
    const fx = buildFixture({
      command: 'npm run deploy',
      result: { ok: false, output: 'ECONNREFUSED', durationMs: 100 },
    })
    expect(() => fx.startAndExit()).not.toThrow()
    await flushAsync()

    expect(
      fx.journal.some((e) => e.startsWith('[DEPLOY FAILED]') && e.includes('ECONNREFUSED'))
    ).toBe(true)
  })
})
