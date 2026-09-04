import DOMPurify from 'isomorphic-dompurify'
import { ExternalLink } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'

import type { MarketplaceAgentDetail, MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'

// marked@18 parse() returns string when async:false. Pass the option per-call
// so a future upgrade that flips the default doesn't silently start returning
// Promise objects that DOMPurify happily stringifies to "[object Promise]".
marked.setOptions({ breaks: false, gfm: true })

const renderMarkdownToSafeHtml = (body: string): string => {
  const rawHtml = marked.parse(body, { async: false })
  if (typeof rawHtml !== 'string') {
    // Defensive: marked v18 with async:false always returns string. If we
    // ever land here, fail loudly instead of rendering "[object Promise]".
    throw new Error('marked.parse returned a non-string with async:false')
  }
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ['href', 'name', 'target', 'rel', 'title', 'class', 'id'],
  })
}

interface MarketplaceAgentPreviewProps {
  agent: MarketplaceAgentEntry
  sourceRepo: string
  loadAgent: (path: string) => Promise<MarketplaceAgentDetail>
  onImport: (detail: { name: string; description: string }) => void
}

export const MarketplaceAgentPreview = ({
  agent,
  sourceRepo,
  loadAgent,
  onImport,
}: MarketplaceAgentPreviewProps) => {
  const { t } = useI18n()
  const [state, setState] = useState<{
    status: 'loading' | 'loaded' | 'error'
    detail: MarketplaceAgentDetail | null
    error: string | null
  }>({ status: 'loading', detail: null, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', detail: null, error: null })
    loadAgent(agent.path)
      .then((detail) => {
        if (cancelled) return
        setState({ status: 'loaded', detail, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          detail: null,
          error: error instanceof Error ? error.message : 'unknown',
        })
      })
    return () => {
      cancelled = true
    }
  }, [agent.path, loadAgent])

  const sourceUrl = `https://github.com/${sourceRepo}/blob/HEAD/${agent.path}`

  const renderedHtml = useMemo(() => {
    if (state.status !== 'loaded' || !state.detail) return null
    return renderMarkdownToSafeHtml(state.detail.body)
  }, [state])

  return (
    <div
      data-testid="marketplace-agent-preview"
      className="flex h-full flex-col gap-3 border-l px-4 py-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <header className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          {agent.emoji ? (
            <span className="shrink-0 text-lg leading-none">{agent.emoji}</span>
          ) : null}
          <h3 className="min-w-0 break-words text-base font-semibold text-pri">{agent.name}</h3>
        </div>
        <p className="text-xs text-ter">{agent.description}</p>
      </header>
      <div
        key={agent.path}
        className="scroll-y min-h-0 flex-1 rounded px-3 py-2 text-xs leading-relaxed"
        style={{ background: 'var(--bg-2)' }}
      >
        {state.status === 'loading' ? <p className="text-ter">…</p> : null}
        {state.status === 'error' ? (
          <p className="text-ter">
            {t('marketplace.loadFailed')}: {state.error}
          </p>
        ) : null}
        {state.status === 'loaded' && renderedHtml ? (
          <div
            className="marketplace-prose"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: marked output sanitized via DOMPurify with restricted attribute allowlist
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : null}
      </div>
      <footer className="flex items-center justify-between gap-2">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-sec transition-colors hover:text-pri"
        >
          {t('marketplace.viewSource')}
          <ExternalLink size={11} aria-hidden />
        </a>
        <button
          type="button"
          disabled={state.status !== 'loaded' || !state.detail}
          onClick={() => {
            if (!state.detail) return
            onImport({ name: agent.name, description: state.detail.body.trim() })
          }}
          data-testid="marketplace-import-button"
          className="icon-btn icon-btn--primary"
        >
          {t('marketplace.importButton')}
        </button>
      </footer>
    </div>
  )
}
