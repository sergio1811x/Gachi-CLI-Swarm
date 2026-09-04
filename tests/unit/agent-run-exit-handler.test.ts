import { describe, expect, test } from 'vitest'

import { handleAgentRunExit } from '../../src/server/agent-run-exit-handler.js'
import type { AgentRunExitContext } from '../../src/server/agent-run-start-context.js'
import { createLiveRunRegistry } from '../../src/server/live-run-registry.js'

const createSessionStore = () => {
  const cleared: string[] = []
  return {
    cleared,
    clearLastSessionId: (_workspaceId: string, agentId: string) => {
      cleared.push(agentId)
    },
    getLastSessionId: () => '019dc277-0e8e-75c1-9794-94929426288e',
    setLastSessionId: () => {},
  }
}

const createContext = () => {
  const registry = createLiveRunRegistry()
  const liveRun = {
    agentId: 'ws-1:worker',
    exitCode: null,
    output: '',
    paused: false,
    pid: 123,
    runId: 'run-1',
    startedAt: Date.now(),
    status: 'running' as const,
  }
  registry.add(liveRun)
  const context: AgentRunExitContext = {
    agentId: 'ws-1:worker',
    handledRunExits: new Set(),
    onAgentExit: () => {},
    registry,
    sessionStore: createSessionStore(),
    startConfig: { resumedSessionId: '019dc277-0e8e-75c1-9794-94929426288e' },
    store: {
      insertAgentRun: () => {},
      updatePersistedRun: () => {},
    },
    token: 'token-1',
    tokenRegistry: {
      issue: () => 'token-1',
      peek: () => 'token-1',
      revokeIfMatches: () => {},
      validate: () => false,
    },
    workspace: { id: 'ws-1', name: 'Workspace', path: '/tmp/ws-1' },
  }
  return { context, registry }
}

describe('handleAgentRunExit session retention', () => {
  test('a stop we initiated keeps the resumed session id', () => {
    const { context, registry } = createContext()
    registry.markStopRequested('run-1')

    handleAgentRunExit(context, { endedAt: Date.now(), exitCode: 1, runId: 'run-1' })

    expect(context.sessionStore.cleared).toEqual([])
  })

  test('an unclean exit without a stop request still clears the resumed id', () => {
    const { context } = createContext()

    handleAgentRunExit(context, { endedAt: Date.now(), exitCode: 1, runId: 'run-1' })

    expect(context.sessionStore.cleared).toEqual(['ws-1:worker'])
  })

  test('a clean exit never clears the resumed id', () => {
    const { context } = createContext()

    handleAgentRunExit(context, { endedAt: Date.now(), exitCode: 0, runId: 'run-1' })

    expect(context.sessionStore.cleared).toEqual([])
  })
})
