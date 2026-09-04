// Marketplace store — read-only access to the bundled `vendor/marketplace/`
// snapshot of upstream agent prompt repos (one per UI language).
//
// **Vendor path invariant**: `new URL('../../vendor/marketplace', import.meta.url)`
// resolves the same in dev and dist because `tsconfig.json` has `rootDir: "."`.
//   - dev: this file is `src/server/marketplace-store.ts` → repo-root `vendor/`
//   - dist: this file is `dist/src/server/marketplace-store.js` → `dist/vendor/`
//
// The build hook (`scripts/prepare-build-artifacts.mjs`) copies the source-of-
// truth `vendor/marketplace/` into `dist/vendor/marketplace/` at pack time. If
// either the `rootDir` setting or the build hook changes, that invariant must
// be re-verified — there is no fallback path.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { readEnv } from './env.js'

import { isPathWithinRoot } from './fs-sandbox.js'

export type MarketplaceLanguage = 'en'

export interface MarketplaceAgentEntry {
  path: string
  category: string
  name: string
  displayName?: string
  nameOverflows?: boolean
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
}

export interface MarketplaceManifest {
  source: {
    repo: string
    commit: string
    fetched_at: string
  }
  language: MarketplaceLanguage
  categories: string[]
  agents: MarketplaceAgentEntry[]
}

export interface MarketplaceAgentDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

export class MarketplaceNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketplaceNotFoundError'
  }
}

const SUPPORTED_LANGUAGES: ReadonlySet<MarketplaceLanguage> = new Set(['en'])

export const isMarketplaceLanguage = (value: unknown): value is MarketplaceLanguage =>
  typeof value === 'string' && SUPPORTED_LANGUAGES.has(value as MarketplaceLanguage)

const defaultVendorRoot = (): string =>
  fileURLToPath(new URL('../../vendor/marketplace', import.meta.url))

/**
 * Where on disk the bundled marketplace lives. Tests inject a fixture via
 * `GACH_MARKETPLACE_VENDOR_ROOT` (mirrors fs-sandbox's GACH_FS_BROWSE_ROOT).
 */
export const getMarketplaceVendorRoot = (): string => {
  const override = readEnv('MARKETPLACE_VENDOR_ROOT')
  return override && override.length > 0 ? resolve(override) : defaultVendorRoot()
}

const languageRoot = (language: MarketplaceLanguage): string =>
  resolve(getMarketplaceVendorRoot(), language)

export const loadManifest = (language: MarketplaceLanguage): MarketplaceManifest => {
  const manifestPath = resolve(languageRoot(language), 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new MarketplaceNotFoundError(`Marketplace manifest missing for language: ${language}`)
  }
  const raw = readFileSync(manifestPath, 'utf8')
  return JSON.parse(raw) as MarketplaceManifest
}

export const readAgent = (
  language: MarketplaceLanguage,
  relativePath: string
): MarketplaceAgentDetail => {
  if (!relativePath.endsWith('.md')) {
    throw new MarketplaceNotFoundError(`Marketplace agent path must end with .md: ${relativePath}`)
  }
  const root = languageRoot(language)
  const candidate = resolve(root, relativePath)
  if (!isPathWithinRoot(root, candidate)) {
    throw new MarketplaceNotFoundError(
      `Marketplace agent path escapes language root: ${relativePath}`
    )
  }
  if (!existsSync(candidate)) {
    throw new MarketplaceNotFoundError(`Marketplace agent not found: ${language}/${relativePath}`)
  }
  // Guard against upstream pushing a directory whose name ends in `.md` —
  // the suffix check would pass, existsSync would pass, but readFileSync
  // would throw EISDIR. Surface as a 404 instead of a 500.
  if (!statSync(candidate).isFile()) {
    throw new MarketplaceNotFoundError(`Marketplace agent not a file: ${language}/${relativePath}`)
  }
  const raw = readFileSync(candidate, 'utf8')
  const parsed = matter(raw)
  return {
    path: relativePath,
    frontmatter: parsed.data,
    body: parsed.content,
  }
}
