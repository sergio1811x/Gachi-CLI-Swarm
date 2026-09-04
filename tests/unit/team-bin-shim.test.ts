import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

/**
 * The team bin shim is copied verbatim from bin/ to dist/bin/ by
 * scripts/prepare-build-artifacts.mjs, so its CLI-module resolution must work
 * from BOTH layouts. Regression: the shim used a single static
 * '../dist/src/cli/team.js' import which, when executed from dist/bin/,
 * resolved to dist/dist/src/cli/team.js and crashed every `team` invocation
 * in a built install.
 */

const tempDirs: string[] = []

const makeLayout = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'team-bin-shim-'))
  tempDirs.push(root)
  return root
}

const writeStubCli = (root: string, cliDir: 'dist/src/cli' | 'src/cli') => {
  const cliPath = join(root, cliDir)
  mkdirSync(cliPath, { recursive: true })
  writeFileSync(
    join(cliPath, 'team.js'),
    'export const runTeamCommand = async () => { console.log("SHIM_OK") }\n'
  )
}

const runShim = (root: string, shimDir: 'bin' | 'dist/bin'): string => {
  const shimDirPath = join(root, shimDir)
  mkdirSync(shimDirPath, { recursive: true })
  copyFileSync(join(__dirname, '..', '..', 'bin', 'team'), join(shimDirPath, 'team'))
  return execFileSync(process.execPath, [join(shimDirPath, 'team'), 'list'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('team bin shim CLI resolution', () => {
  test('repo layout: bin/team resolves dist/src/cli/team.js', () => {
    const root = makeLayout()
    writeStubCli(root, 'dist/src/cli')
    expect(runShim(root, 'bin')).toContain('SHIM_OK')
  })

  test('deployed layout: dist/bin/team must NOT resolve dist/dist (regression)', () => {
    const root = makeLayout()
    writeStubCli(root, 'dist/src/cli')
    expect(runShim(root, 'dist/bin')).toContain('SHIM_OK')
  })

  test('source layout: bin/team falls back to src/cli when no build exists', () => {
    const root = makeLayout()
    writeStubCli(root, 'src/cli')
    expect(runShim(root, 'bin')).toContain('SHIM_OK')
  })
})
