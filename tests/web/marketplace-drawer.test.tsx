// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { MarketplaceDrawer } from '../../web/src/marketplace/MarketplaceDrawer.js'

const { fetchMarketplaceManifest, fetchMarketplaceAgent } = vi.hoisted(() => ({
  fetchMarketplaceManifest: vi.fn(),
  fetchMarketplaceAgent: vi.fn(),
}))

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    fetchMarketplaceManifest: (...args: unknown[]) => fetchMarketplaceManifest(...args),
    fetchMarketplaceAgent: (...args: unknown[]) => fetchMarketplaceAgent(...args),
  }
})

const sampleManifest = {
  source: { repo: 'msitarzewski/agency-agents', commit: 'abc', fetched_at: '2026-05-22T00:00:00Z' },
  language: 'en' as const,
  categories: ['design', 'engineering', 'marketing'],
  agents: [
    {
      path: 'engineering/code-reviewer.md',
      category: 'engineering',
      name: 'Code Reviewer',
      description: 'Reviews code',
      emoji: '👁️',
      color: 'purple',
      vibe: null,
    },
    {
      path: 'design/ui-designer.md',
      category: 'design',
      name: 'UI Designer',
      description: 'Designs UI',
      emoji: '🎨',
      color: 'pink',
      vibe: null,
    },
    {
      path: 'marketing/growth-hacker.md',
      category: 'marketing',
      name: 'Growth Hacker',
      description: 'Drives growth',
      emoji: '📈',
      color: 'green',
      vibe: null,
    },
  ],
}

beforeEach(() => {
  fetchMarketplaceManifest.mockResolvedValue(sampleManifest)
  fetchMarketplaceAgent.mockResolvedValue({
    path: 'engineering/code-reviewer.md',
    frontmatter: { name: 'Code Reviewer' },
    body: 'You review every PR.',
  })
})

afterEach(() => {
  cleanup()
  fetchMarketplaceManifest.mockReset()
  fetchMarketplaceAgent.mockReset()
})

describe('MarketplaceDrawer', () => {
  test('lists categories and agent cards from manifest', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
    })
    expect(screen.getByText('UI Designer')).toBeInTheDocument()
    // Category labels are localized via categoryLabels.ts; en falls back to
    // the dictionary entry (Engineering, Design).
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByText('Design')).toBeInTheDocument()
  })

  test('filters agent list when search query matches name', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())
    const search = screen.getByTestId('marketplace-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'code' } })
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
    expect(screen.queryByText('UI Designer')).not.toBeInTheDocument()
  })

  test('selecting a card loads the preview body via loadAgent', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Code Reviewer'))
    await waitFor(() => {
      expect(screen.getByText('You review every PR.')).toBeInTheDocument()
    })
    expect(fetchMarketplaceAgent).toHaveBeenCalledWith('en', 'engineering/code-reviewer.md')
  })

  test('import button forwards trimmed body + name to onImport and closes drawer', async () => {
    const onImport = vi.fn()
    const onClose = vi.fn()
    render(<MarketplaceDrawer open onClose={onClose} onImport={onImport} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Code Reviewer'))
    const importButton = await screen.findByTestId('marketplace-import-button')
    await waitFor(() => expect(importButton).not.toBeDisabled())
    fireEvent.click(importButton)
    expect(onImport).toHaveBeenCalledWith({
      name: 'Code Reviewer',
      description: 'You review every PR.',
    })
    expect(onClose).toHaveBeenCalled()
  })

  test('renders empty state when no agent matches search', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('marketplace-search'), {
      target: { value: 'nonexistent-search-term' },
    })
    expect(screen.getByText('No matching agents')).toBeInTheDocument()
  })

  test('shows all categories by default and folds non-core away via the toggle', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())

    // Default state: non-core categories visible (Marketing + Growth Hacker
    // both rendered).
    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.getByText('Growth Hacker')).toBeInTheDocument()

    // Toggle to "core only" — marketing collapses away.
    fireEvent.click(screen.getByTestId('marketplace-toggle-show-all'))
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument()
    expect(screen.queryByText('Growth Hacker')).not.toBeInTheDocument()

    // Toggle back — non-core returns.
    fireEvent.click(screen.getByTestId('marketplace-toggle-show-all'))
    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.getByText('Growth Hacker')).toBeInTheDocument()
  })

  test('collapsing all-categories clears a selected agent whose category disappeared', async () => {
    render(<MarketplaceDrawer open onClose={() => {}} onImport={() => {}} />)
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())

    // Default shows everything; select the marketing agent.
    fireEvent.click(screen.getByText('Growth Hacker'))
    await waitFor(() => expect(screen.getByTestId('marketplace-agent-preview')).toBeInTheDocument())

    // Toggle to "core only". Growth Hacker leaves the grid AND the preview
    // pane drops (selectedAgent cleared because its category is no longer
    // in the visible set).
    fireEvent.click(screen.getByTestId('marketplace-toggle-show-all'))
    expect(screen.queryByText('Growth Hacker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('marketplace-agent-preview')).not.toBeInTheDocument()
  })

  test('marks agents that match an importedNames entry with the imported badge', async () => {
    const importedNames = new Set(['Code Reviewer'])
    render(
      <MarketplaceDrawer
        open
        onClose={() => {}}
        onImport={() => {}}
        importedNames={importedNames}
      />
    )
    await waitFor(() => expect(screen.getByText('Code Reviewer')).toBeInTheDocument())
    const cards = screen.getAllByTestId('marketplace-agent-card')
    const importedCard = cards.find(
      (card) => card.dataset.agentPath === 'engineering/code-reviewer.md'
    )
    const otherCard = cards.find((card) => card.dataset.agentPath === 'design/ui-designer.md')
    expect(importedCard?.dataset.imported).toBe('true')
    expect(otherCard?.dataset.imported).toBeUndefined()
  })
})
