import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

/**
 * R-policy wiring smoke: the app-state key `auto_compact_tokens` must be
 * accepted by the runtime (persisted + readable), and telemetry keeps its
 * observable contract regardless of whether a budget is configured.
 * The trigger math itself is covered in agent-telemetry.test.ts.
 */

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('auto_compact_tokens wiring', () => {
  test('budget persists in app-state and telemetry records token crossings', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-compact-tok-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)

    server.store.settings.setAppState('auto_compact_tokens', '100000')
    const stored = server.store.settings.getAppState('auto_compact_tokens')
    expect(String(stored?.value)).toBe('100000')

    server.store.telemetry.observe('ws-x', 'agent-x', 'Total tokens used: 150,000\r\n')
    const snap = server.store.telemetry.snapshot('ws-x', 'agent-x')
    expect(snap?.tokensUsed).toBe(150_000)
  })

  test('without a budget, huge token counts never corrupt the state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gachi-compact-off-'))
    tempDirs.push(dataDir)
    const server = await startTestServer({ dataDir })
    servers.push(server)

    server.store.telemetry.observe('ws-y', 'agent-y', 'Total tokens used: 9,000,000\r\n')
    expect(server.store.telemetry.snapshot('ws-y', 'agent-y')?.tokensUsed).toBe(9_000_000)
  })
})
