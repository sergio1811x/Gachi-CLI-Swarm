import type { CSSProperties } from 'react'

import { useI18n } from '../i18n.js'
import { localizeMarketplaceCategory } from './categoryLabels.js'

interface CategoryTreeProps {
  categories: readonly string[]
  selected: string | null
  onSelect: (category: string | null) => void
  counts?: Record<string, number>
  showAll: boolean
  onToggleShowAll: () => void
  hiddenCount: number
}

// `--bg-3` and `--bg-elevated` are both #222, so a plain `hover:bg-3` is a
// no-op on the drawer container. These styles use explicit color-mix values
// that actually differ from the surrounding panel.
const HOVER_BG = 'color-mix(in oklab, var(--accent) 8%, transparent)'
const SELECTED_BG = 'color-mix(in oklab, var(--accent) 16%, transparent)'
const SELECTED_BORDER = 'color-mix(in oklab, var(--accent) 55%, transparent)'

interface RowProps {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}

const buttonStyle = (active: boolean): CSSProperties => ({
  background: active ? SELECTED_BG : 'transparent',
  boxShadow: active ? `inset 2px 0 0 ${SELECTED_BORDER}` : 'none',
})

const Row = ({ label, count, active, onClick }: RowProps) => (
  <button
    type="button"
    onClick={onClick}
    data-active={active ? 'true' : 'false'}
    className={`marketplace-category-row flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm transition-colors ${
      active ? 'font-medium text-pri' : 'text-sec'
    }`}
    style={buttonStyle(active)}
  >
    <span className="truncate">{label}</span>
    {count !== undefined ? <span className="tabular-nums text-xs text-sec">{count}</span> : null}
  </button>
)

export const MarketplaceCategoryTree = ({
  categories,
  selected,
  onSelect,
  counts,
  showAll,
  onToggleShowAll,
  hiddenCount,
}: CategoryTreeProps) => {
  const { t, language } = useI18n()
  const totalCount = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : undefined

  return (
    <nav className="flex flex-col gap-0.5" data-testid="marketplace-category-tree">
      {/* Scoped hover styles — `:hover` cannot live in inline `style`. */}
      <style>{`
        .marketplace-category-row[data-active='false']:hover {
          background: ${HOVER_BG};
          color: var(--text-primary);
        }
        .marketplace-toggle-row:hover {
          background: ${HOVER_BG};
          color: var(--text-primary);
        }
      `}</style>
      <Row
        label={t('marketplace.allCategories')}
        count={totalCount}
        active={selected === null}
        onClick={() => onSelect(null)}
      />
      {categories.map((category) => (
        <Row
          key={category}
          label={localizeMarketplaceCategory(category, language)}
          count={counts?.[category]}
          active={selected === category}
          onClick={() => onSelect(category)}
        />
      ))}
      {hiddenCount > 0 || showAll ? (
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border-bright)' }}>
          <button
            type="button"
            onClick={onToggleShowAll}
            data-testid="marketplace-toggle-show-all"
            className="marketplace-toggle-row flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs text-sec transition-colors"
          >
            {showAll
              ? t('marketplace.showCoreOnly')
              : t('marketplace.showAllCategories', { count: hiddenCount })}
          </button>
        </div>
      ) : null}
    </nav>
  )
}
