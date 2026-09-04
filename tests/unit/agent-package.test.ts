import { describe, expect, test } from 'vitest'

import {
  AgentPackageError,
  parseAgentPackage,
  serializeTeamTemplateToPackage,
} from '../../src/server/agent-package.js'

const validPackage = {
  format: 'gachi-agent-package',
  name: 'Video crew',
  skills: ['React Expert'],
  version: 1,
  workers: [
    { command_preset_id: 'claude', description: 'edits', name: 'Montage', role: 'coder' },
    { description: 'reviews', name: 'Critic', role: 'reviewer' },
  ],
}

describe('parseAgentPackage (R6)', () => {
  test('accepts a valid package and normalizes to template input', () => {
    const parsed = parseAgentPackage(validPackage)
    expect(parsed.name).toBe('Video crew')
    expect(parsed.workers).toHaveLength(2)
    expect(parsed.workers[0]).toMatchObject({ commandPresetId: 'claude', role: 'coder' })
    expect(parsed.missingSkills).toEqual([])
  })

  test('rejects wrong format/version with problem list', () => {
    try {
      parseAgentPackage({ ...validPackage, format: 'other', version: 99 })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentPackageError)
      const problems = (error as AgentPackageError).problems
      expect(problems.some((p) => p.includes('format'))).toBe(true)
      expect(problems.some((p) => p.includes('version'))).toBe(true)
    }
  })

  test('rejects empty/duplicate workers and unknown roles', () => {
    try {
      parseAgentPackage({
        format: 'gachi-agent-package',
        name: 'X',
        version: 1,
        workers: [
          { name: 'A', role: 'wizard' },
          { name: 'A', role: 'coder' },
        ],
      })
      throw new Error('should have thrown')
    } catch (error) {
      const problems = (error as AgentPackageError).problems
      expect(problems.some((p) => p.includes('role'))).toBe(true)
      expect(problems.some((p) => p.includes('duplicates'))).toBe(true)
    }
    expect(() =>
      parseAgentPackage({ format: 'gachi-agent-package', name: 'X', version: 1, workers: [] })
    ).toThrow(AgentPackageError)
  })

  test('unknown skill ids are reported, not fatal', () => {
    const parsed = parseAgentPackage({ ...validPackage, skills: ['code-reviewer'] })
    expect(parsed.missingSkills).toEqual(['code-reviewer'])
  })

  test('roundtrip: serialize(template-like) parses back cleanly', () => {
    const pkg = serializeTeamTemplateToPackage({
      name: 'Roundtrip',
      workers: [
        {
          commandPresetId: null,
          description: 'tests things',
          name: 'QA',
          role: 'tester',
        },
      ],
    })
    const parsed = parseAgentPackage(pkg)
    expect(parsed.name).toBe('Roundtrip')
    expect(parsed.workers[0]?.name).toBe('QA')
    expect(parsed.workers[0]?.role).toBe('tester')
  })
})
