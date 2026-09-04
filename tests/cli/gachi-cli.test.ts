import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { GACHI_USAGE, handleGachiInfoCommand, runGachiCommand } from '../../src/cli/gachi.js'
import { SKIP_CONPTY_WINDOWS } from '../helpers/platform.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe.skipIf(SKIP_CONPTY_WINDOWS)('gachi cli', () => {
  test('prints help without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(handleGachiInfoCommand(['--help'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(GACHI_USAGE)
  })

  test('prints package version without starting the runtime', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

    expect(handleGachiInfoCommand(['--version'])).toBe(true)

    expect(logSpy).toHaveBeenCalledWith(version)
  })

  test('rejects unknown arguments instead of ignoring them', async () => {
    await expect(runGachiCommand(['--bogus'])).rejects.toThrow('Unknown option: --bogus')
    await expect(runGachiCommand(['--port', '0', 'extra'])).rejects.toThrow(
      'Unknown argument: extra'
    )
  })

  test('starts http server and prints listening address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await runGachiCommand(['--port', '0'])

    try {
      expect(result.port).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(
        `Gachi CLI Swarm running at http://127.0.0.1:${result.port}`
      )
    } finally {
      await result.close()
    }
  })
})
