import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { createAgentTelemetry } from '../../src/server/agent-telemetry.js'

/**
 * ROADMAP R11: golden-fixture contract tests. Each fixture is real-shaped
 * engine PTY output (ANSI escapes included). If an engine changes its status
 * line format, these tests break — the early warning the scrape layer needs.
 */

const FIXTURE_DIR = join(import.meta.dirname, '../fixtures/engine-output')

const feedChunked = (chunk: string): ReturnType<typeof createAgentTelemetry> => {
  const telemetry = createAgentTelemetry()
  // Deliver like a real PTY bus: arbitrary 16-byte slices, mid-line splits included.
  for (let i = 0; i < chunk.length; i += 16) {
    telemetry.observe('ws-fix', 'agent-fix', chunk.slice(i, i + 16))
  }
  return telemetry
}

describe('engine output fixtures (R11)', () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt'))

  test('fixture set covers the officially supported engines', () => {
    expect(files.sort()).toEqual(['claude-code.txt', 'codex.txt', 'gemini.txt', 'opencode.txt'])
  })

  for (const file of files) {
    test(`${file}: context/tokens survive ANSI + chunk splits`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, file), 'utf8')
      const snapshot = feedChunked(raw).snapshot('ws-fix', 'agent-fix')
      expect(snapshot).toBeDefined()

      const expected: Record<string, { contextPercent: number | null; tokensUsed: number | null }> =
        {
          'claude-code.txt': { contextPercent: 34, tokensUsed: null },
          'codex.txt': { contextPercent: 79, tokensUsed: 48_210 },
          'opencode.txt': { contextPercent: 61, tokensUsed: 12_345 },
          // Gemini's table-drawn stats block: both values scrape.
          'gemini.txt': { contextPercent: 88, tokensUsed: 5_001 },
        }
      expect(snapshot?.contextPercent).toBe(expected[file]?.contextPercent ?? null)
      expect(snapshot?.tokensUsed).toBe(expected[file]?.tokensUsed ?? null)
    })
  }
})
