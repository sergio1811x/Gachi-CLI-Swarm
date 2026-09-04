import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readEnv } from '../../src/server/env.js'

import { startTestServer } from '../helpers/test-server.js'

// Server-level integration test for PWA static assets. We pre-populate a
// synthetic static dir (matching the shape `pnpm build` would emit) and point
// the runtime at it via GACH_STATIC_DIR. The fixture sw.js intentionally
// contains a stand-in version string — proving that build-time substitution
// happened belongs to tests/unit/build-sw-plugin.test.ts, not here. This file
// only proves the HTTP server returns the right headers and bytes for the
// files Vite emits.

let staticDir: string
let savedStaticDirEnv: string | undefined
let server: Awaited<ReturnType<typeof startTestServer>>

const FIXTURE_SW_BODY = [
  '// Fixture SW for static-pwa.test.ts.',
  "const VERSION = '0.0.0-static-pwa-fixture'",
  "self.addEventListener('install', () => {})",
  "self.addEventListener('fetch', () => {})",
  '',
].join('\n')

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'gachi-static-pwa-'))

  // SPA fallback needs an index.html.
  writeFileSync(
    join(staticDir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>'
  )

  // Manifest comes from the real web/public source.
  copyFileSync(
    join(process.cwd(), 'web/public/manifest.webmanifest'),
    join(staticDir, 'manifest.webmanifest')
  )

  writeFileSync(join(staticDir, 'sw.js'), FIXTURE_SW_BODY)

  mkdirSync(join(staticDir, 'icons'), { recursive: true })
  for (const name of [
    'icon-32.png',
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'apple-touch-icon-180.png',
  ]) {
    copyFileSync(join(process.cwd(), 'web/public/icons', name), join(staticDir, 'icons', name))
  }

  mkdirSync(join(staticDir, 'screenshots'), { recursive: true })
  copyFileSync(
    join(process.cwd(), 'web/public/screenshots/wide-overview.png'),
    join(staticDir, 'screenshots/wide-overview.png')
  )

  savedStaticDirEnv = readEnv('STATIC_DIR')
  process.env.GACH_STATIC_DIR = staticDir
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
  if (savedStaticDirEnv === undefined) {
    delete process.env.GACH_STATIC_DIR
    delete process.env.GACH_STATIC_DIR
  } else {
    process.env.GACH_STATIC_DIR = savedStaticDirEnv
  }

  rmSync(staticDir, { force: true, recursive: true })
})

describe('PWA static assets over HTTP', () => {
  test('manifest is served as application/manifest+json with conservative caching', async () => {
    const response = await fetch(`${server.baseUrl}/manifest.webmanifest`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('max-age=0, must-revalidate')
    const manifest = (await response.json()) as Record<string, unknown>
    expect(manifest.name).toBe('Gachi CLI Swarm — Multi-agent CLI workbench')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    const icons = manifest.icons as Array<Record<string, unknown>>
    expect(icons).toHaveLength(3)
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    const shortcuts = manifest.shortcuts as Array<Record<string, unknown>>
    expect(shortcuts.map((s) => s.url)).toEqual(['/?action=add-workspace'])
  })

  test('sw.js is served as javascript with no-store and unchanged body', async () => {
    const response = await fetch(`${server.baseUrl}/sw.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toBe(FIXTURE_SW_BODY)
  })

  test('icon assets are served as image/png at non-zero size', async () => {
    for (const name of [
      'icon-32.png',
      'icon-192.png',
      'icon-512.png',
      'icon-512-maskable.png',
      'apple-touch-icon-180.png',
    ]) {
      const response = await fetch(`${server.baseUrl}/icons/${name}`)
      expect(response.status, name).toBe(200)
      expect(response.headers.get('content-type'), name).toBe('image/png')
      const buffer = await response.arrayBuffer()
      expect(buffer.byteLength, name).toBeGreaterThan(0)
    }
  })

  test('screenshot asset is served as image/png', async () => {
    const response = await fetch(`${server.baseUrl}/screenshots/wide-overview.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const buffer = await response.arrayBuffer()
    expect(buffer.byteLength).toBeGreaterThan(0)
  })

  test('non-PWA static assets carry no cache-control header (regression guard)', async () => {
    // The Cache-Control hardening must only apply to /sw.js and
    // /manifest.webmanifest — adding it to icons or screenshots would defeat
    // the browser's normal long-cache behavior on hashed assets.
    const response = await fetch(`${server.baseUrl}/icons/icon-192.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBeNull()
  })
})
