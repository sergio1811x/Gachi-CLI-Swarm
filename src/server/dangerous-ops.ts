/**
 * R10 safety observability: surface risky commands agents actually ran.
 * Detection is deliberately narrow (root/wildcard deletes, history rewrites,
 * publishing) to stay signal instead of noise — this journals, never blocks.
 */

export type RiskLabel = 'force-push' | 'history-wipe' | 'rm-root' | 'rm-wildcard' | 'publish'

const PATTERNS: ReadonlyArray<readonly [RegExp, RiskLabel]> = [
  [/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f\s)/i, 'force-push'],
  [/\bgit\s+reset\s+--hard\b[^\n]*\borigin\b|\bgit\s+push\b[^\n]*\+\w+@?\{0\}/i, 'history-wipe'],
  [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+"?\/"?(?:\s|$)/i, 'rm-root'],
  [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(["']?[~*]|\$HOME\b)/i, 'rm-wildcard'],
  [/\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i, 'publish'],
]

/** Returns deduplicated labels in first-seen order; empty when clean. */
export const detectDangerousOps = (output: string): RiskLabel[] => {
  const found: RiskLabel[] = []
  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(output) && !found.includes(label)) {
      found.push(label)
    }
  }
  return found
}
