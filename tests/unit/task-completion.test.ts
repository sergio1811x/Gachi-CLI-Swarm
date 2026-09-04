import { describe, expect, test } from 'vitest'

import { parseStructuredCompletion } from '../../src/server/task-completion.js'

describe('parseStructuredCompletion', () => {
  test('parses a TASK_COMPLETED block with files, tests and summary', () => {
    const text = `Done.
TASK_COMPLETED {
  "taskId": "abc",
  "summary": "Implemented login flow.",
  "filesChanged": ["src/auth.ts", "tests/auth.test.ts"],
  "tests": ["pnpm test"],
  "status": "completed"
}`
    expect(parseStructuredCompletion(text)).toEqual({
      filesChanged: ['src/auth.ts', 'tests/auth.test.ts'],
      status: 'completed',
      summary: 'Implemented login flow.',
      tests: ['pnpm test'],
    })
  })

  test('parses TASK_FAILED as status failed', () => {
    const text = `TASK_FAILED { "summary": "Flaky dependency.", "filesChanged": [], "tests": [] }`
    expect(parseStructuredCompletion(text)).toMatchObject({ status: 'failed' })
  })

  test('ignores non-string entries in arrays', () => {
    const text = `TASK_BLOCKED {
      "summary": "blocked",
      "filesChanged": ["src/a.ts", 42, null],
      "tests": []
    }`
    expect(parseStructuredCompletion(text)?.filesChanged).toEqual(['src/a.ts'])
    expect(parseStructuredCompletion(text)?.status).toBe('blocked')
  })

  test('returns undefined for plain text with no structured block', () => {
    expect(parseStructuredCompletion('all good, verified on disk')).toBeUndefined()
    expect(parseStructuredCompletion('')).toBeUndefined()
  })

  test('returns undefined for a malformed JSON block instead of throwing', () => {
    expect(parseStructuredCompletion('TASK_COMPLETED { not json }')).toBeUndefined()
  })
})
