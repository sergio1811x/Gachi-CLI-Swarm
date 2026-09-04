import { describe, expect, test } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'
import { DEFAULT_SANDBOX_IMAGE as DEFAULT_IMAGE } from '../../src/server/docker-sandbox.js'
import type { AgentSummary } from '../../src/shared/types.js'

const codexPreset: CommandPresetRecord = {
  args: [],
  command: 'codex',
  displayName: 'Codex',
  env: {},
  id: 'codex',
  isBuiltin: true,
  resumeArgsTemplate: 'resume {session_id}',
  sessionIdCapture: {
    pattern: '~/.codex/sessions/**/*.jsonl',
    source: 'codex_session_jsonl_dir',
  },
  yoloArgsTemplate: null,
}

const createSessionStore = (sessionId: string): AgentSessionStore => ({
  clearLastSessionId: () => {},
  getLastSessionId: () => sessionId,
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('resumed starts still snapshot known sessions so the forked id gets captured', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      createSessionStore(sessionId),
      (id) => (id === 'codex' ? codexPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    // `codex resume <id>` forks a new session file — without a pre-spawn
    // snapshot the capture cannot tell the fork from the old session, and the
    // stored id would go stale after every resumed run.
    expect(bootstrap.sessionCaptureSnapshot).toBeDefined()
    expect(bootstrap.sessionCaptureSnapshot?.knownSessionIds).toBeDefined()
  })

  test('docker sandbox wraps worker launch but leaves persistedConfig untouched', () => {
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-9',
        name: 'Sandboxed',
        path: '/tmp/sandbox-proj',
      },
      'workspace-9:montage',
      { args: [], command: 'claude' },
      createSessionStore(''),
      () => undefined,
      {
        description: 'Montage',
        id: 'workspace-9:montage',
        name: 'Montage',
        pendingTaskCount: 0,
        role: 'coder',
        status: 'idle',
        workspaceId: 'workspace-9',
      },
      '/tmp/sandbox-proj',
      { image: 'node:22-bookworm-slim', mode: 'docker' }
    )

    expect(bootstrap.startConfig.command).toBe('docker')
    expect(bootstrap.startConfig.args?.[0]).toBe('run')
    expect(bootstrap.startConfig.args).toContain('--')
    expect(bootstrap.startConfig.args?.at(-1)).toBe('claude')
    // The user-facing "last startup command" stays the real CLI.
    expect(bootstrap.persistedConfig.command).toBe('claude')
  })

  test('sandbox flag is ignored for the orchestrator', () => {
    const orchestrator: AgentSummary = {
      description: 'Queen',
      id: 'ws-o:orchestrator',
      name: 'Queen',
      pendingTaskCount: 0,
      role: 'orchestrator',
      status: 'idle',
      workspaceId: 'ws-o',
    }
    const bootstrap = buildAgentRunBootstrap(
      { id: 'ws-o', name: 'O', path: '/tmp/o' },
      'ws-o:orchestrator',
      { args: [], command: 'claude' },
      createSessionStore(''),
      () => undefined,
      orchestrator,
      '/tmp/o',
      { image: DEFAULT_IMAGE, mode: 'docker' }
    )
    expect(bootstrap.startConfig.command).toBe('claude')
  })

  test('custom launch command is kept verbatim for reuse on restart', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const orchestrator: AgentSummary = {
      description: 'Queen',
      id: 'workspace-1:orchestrator',
      name: 'Queen',
      pendingTaskCount: 0,
      role: 'orchestrator',
      status: 'idle',
      workspaceId: 'workspace-1',
    }
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'workspace-1:orchestrator',
      { args: ['--resume', 'abc123'], command: 'ccs' },
      createSessionStore(sessionId),
      () => undefined,
      orchestrator
    )

    // Unknown engines get no builtin augmentation; the exact command+args the
    // user typed is what gets persisted and relaunched verbatim.
    expect(bootstrap.persistedConfig).toEqual({
      args: ['--resume', 'abc123'],
      command: 'ccs',
    })
    expect(bootstrap.startConfig.args).toEqual(['--resume', 'abc123'])
  })

  test('builtin resume id is not baked into the persisted launch config', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const orchestrator: AgentSummary = {
      description: 'Queen',
      id: 'workspace-1:orchestrator',
      name: 'Queen',
      pendingTaskCount: 0,
      role: 'orchestrator',
      status: 'idle',
      workspaceId: 'workspace-1',
    }
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'workspace-1:orchestrator',
      { args: [], command: 'codex' },
      createSessionStore(sessionId),
      () => undefined,
      orchestrator
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    // The persisted config keeps the template, not the concrete id, so the next
    // launch re-resolves the freshest session.
    expect(bootstrap.persistedConfig).toMatchObject({
      args: [],
      command: 'codex',
      resumeArgsTemplate: 'resume {session_id}',
      sessionIdCapture: { source: 'codex_session_jsonl_dir' },
    })
  })

  test('orchestrator resumes its previous session without a command preset bind', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const orchestrator: AgentSummary = {
      description: 'Queen',
      id: 'workspace-1:orchestrator',
      name: 'Queen',
      pendingTaskCount: 0,
      role: 'orchestrator',
      status: 'idle',
      workspaceId: 'workspace-1',
    }
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'workspace-1:orchestrator',
      { args: [], command: 'codex' },
      createSessionStore(sessionId),
      () => undefined,
      orchestrator
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
      sessionIdCapture: { source: 'codex_session_jsonl_dir' },
    })
  })
})
