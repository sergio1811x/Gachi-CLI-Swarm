import { describe, expect, test } from 'vitest'

import { decomposeEngineeringTask } from '../../src/server/planner-decomposition.js'

describe('engineering planner', () => {
  test('creates an ordered architecture, implementation, test and review graph', () => {
    const plan = decomposeEngineeringTask('Create OAuth system')

    expect(plan.map((task) => task.title)).toEqual([
      'Architecture: Create OAuth system',
      'Backend: Create OAuth system',
      'Frontend: Create OAuth system',
      'Tests: Create OAuth system',
      'Review: Create OAuth system',
    ])
    expect(plan[3]?.dependencies).toEqual([1, 2])
    expect(plan[4]?.role).toBe('reviewer')
  })
})
