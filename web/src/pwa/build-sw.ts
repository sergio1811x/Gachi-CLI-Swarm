import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vite'

const TEMPLATE_URL = new URL('../sw.template.js', import.meta.url)
export const GACHI_SW_TOKEN = '__GACHI_VERSION__'

/**
 * Replace the build-time VERSION token in a service-worker template. Kept as a
 * pure function so substitution behavior is unit-testable without standing up
 * a Vite build.
 */
export const substituteSwTemplate = (template: string, version: string): string =>
  template.split(GACHI_SW_TOKEN).join(version)

interface BuildSwOptions {
  version: string
}

/**
 * Emit `dist/sw.js` during `vite build`. The SW source lives at
 * `web/src/sw.template.js` (not under the type-checked `src/**` tree because it
 * targets ServiceWorkerGlobalScope, which isn't in the runtime tsconfig).
 */
export const buildSw = (options: BuildSwOptions): Plugin => ({
  name: 'gachi-build-sw',
  apply: 'build',
  generateBundle() {
    const template = readFileSync(fileURLToPath(TEMPLATE_URL), 'utf8')
    const source = substituteSwTemplate(template, options.version)
    this.emitFile({ type: 'asset', fileName: 'sw.js', source })
  },
})
