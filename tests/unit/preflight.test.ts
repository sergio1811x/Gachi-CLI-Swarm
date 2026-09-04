import { describe, expect, test } from 'vitest'

import { collectPreflightWarnings } from '../../src/cli/preflight.js'

describe('collectPreflightWarnings (R7)', () => {
  test('clean environment produces no warnings', async () => {
    const warnings = await collectPreflightWarnings({
      gitAvailable: async () => true,
      nodeVersion: 'v22.17.1',
    })
    expect(warnings).toEqual([])
  })

  test('old Node yields an actionable warning', async () => {
    const warnings = await collectPreflightWarnings({
      gitAvailable: async () => true,
      nodeVersion: 'v18.20.0',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.label).toContain('v18')
    expect(warnings[0]?.fix).toContain('nodejs.org')
  })

  test('missing Git warns without blocking', async () => {
    const warnings = await collectPreflightWarnings({
      gitAvailable: async () => false,
      nodeVersion: 'v22.17.1',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.label).toBe('Git not found')
    expect(warnings[0]?.fix).toContain('git-scm.com')
  })

  test('both problems are reported together', async () => {
    const warnings = await collectPreflightWarnings({
      gitAvailable: async () => false,
      nodeVersion: 'v16.0.0',
    })
    expect(warnings.map((w) => w.label)).toHaveLength(2)
  })
})
