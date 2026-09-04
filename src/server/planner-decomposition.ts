import type { WorkerRole } from '../shared/types.js'

export interface PlannedTask {
  dependencies: number[]
  description: string
  priority: 'normal' | 'high'
  requiredSkills: string[]
  reviewRequired: boolean
  role: WorkerRole
  title: string
}

export const decomposeEngineeringTask = (title: string, description = ''): PlannedTask[] => {
  const context = description ? `${title}\n\n${description}` : title
  return [
    {
      dependencies: [],
      description: `Design the implementation approach for: ${context}`,
      priority: 'high',
      requiredSkills: ['architecture'],
      reviewRequired: true,
      role: 'custom',
      title: `Architecture: ${title}`,
    },
    {
      dependencies: [0],
      description: `Implement backend/runtime changes for: ${context}`,
      priority: 'high',
      requiredSkills: ['typescript'],
      reviewRequired: true,
      role: 'coder',
      title: `Backend: ${title}`,
    },
    {
      dependencies: [0, 1],
      description: `Implement frontend integration for: ${context}`,
      priority: 'normal',
      requiredSkills: ['typescript', 'react'],
      reviewRequired: true,
      role: 'coder',
      title: `Frontend: ${title}`,
    },
    {
      dependencies: [1, 2],
      description: `Add integration coverage and validate: ${context}`,
      priority: 'high',
      requiredSkills: ['testing'],
      reviewRequired: true,
      role: 'tester',
      title: `Tests: ${title}`,
    },
    {
      dependencies: [3],
      description: `Review acceptance criteria, regressions and artifacts for: ${context}`,
      priority: 'high',
      requiredSkills: ['code review'],
      reviewRequired: false,
      role: 'reviewer',
      title: `Review: ${title}`,
    },
  ]
}
