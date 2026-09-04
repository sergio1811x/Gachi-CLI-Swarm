// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { CliAgentAvatar } from '../../web/src/worker/CliAgentAvatar.js'

afterEach(() => cleanup())

describe('CliAgentAvatar — known preset renders the brand logo', () => {
  // Lock the wire shape that matters to the UI: built-in preset ids from
  // `command-preset-defaults.ts` must each resolve to a logo. If a future
  // refactor renames an id (e.g. `claude` → `claude-code`), this test breaks
  // before users see a blank avatar.
  test.each([
    ['claude', '/cli-icons/claude.png'],
    ['codex', '/cli-icons/codex.png'],
    ['opencode', '/cli-icons/opencode.svg'],
  ])('preset %s → %s', (presetId, expectedSrc) => {
    render(<CliAgentAvatar commandPresetId={presetId} workerRole="coder" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('data-command-preset')).toBe(presetId)
    const img = avatar.querySelector('img')
    expect(img?.getAttribute('src')).toBe(expectedSrc)
    expect(img?.getAttribute('decoding')).toBe('sync')
  })
})

describe('CliAgentAvatar — fallback path', () => {
  test('unknown commandPresetId falls back to the role-letter avatar (no logo node)', () => {
    // Future presets the UI hasn't been taught about yet must not render
    // blank — they should degrade to the legacy role-letter avatar that
    // every existing worker had before this feature shipped.
    render(<CliAgentAvatar commandPresetId="qwen-future-thing" workerRole="reviewer" />)
    expect(screen.queryByTestId('cli-agent-avatar')).toBeNull()
    expect(screen.getByTestId('role-avatar')).toBeInTheDocument()
  })

  test('undefined commandPresetId falls back (historical workers without a launch config row)', () => {
    // Older workers created before the launch_config table was populated
    // arrive at the UI with commandPresetId === undefined. The route layer
    // returns null, the deserializer drops the field, and the avatar must
    // still render something rather than throwing.
    render(<CliAgentAvatar workerRole="coder" />)
    expect(screen.queryByTestId('cli-agent-avatar')).toBeNull()
    expect(screen.getByTestId('role-avatar')).toBeInTheDocument()
  })
})

describe('CliAgentAvatar — status halo', () => {
  test('status ring color is wired through to the rendered box-shadow', () => {
    // The halo is the only piece that visually changes between idle/working/
    // stopped, so wiring it correctly is the single most testable thing on
    // this component. We assert on the data attribute (semantic) rather than
    // the exact box-shadow string, so a future swap to a CSS variable
    // doesn't break the test for no reason.
    render(<CliAgentAvatar commandPresetId="claude" workerRole="coder" statusRing="working" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('data-status-ring')).toBe('working')
    expect(avatar.getAttribute('style')).toContain('box-shadow')
  })

  test('agy has no brand logo yet → role-letter fallback renders', () => {
    render(
      <CliAgentAvatar
        commandPresetId="agy"
        workerName="Scout"
        workerRole="coder"
        statusRing="none"
      />
    )
    expect(screen.queryByTestId('cli-agent-avatar')).toBeNull()
    const fallback = screen.getByTestId('role-avatar')
    expect(fallback.getAttribute('data-status-ring')).toBe('none')
  })
})

describe('CliAgentAvatar — a11y', () => {
  test('decorative avatar exposes nothing to assistive tech (parent button owns the label)', () => {
    // The worker card's outer <button> already carries `aria-label="Open
    // <name>"`. Letting the logo announce "Claude Code" too would create a
    // double-read; keeping the avatar `aria-hidden` and the <img alt=""> is
    // the documented pattern in the repo's Avatar primitive.
    render(<CliAgentAvatar commandPresetId="claude" workerRole="coder" />)
    const avatar = screen.getByTestId('cli-agent-avatar')
    expect(avatar.getAttribute('aria-hidden')).toBe('true')
    const img = avatar.querySelector('img')
    expect(img?.getAttribute('alt')).toBe('')
  })
})
