// Marketplace data hook — fetches the bundled manifest/agent for the current UI
// language. Agent body cache has no eviction policy; with ~400 entries × ~5KB
// the per-session upper bound is ≈ 2MB, which is fine to hold.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchMarketplaceAgent,
  fetchMarketplaceManifest,
  type MarketplaceAgentDetail,
  type MarketplaceLanguage,
  type MarketplaceManifest,
} from '../api.js'

interface ManifestState {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  data: MarketplaceManifest | null
  error: string | null
}

const emptyState: ManifestState = { status: 'idle', data: null, error: null }

export const useMarketplace = (language: MarketplaceLanguage, enabled: boolean) => {
  const [manifestState, setManifestState] = useState<ManifestState>(emptyState)
  const manifestCache = useRef(new Map<MarketplaceLanguage, MarketplaceManifest>())
  const agentCache = useRef(new Map<string, MarketplaceAgentDetail>())

  useEffect(() => {
    if (!enabled) return
    const cached = manifestCache.current.get(language)
    if (cached) {
      setManifestState({ status: 'loaded', data: cached, error: null })
      return
    }
    setManifestState({ status: 'loading', data: null, error: null })
    let cancelled = false
    fetchMarketplaceManifest(language)
      .then((data) => {
        if (cancelled) return
        manifestCache.current.set(language, data)
        setManifestState({ status: 'loaded', data, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setManifestState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'unknown',
        })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, language])

  const loadAgent = useCallback(
    async (path: string): Promise<MarketplaceAgentDetail> => {
      const cacheKey = `${language}::${path}`
      const cached = agentCache.current.get(cacheKey)
      if (cached) return cached
      const fresh = await fetchMarketplaceAgent(language, path)
      agentCache.current.set(cacheKey, fresh)
      return fresh
    },
    [language]
  )

  return { manifestState, loadAgent }
}
