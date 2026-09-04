import { describe, expect, test } from 'vitest'
import { selectWorkerForTask } from '../../src/server/task-assignment.js'
import {
  type HealthRun,
  healthScoreBonus,
  rollingSuccessRate,
} from '../../src/server/worker-health.js'
import type { AgentSummary } from '../../src/shared/types.js'

const run = (exitCode: number | null, status: HealthRun['status'] = 'exited'): HealthRun => ({
  exitCode,
  status,
})

describe('rollingSuccessRate (R3.2)', () => {
  test('null when there is no terminal history', () => {
    expect(rollingSuccessRate([])).toBeNull()
    expect(rollingSuccessRate([run(null, 'running')])).toBeNull()
  })

  test('clean exits → 1.0; errors drag it down', () => {
    expect(rollingSuccessRate([run(0), run(0), run(0)])).toBe(1)
    expect(rollingSuccessRate([run(0), run(1), run(0)])).toBeCloseTo(2 / 3)
    expect(rollingSuccessRate([run(1), run(1)])).toBe(0)
    // 'error' status counts as unhealthy even with exitCode null.
    expect(rollingSuccessRate([run(null, 'error'), run(0)])).toBe(0.5)
  })

  test('only the last `window` terminal runs are counted', () => {
    const runs = [...Array.from({ length: 12 }, () => run(0)), run(1)]
    expect(runs).toHaveLength(13)
    // Window of 10 keeps nine clean + the failing one.
    expect(rollingSuccessRate(runs)).toBeCloseTo(0.9)
  })
})

describe('healthScoreBonus (R3.2)', () => {
  test('maps rate to ±25 around neutral 0.5; null is neutral', () => {
    expect(healthScoreBonus(null)).toBe(0)
    expect(healthScoreBonus(1)).toBe(25)
    expect(healthScoreBonus(0)).toBe(-25)
    expect(healthScoreBonus(0.5)).toBe(0)
  })
})

const agent = (id: string): AgentSummary =>
  ({
    id,
    name: id,
    role: 'coder',
    status: 'idle',
    pendingTaskCount: 0,
    description: 'typescript react testing code review',
  }) as never as AgentSummary

describe('selectWorkerForTask health preference (R3.2)', () => {
  const task = {
    id: 't1',
    title: 'work',
    description: '',
    dependencies: [],
    requiredSkills: [],
    priority: 'normal',
    status: 'ready',
    reviewRequired: true,
  } as unknown as Parameters<typeof selectWorkerForTask>[0]

  test('healthy worker wins over an equally-skilled failing one', () => {
    const healthy = agent('healthy')
    const failing = agent('failing')
    const picked = selectWorkerForTask(
      task,
      [failing, healthy],
      () => true,
      (agentId) => (agentId === 'healthy' ? 1 : 0)
    )
    expect(picked?.id).toBe('healthy')
  })

  test('no signal keeps previous deterministic behavior', () => {
    const a = agent('aaa')
    const b = agent('bbb')
    const picked = selectWorkerForTask(
      task,
      [b, a],
      () => true,
      () => null
    )
    expect(picked?.id).toBe('aaa')
  })
})
