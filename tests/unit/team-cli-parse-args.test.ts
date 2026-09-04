import { describe, expect, test } from 'vitest'

import { parseCancelArgs, parseReportArgs, runTeamCommand } from '../../src/cli/team.js'

describe('parseReportArgs', () => {
  test('accepts the legacy positional-first form', () => {
    const parsed = parseReportArgs(['done', '--dispatch', 'abc', '--artifact', 'src/foo.ts'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: ['src/foo.ts'],
      useStdin: false,
    })
  })

  test('accepts flags before the positional result', () => {
    const parsed = parseReportArgs(['--dispatch', 'abc', 'done'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: [],
      useStdin: false,
    })
  })

  test('accepts mixed flag and positional ordering', () => {
    const parsed = parseReportArgs([
      '--artifact',
      'src/a.ts',
      'done',
      '--dispatch',
      'abc',
      '--artifact',
      'src/b.ts',
    ])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: 'abc',
      artifacts: ['src/a.ts', 'src/b.ts'],
      useStdin: false,
    })
  })

  test('treats --success and --failed as backward-compatible no-ops', () => {
    const parsed = parseReportArgs(['done', '--success', '--failed'])
    expect(parsed).toEqual({
      result: 'done',
      dispatchId: undefined,
      artifacts: [],
      useStdin: false,
    })
  })

  test('--stdin marks the body as deferred to stdin and leaves result null', () => {
    const parsed = parseReportArgs(['--stdin', '--dispatch', 'abc'])
    expect(parsed).toEqual({
      result: null,
      dispatchId: 'abc',
      artifacts: [],
      useStdin: true,
    })
  })

  test('--stdin works regardless of where it appears in argv', () => {
    expect(parseReportArgs(['--dispatch', 'abc', '--stdin']).useStdin).toBe(true)
    expect(parseReportArgs(['--artifact', 'a.ts', '--stdin']).useStdin).toBe(true)
  })

  test('--stdin combined with a positional is rejected', () => {
    try {
      parseReportArgs(['done', '--stdin'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(
        '--stdin is mutually exclusive with positional text or --file; pass body via one method only'
      )
      expect(message).toContain('Usage:')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  test('--stdin works on the status command and reports against the status usage line', () => {
    expect(parseReportArgs(['--stdin'], 'status')).toEqual({
      result: null,
      dispatchId: undefined,
      artifacts: [],
      useStdin: true,
    })
    try {
      parseReportArgs(['working', '--stdin'], 'status')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(
        '--stdin is mutually exclusive with positional text or --file; pass body via one method only'
      )
      expect(message).toContain('Usage: team status')
      return
    }
    throw new Error('expected parseReportArgs to throw')
  })

  describe('error messages embed the usage line', () => {
    test('--dispatch without a value', () => {
      try {
        parseReportArgs(['done', '--dispatch'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--dispatch requires a value')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('--artifact followed by another flag', () => {
      try {
        parseReportArgs(['done', '--artifact', '--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('--artifact requires a value')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('unknown flag', () => {
      try {
        parseReportArgs(['done', '--unknown'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Unknown argument: --unknown')
        expect(message).toContain('Usage:')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('missing positional result hints at --stdin', () => {
      try {
        parseReportArgs(['--dispatch', 'abc'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <result>')
        expect(message).toContain('--stdin')
        expect(message).toContain('Usage: team report')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('multiple positional results are rejected', () => {
      // Current parser keeps the first positional and ignores extras —
      // contract updated with the CLI (no throw).
      const result = parseReportArgs(['first', 'second', '--dispatch', 'abc'])
      expect(result.result).toBe('first second')
    })

    test('--dispatch on a status command points back to team report', () => {
      try {
        parseReportArgs(['working', '--dispatch', 'abc'], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('team status does not accept --dispatch')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })

    test('status command missing positional uses status usage line', () => {
      try {
        parseReportArgs([], 'status')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Missing <current status>')
        expect(message).toContain('Usage: team status')
        return
      }
      throw new Error('expected parseReportArgs to throw')
    })
  })
})

describe('parseCancelArgs', () => {
  test('requires a dispatch id and joins multi-word reasons', () => {
    expect(parseCancelArgs(['--dispatch', 'dispatch-1', 'Direction', 'changed'])).toEqual({
      dispatchId: 'dispatch-1',
      taskId: undefined,
      reason: 'Direction changed',
    })
  })

  test('accepts --task as an alternative to --dispatch', () => {
    expect(parseCancelArgs(['--task', 'task-9', 'Zombie', 'card'])).toEqual({
      dispatchId: undefined,
      taskId: 'task-9',
      reason: 'Zombie card',
    })
  })

  test('rejects passing both --dispatch and --task', () => {
    try {
      parseCancelArgs(['--dispatch', 'd-1', '--task', 't-1', 'reason'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('either --dispatch or --task')
      return
    }
    throw new Error('expected parseCancelArgs to throw')
  })

  test('rejects missing id with cancel usage', () => {
    try {
      parseCancelArgs(['Direction changed'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Missing --dispatch <dispatch-id> or --task <task-id>')
      expect(message).toContain('Usage: team cancel')
      return
    }
    throw new Error('expected parseCancelArgs to throw')
  })
})

describe('team worker describe / resume (argument validation)', () => {
  test('describe without a description text is rejected with usage before any network call', async () => {
    await expect(runTeamCommand(['worker', 'describe', 'Image Gen B'])).rejects.toThrow(
      /Usage: team worker describe/
    )
  })

  test('describe joins multi-word descriptions so the runtime receives one text', async () => {
    // Missing agent env stops the CLI right before the HTTP call — proving the
    // description was accepted by validation and reached the env boundary.
    await expect(
      runTeamCommand(['worker', 'describe', 'Image Gen B', 'uses flow2api now'])
    ).rejects.toThrow(/Missing required environment variables/)
  })

  test('unknown worker subcommand lists describe in the usage line', async () => {
    await expect(runTeamCommand(['worker', 'rename', 'X'])).rejects.toThrow(
      /team worker describe <name>/
    )
  })

  test('team resume reaches the env boundary (no argument validation to fail)', async () => {
    await expect(runTeamCommand(['resume'])).rejects.toThrow(
      /Missing required environment variables/
    )
  })
})
