import { describe, expect, test, vi } from 'vitest'

import { createAgentLaunchCache } from '../../src/server/agent-launch-cache.js'
import type { AgentLaunchConfigInput } from '../../src/server/agent-run-store.js'

const config = (command: string): AgentLaunchConfigInput => ({
  args: [],
  command,
  commandPresetId: null,
  interactiveCommand: null,
  presetAugmentationDisabled: false,
  resumeArgsTemplate: null,
  sessionIdCapture: null,
})

describe('agent launch cache', () => {
  test('negative-caches missing launch configs until save', () => {
    const rows: Array<{ agentId: string; config: AgentLaunchConfigInput; workspaceId: string }> = []
    const store = {
      deleteLaunchConfig: vi.fn(),
      listLaunchConfigs: vi.fn(() => rows),
      saveLaunchConfig: vi.fn(),
    }
    const cache = createAgentLaunchCache(store)

    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(2)

    cache.save('workspace-1', 'agent-a', config('node'))
    expect(cache.peek('workspace-1', 'agent-a')).toMatchObject({ command: 'node' })
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(2)
  })

  test('remove records a miss so repeated peeks avoid store reloads', () => {
    const rows = [{ agentId: 'agent-a', config: config('node'), workspaceId: 'workspace-1' }]
    const store = {
      deleteLaunchConfig: vi.fn(),
      listLaunchConfigs: vi.fn(() => rows),
      saveLaunchConfig: vi.fn(),
    }
    const cache = createAgentLaunchCache(store)

    expect(cache.peek('workspace-1', 'agent-a')).toMatchObject({ command: 'node' })
    cache.remove('workspace-1', 'agent-a')
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(cache.peek('workspace-1', 'agent-a')).toBeUndefined()
    expect(store.listLaunchConfigs).toHaveBeenCalledTimes(1)
  })
})
