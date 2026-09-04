import { describe, expect, test, vi } from 'vitest'

import { syncPersistedRun } from '../../src/server/agent-run-sync.js'

describe('syncPersistedRun', () => {
  test('does not write SQLite when only terminal output grows', () => {
    const store = { updatePersistedRun: vi.fn() }
    const run = {
      exitCode: null,
      output: '',
      runId: 'run-1',
      status: 'running',
    }

    const first = syncPersistedRun(
      run,
      { exitCode: null, output: 'hello', status: 'running' },
      store
    )
    expect(first.output).toBe('hello')
    expect(store.updatePersistedRun).not.toHaveBeenCalled()

    const second = syncPersistedRun(
      run,
      { exitCode: null, output: 'hello world', status: 'running' },
      store
    )
    expect(second.output).toBe('hello world')
    expect(store.updatePersistedRun).not.toHaveBeenCalled()
  })

  test('writes SQLite when status or exit code changes', () => {
    const store = { updatePersistedRun: vi.fn() }
    const run = {
      exitCode: null,
      output: '',
      runId: 'run-1',
      status: 'running',
    }

    syncPersistedRun(run, { exitCode: 0, output: 'done', status: 'exited' }, store)
    expect(store.updatePersistedRun).toHaveBeenCalledTimes(1)
    expect(store.updatePersistedRun).toHaveBeenCalledWith('run-1', 'exited', 0, expect.any(Number))
  })

  test('truncates output to the retention cap', () => {
    const store = { updatePersistedRun: vi.fn() }
    const run = {
      exitCode: null,
      output: '',
      runId: 'run-1',
      status: 'running',
    }

    const big = 'x'.repeat(1_500_000)
    const synced = syncPersistedRun(run, { exitCode: null, output: big, status: 'running' }, store)
    expect(synced.output.length).toBe(1_000_000)
    expect(store.updatePersistedRun).not.toHaveBeenCalled()
  })
})
