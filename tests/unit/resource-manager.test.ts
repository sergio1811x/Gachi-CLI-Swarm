import { describe, expect, test } from 'vitest'

import { countActiveWorkers, hasWorkerCapacity } from '../../src/server/resource-manager.js'

const agents = [
  {
    description: '',
    id: 'orchestrator',
    name: 'Queen',
    pendingTaskCount: 0,
    role: 'orchestrator' as const,
    status: 'working' as const,
    workspaceId: 'ws-1',
  },
  {
    description: '',
    id: 'worker-1',
    name: 'Worker 1',
    pendingTaskCount: 1,
    role: 'coder' as const,
    status: 'working' as const,
    workspaceId: 'ws-1',
  },
]

describe('resource manager', () => {
  test('counts workers without charging the orchestrator against worker capacity', () => {
    expect(countActiveWorkers(agents)).toBe(1)
    expect(hasWorkerCapacity(agents, 1)).toBe(false)
    expect(hasWorkerCapacity(agents, 2)).toBe(true)
  })
})
