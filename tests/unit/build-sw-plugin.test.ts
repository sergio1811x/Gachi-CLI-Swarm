import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'vite'
import { afterEach, describe, expect, test } from 'vitest'

import { buildSw, GACH_SW_TOKEN } from '../../web/src/pwa/build-sw.js'

// Real `vite.build()` against a tmp project — the only way to prove the plugin
// integrates with Vite's bundle generation, not just that we can call its hook
// in isolation. Per AGENTS.md §3 we avoid asserting on captured mock calls and
// instead read the actual emitted file from disk. The full build takes ~1s
// locally and a bit more on Windows CI, which is why `package.json#test:windows`
// runs with `--testTimeout=60000`.

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeTempProject = () => {
  // realpathSync resolves macOS's /tmp -> /private/tmp symlink. Without it Vite's
  // HTML plugin emits index.html with a ../../.../private/... fileName which
  // Rollup then rejects ("must not be a relative path").
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gachi-build-sw-')))
  tempDirs.push(root)
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>'
  )
  writeFileSync(join(root, 'main.js'), 'console.log("hi")\n')
  return root
}

describe('buildSw vite plugin', () => {
  test('vite build emits dist/sw.js with the version substituted and the token absent', async () => {
    const root = makeTempProject()
    const outDir = join(root, 'dist')

    await build({
      root,
      logLevel: 'silent',
      build: { emptyOutDir: true, outDir, write: true },
      plugins: [buildSw({ version: '9.9.9-fixture' })],
    })

    const sw = readFileSync(join(outDir, 'sw.js'), 'utf8')
    expect(sw).toContain('9.9.9-fixture')
    expect(sw).not.toContain(GACH_SW_TOKEN)
    // Verify the emitted file is the real SW source (i.e. the plugin didn't
    // emit some unrelated bytes that happen to contain the version string).
    expect(sw).toContain('SHELL_CACHE')
    expect(sw).toContain("addEventListener('fetch'")
  })
})
