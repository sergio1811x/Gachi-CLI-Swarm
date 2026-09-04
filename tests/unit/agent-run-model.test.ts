import { describe, expect, test } from 'vitest'

import { createAgentRunModel } from '../../src/server/agent-run-model.js'

describe('agent run model (unit)', () => {
  test('registers a run with starting state and returns it', () => {
    const model = createAgentRunModel()

    const run = model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 42,
      runtimeState: 'starting',
      startedAt: 1000,
      workspaceId: 'ws-1',
    })

    expect(run).toMatchObject({
      id: 'run-1',
      taskId: null,
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      pid: 42,
      runtimeState: 'starting',
      lifecycleState: 'starting',
      startedAt: 1000,
      endedAt: null,
      exitCode: null,
      lastHeartbeat: null,
      lastOutput: '',
    })
    expect(model.get('run-1')).toEqual(run)
  })

  test('output is capped at the tail and heartbeat is tracked', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'starting',
      startedAt: 1,
      workspaceId: 'ws-1',
    })

    model.recordOutput('run-1', 'a'.repeat(20_000))
    expect(model.get('run-1')!.lastOutput.length).toBe(10_000)
    expect(model.get('run-1')!.lastOutput.slice(-3)).toBe('aaa')

    model.recordHeartbeat('run-1', 5000)
    expect(model.get('run-1')!.lastHeartbeat).toBe(5000)
  })

  test('bindTask links the run to a task', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'starting',
      startedAt: 1,
      workspaceId: 'ws-1',
    })

    model.bindTask('run-1', 'task-1')
    expect(model.get('run-1')!.taskId).toBe('task-1')
  })

  test('complete marks the run exited/error with exit code and endedAt', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'running',
      startedAt: 1,
      workspaceId: 'ws-1',
    })

    model.complete('run-1', 0, 9000)
    expect(model.get('run-1')).toMatchObject({
      runtimeState: 'exited',
      exitCode: 0,
      endedAt: 9000,
    })

    model.complete('run-1', 1, 10_000)
    expect(model.get('run-1')).toMatchObject({
      runtimeState: 'error',
      exitCode: 1,
      endedAt: 10_000,
    })
  })

  test('getActiveForAgent only returns starting/running runs for the agent', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'running',
      startedAt: 1,
      workspaceId: 'ws-1',
    })
    model.register({
      agentId: 'agent-1',
      id: 'run-2',
      pid: 2,
      runtimeState: 'starting',
      startedAt: 2,
      workspaceId: 'ws-1',
    })
    model.register({
      agentId: 'agent-1',
      id: 'run-3',
      pid: 3,
      runtimeState: 'exited',
      startedAt: 3,
      workspaceId: 'ws-1',
    })
    model.register({
      agentId: 'agent-2',
      id: 'run-4',
      pid: 4,
      runtimeState: 'running',
      startedAt: 4,
      workspaceId: 'ws-1',
    })

    const active = model.getActiveForAgent('ws-1', 'agent-1')
    expect(active).toBeDefined()
    expect(active!.runtimeState).toBe('running')
    expect(['run-1', 'run-2']).toContain(active!.id)
    expect(model.getActiveForAgent('ws-1', 'missing')).toBeUndefined()
  })

  test('listActive excludes finished runs and sorts newest first', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-old',
      pid: 1,
      runtimeState: 'starting',
      startedAt: 1,
      workspaceId: 'ws-1',
    })
    model.register({
      agentId: 'agent-1',
      id: 'run-new',
      pid: 2,
      runtimeState: 'running',
      startedAt: 2,
      workspaceId: 'ws-1',
    })
    model.register({
      agentId: 'agent-1',
      id: 'run-done',
      pid: 3,
      runtimeState: 'exited',
      startedAt: 3,
      workspaceId: 'ws-1',
    })

    const active = model.listActive()
    expect(active.map((run) => run.id)).toEqual(['run-new', 'run-old'])
  })

  test('remove drops the run from the model', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'starting',
      startedAt: 1,
      workspaceId: 'ws-1',
    })

    model.remove('run-1')
    expect(model.get('run-1')).toBeUndefined()
    expect(model.listActive()).toEqual([])
  })

  test('get returns a copy so mutations are not shared', () => {
    const model = createAgentRunModel()
    model.register({
      agentId: 'agent-1',
      id: 'run-1',
      pid: 1,
      runtimeState: 'starting',
      startedAt: 1,
      workspaceId: 'ws-1',
    })

    const first = model.get('run-1')!
    first.taskId = 'mutated'
    expect(model.get('run-1')!.taskId).toBeNull()
  })
})
