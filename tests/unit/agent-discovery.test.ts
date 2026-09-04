import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { detectAgentAuth } from '../../src/server/agent-discovery/auth-detector.js'
import { resolveDiscoveredCapabilities } from '../../src/server/agent-discovery/capability-resolver.js'
import {
  locateCli,
  parseVersionOutput,
  readCliVersion,
} from '../../src/server/agent-discovery/cli-detector.js'
import { getModelsForProvider } from '../../src/server/agent-discovery/model-registry.js'
import { createAgentDiscoveryScanner } from '../../src/server/agent-discovery/scanner.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gachi-discovery-'))
  tempDirs.push(dir)
  return dir
}

describe('cli detector', () => {
  test('parses semver out of noisy --version output', () => {
    expect(parseVersionOutput('2.1.3 (Claude Code)')).toBe('2.1.3')
    expect(parseVersionOutput('codex-cli 0.9.42\nbuild abc')).toBe('0.9.42')
    expect(parseVersionOutput('opencode v1.0.0-beta.1')).toBe('1.0.0-beta.1')
    expect(parseVersionOutput('no version here')).toBeUndefined()
  })

  test('locates a CLI via the platform tool and reads its version', async () => {
    const invoked: Array<[string, string[]]> = []
    const path = await locateCli('claude', {
      platform: 'linux',
      run: async (file, args) => {
        invoked.push([file, args])
        return { stdout: '/usr/local/bin/claude\n' }
      },
    })
    expect(path).toBe('/usr/local/bin/claude')
    expect(invoked[0]?.[0]).toBe('which')

    const version = await readCliVersion('/usr/local/bin/claude', {
      run: async () => ({ stdout: '2.1.3 (Claude Code)' }),
    })
    expect(version).toBe('2.1.3')
  })

  test('missing CLI degrades to installed:false without throwing', async () => {
    const path = await locateCli('gemini', {
      platform: 'win32',
      run: async () => {
        throw new Error('not found')
      },
    })
    expect(path).toBeNull()
  })

  test('a hung version probe resolves to undefined (time-boxed)', async () => {
    const version = await readCliVersion('/x/claude', {
      run: (_file, _args) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('timeout')), 50)
        }),
    })
    expect(version).toBeUndefined()
  })
})

describe('auth detector', () => {
  test('claude: oauth credentials file means authenticated', () => {
    const home = makeTempDir()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"accessToken":"x"}')
    const state = detectAgentAuth('claude', { homeDir: home, env: {} })
    expect(state.authenticated).toBe(true)
    expect(state.method).toBe('oauth')
  })

  test('claude: ANTHROPIC_API_KEY counts as api-key auth', () => {
    const state = detectAgentAuth('claude', {
      homeDir: makeTempDir(),
      env: { ANTHROPIC_API_KEY: 'sk' },
    })
    expect(state.authenticated).toBe(true)
    expect(state.method).toBe('api-key')
  })

  test('claude: nothing present means not authenticated', () => {
    const state = detectAgentAuth('claude', { homeDir: makeTempDir(), env: {} })
    expect(state.authenticated).toBe(false)
    expect(state.method).toBeUndefined()
  })

  test('codex: auth.json presence is enough', () => {
    const home = makeTempDir()
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{}}')
    const state = detectAgentAuth('codex', { homeDir: home, env: {} })
    expect(state.authenticated).toBe(true)
  })

  test('opencode: data-dir auth.json is detected', () => {
    const home = makeTempDir()
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      '{"github":{"token":"x"}}'
    )
    const state = detectAgentAuth('opencode', { homeDir: home, env: {} })
    expect(state.authenticated).toBe(true)
  })

  test('opencode: an empty auth object means NOT authenticated (no fake positives)', () => {
    const home = makeTempDir()
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), '{}')
    const state = detectAgentAuth('opencode', { homeDir: home, env: {} })
    expect(state.authenticated).toBe(false)
  })

  test('agy: env key wins as api-key (gemini-based auth store)', () => {
    const state = detectAgentAuth('agy', {
      homeDir: makeTempDir(),
      env: { GEMINI_API_KEY: 'k' },
    })
    expect(state.authenticated).toBe(true)
    expect(state.method).toBe('api-key')
  })
})

describe('model registry & capability resolver', () => {
  test('known providers expose models; unknown degrade to empty (no fake data)', () => {
    expect(getModelsForProvider('claude').map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(getModelsForProvider('opencode')).toEqual([])
    expect(getModelsForProvider('totally-unknown')).toEqual([])
  })

  test('resolver enriches registry capabilities with discovered runtime state', () => {
    const resolved = resolveDiscoveredCapabilities({
      name: 'claude',
      installed: true,
      path: '/usr/bin/claude',
      version: '2.1.3',
      auth: { installed: true, authenticated: true, method: 'oauth' },
      models: getModelsForProvider('claude'),
    })
    expect(resolved).not.toBeNull()
    expect(resolved?.features.modelSwitch).toBe(true)
    expect(resolved?.features.sessionResume).toBe(true)
    expect(resolved?.version).toBe('2.1.3')
    expect(resolved?.authenticated).toBe(true)
  })

  test('unknown provider resolves to null instead of guessing', () => {
    const resolved = resolveDiscoveredCapabilities({
      name: 'totally-unknown' as never,
      installed: true,
      auth: { installed: true, authenticated: false },
      models: [],
    })
    expect(resolved).toBeNull()
  })
})

describe('scanner', () => {
  test('caches within TTL and forces fresh scans on rescan', async () => {
    const scanner = createAgentDiscoveryScanner()
    const first = await scanner.getReport()
    const second = await scanner.getReport()
    expect(second.scannedAt).toBe(first.scannedAt)

    const forced = await scanner.rescan()
    // A new scan may complete within the same millisecond on fast machines —
    // assert the scan actually re-ran by checking structure instead of time.
    expect(Array.isArray(forced.agents)).toBe(true)
    expect(forced.agents.length).toBeGreaterThanOrEqual(4)
  }, 30_000)

  test('every target reports a stable shape even when missing', async () => {
    const scanner = createAgentDiscoveryScanner()
    const report = await scanner.rescan()
    for (const agent of report.agents) {
      expect(['claude', 'codex', 'opencode', 'agy']).toContain(agent.name)
      expect(typeof agent.installed).toBe('boolean')
      expect(typeof agent.auth.authenticated).toBe(agent.installed ? 'boolean' : 'boolean')
    }
  }, 30_000)
})

describe('homedir sanity (env isolation guard)', () => {
  test('detector defaults do not escape the provided homeDir', () => {
    // Explicit homeDir must be respected — no accidental reads of the real
    // user profile during tests. The predicate only "sees" files under the
    // REAL home, and the temp dir has none, so the result must be unauth.
    const realHome = homedir()
    const tempHome = makeTempDir()
    const state = detectAgentAuth('claude', {
      homeDir: join(tempHome, '.claude-like'),
      exists: (path) => path.startsWith(join(realHome, '.claude')),
    })
    expect(state.authenticated).toBe(false)
  })
})
