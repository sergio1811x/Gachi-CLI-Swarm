import { Bookmark } from 'lucide-react'

import type { MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'

interface MarketplaceAgentCardProps {
  agent: MarketplaceAgentEntry
  selected: boolean
  imported: boolean
  onSelect: () => void
}

// Card surface uses bg-2 (a step below the drawer's bg-elevated container) so
// cards visually sit on a "table" rather than blending into it. Selected state
// gets an accent-mix wash + accent border so the picked card actually pops
// against its neighbors.
const cardBackground = (selected: boolean): string =>
  selected ? 'color-mix(in oklab, var(--accent) 14%, var(--bg-2))' : 'var(--bg-2)'

const cardBorder = (selected: boolean): string =>
  selected ? 'var(--accent)' : 'var(--border-bright)'

export const MarketplaceAgentCard = ({
  agent,
  selected,
  imported,
  onSelect,
}: MarketplaceAgentCardProps) => {
  const { t } = useI18n()
  const tagline = agent.vibe?.trim() ? agent.vibe : agent.description
  const importedLabel = t('marketplace.importedBadge')
  const displayName = agent.displayName ?? agent.name
  const nameTitle = agent.nameOverflows ? displayName : undefined
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="marketplace-agent-card"
      data-agent-path={agent.path}
      data-imported={imported ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className="marketplace-card flex w-full cursor-pointer flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left outline-none transition-[background,border-color,transform] duration-100 ease-out focus-visible:ring-2 focus-visible:ring-offset-0 active:translate-y-px"
      style={{
        background: cardBackground(selected),
        borderColor: cardBorder(selected),
        ['--tw-ring-color' as string]: 'color-mix(in oklab, var(--accent) 55%, transparent)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {agent.emoji ? <span className="text-base leading-none">{agent.emoji}</span> : null}
          <span className="truncate text-sm font-semibold text-pri" title={nameTitle}>
            {displayName}
          </span>
        </div>
        {imported ? (
          <span
            role="img"
            aria-label={importedLabel}
            title={importedLabel}
            data-testid="marketplace-agent-imported"
            className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
            style={{
              // On a selected card the background is already an accent-mix
              // wash, so a translucent accent pill dissolves into it. Flip to
              // a solid accent fill so the imported state stays visible even
              // when the card is also the active one. Unselected: opaque
              // accent on bg-2 — AA-readable instead of the 18% mix which
              // came in at ~2.4:1.
              background: selected
                ? 'var(--accent)'
                : 'color-mix(in oklab, var(--accent) 28%, transparent)',
              color: selected ? '#ffffff' : 'color-mix(in oklab, var(--accent) 60%, white)',
            }}
          >
            <Bookmark size={10} aria-hidden />
          </span>
        ) : null}
      </div>
      <p className="line-clamp-1 text-xs leading-snug text-sec">{tagline}</p>
    </button>
  )
}
