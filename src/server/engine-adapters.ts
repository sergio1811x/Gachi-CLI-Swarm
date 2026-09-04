/**
 * R11: explicit per-engine adapter registry.
 *
 * The swarm talks to external CLIs through fragile surfaces (PTY output,
 * auth state files, resume markers). This registry centralizes what we know
 * about each supported engine so the rest of the code never hard-codes
 * engine-specific details and drift becomes visible in review.
 *
 * Non-goal: supporting every CLI that exists. This list is the official
 * support surface; anything not listed works only via the generic preset.
 */

export interface EngineAdapter {
  /** Lowercase command/preset identifier (`claude`, `codex`, …). */
  id: string
  displayName: string
  /** How a user authenticates this CLI once, for doctor remediation hints. */
  loginHint: string
  /** Known scraping/integration limits, surfaced in docs. */
  limitations: readonly string[]
}

export const ENGINE_ADAPTERS: readonly EngineAdapter[] = [
  {
    displayName: 'Claude Code',
    id: 'claude',
    limitations: [
      'context%/tokens scraped from status line output',
      'resume relies on session-id capture with 600s timeout',
    ],
    loginHint: 'run `claude` once interactively and complete OAuth, or set ANTHROPIC_API_KEY',
  },
  {
    displayName: 'Codex CLI',
    id: 'codex',
    limitations: ['status footer format varies between versions', 'model switching unsupported'],
    loginHint: 'run `codex` once interactively and complete ChatGPT/OAuth sign-in',
  },
  {
    displayName: 'OpenCode',
    id: 'opencode',
    limitations: [
      'permission prompts auto-answered under allow-all mode (see permission settings)',
      'allow-all opencode.json is written into the workspace on first launch',
    ],
    loginHint: 'run `opencode` once interactively to finish provider sign-in',
  },
  {
    displayName: 'Gemini CLI',
    id: 'gemini',
    limitations: ['tokens total not always printed (null telemetry)', 'no model switch contract'],
    loginHint: 'run `gemini` once interactively and complete Google sign-in',
  },
]

export const findEngineAdapter = (id: string | null | undefined): EngineAdapter | undefined =>
  id ? ENGINE_ADAPTERS.find((adapter) => adapter.id === id.toLowerCase()) : undefined
