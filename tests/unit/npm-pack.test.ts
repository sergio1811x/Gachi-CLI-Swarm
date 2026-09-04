import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

/**
 * Packaging smoke (roadmap Wave 2 — npx distribution): the published/npm-pack
 * tarball must contain everything `npx gachi` needs at runtime — the CLI
 * entry, the compiled server tree, the built web bundle and the team bin
 * shims. Runs `npm pack --dry-run --json` against the repo root.
 */

const REQUIRED_TARBALL_FILES = [
  'package.json',
  'dist/src/cli/gachi.js',
  'dist/bin/team',
  'dist/bin/team.cmd',
  'scripts/fix-runtime-artifacts.mjs',
  'web/dist/index.html',
]

const packOutput = (() => {
  // npm writes the tarball itself; --dry-run skips that but still reports.
  const isWindows = process.platform === 'win32'
  const json = execFileSync(isWindows ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: join(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: 120_000,
    // Node ≥18.20 refuses to spawn .cmd shims without a shell (EINVAL).
    shell: isWindows,
  })
  return JSON.parse(json)
})()

const packedFiles: string[] = (packOutput[0]?.files ?? []).map((f: { path: string }) => f.path)

afterAll(() => {
  // No artifacts are written in dry-run mode; nothing to clean.
})

describe('npm pack contents (npx distribution)', () => {
  test('package.json names the gachi binary pointing at the compiled CLI', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
    expect(pkg.bin?.gachi).toBe('dist/src/cli/gachi.js')
  })

  test.for(REQUIRED_TARBALL_FILES)('%s is present in the tarball', (file) => {
    const found = packedFiles.some((p) => p === file)
    expect(found, `missing from tarball: ${file}`).toBe(true)
  })

  test('the compiled server tree ships more than just the CLI entry', () => {
    const serverFiles = packedFiles.filter((p) => p.startsWith('dist/src/server/'))
    expect(serverFiles.length).toBeGreaterThan(50)
  })

  test('the web bundle ships assets alongside index.html', () => {
    const assetFiles = packedFiles.filter((p) => p.startsWith('web/dist/assets/'))
    expect(assetFiles.length).toBeGreaterThan(0)
  })

  test('no source maps or test files leak into the package', () => {
    const leaks = packedFiles.filter(
      (p) => p.endsWith('.test.js') || p.includes('/tests/') || p.endsWith('.map')
    )
    expect(leaks).toEqual([])
  })
})
