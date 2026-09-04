import { describe, expect, test } from 'vitest'

import { evaluateNodeVersion } from '../../src/cli/doctor.js'

describe('evaluateNodeVersion (doctor R8)', () => {
  test('Node 22+ is supported and needs no fix', () => {
    const v22 = evaluateNodeVersion('v22.17.1')
    expect(v22.ok).toBe(true)
    expect(v22.fix).toBeNull()
    expect(v22.detail).toBe('v22.17.1')

    const v24 = evaluateNodeVersion('v24.0.0')
    expect(v24.ok).toBe(true)
  })

  test('older majors fail with an actionable fix hint', () => {
    for (const version of ['v18.20.0', 'v20.11.1']) {
      const result = evaluateNodeVersion(version)
      expect(result.ok).toBe(false)
      expect(result.detail).toContain(version)
      expect(result.fix).toContain('nodejs.org')
    }
    expect(evaluateNodeVersion('v20.11.1').major).toBe(20)
  })

  test('malformed version is treated as unsupported rather than crashing', () => {
    const result = evaluateNodeVersion('oops')
    expect(result.ok).toBe(false)
    expect(result.major).toBeNaN()
    expect(result.fix).toBeTruthy()
  })
})
