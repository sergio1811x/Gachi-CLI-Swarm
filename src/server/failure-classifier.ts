/**
 * Orchestrator feedback #2: "status: failed" without a WHY is useless. This
 * classifies a run's failure from its recorded error plus the tail of the PTY
 * output (the CLI prints the real cause there: 429s, invalid tokens, OOM
 * aborts, missing binaries, network failures). Category flows into the task
 * journal and `team list` so triage does not require opening terminals.
 */

export type FailureCategory =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'network'
  | 'oom'
  | 'disk'
  | 'cli-missing'
  | 'crash'
  | 'nonzero-exit'

export interface ClassifiedFailure {
  category: FailureCategory
  /** Single-line evidence snippet (trimmed, control chars stripped). */
  detail: string
}

/**
 * Bare HTTP status codes only count as distress in an error context. Without
 * the lookbehind, source line references (`app.ts:429:5`), URLs and version
 * strings in a busy worker's normal output read as a 401/429/402 failure. The
 * trailing lookahead also rejects a `line:column` frame (`at 401:12`) — a real
 * status is followed by whitespace/word text, never by a colon+column.
 */
const STATUS_CODE = (code: number): string => `(?<![\\w:.\\\\/@-])${code}(?![\\w])(?!:\\d)`

const PATTERNS: ReadonlyArray<readonly [FailureCategory, RegExp]> = [
  [
    'auth',
    new RegExp(
      `invalid api key|unauthorized|${STATUS_CODE(401)}|auth(?:entication)?[_. ]?(?:error|failure|failed)|login required|not logged in|invalid credentials?`,
      'i'
    ),
  ],
  ['rate-limit', new RegExp(`rate limit|too many requests|${STATUS_CODE(429)}`, 'i')],
  [
    'quota',
    new RegExp(
      `quota exceeded|insufficient.*(credits|balance)|billing|payment required|${STATUS_CODE(402)}`,
      'i'
    ),
  ],
  [
    'network',
    /fetch failed|econnrefused|enotfound|etimedout|econnreset|network error|getaddrinfo/i,
  ],
  // \boom\b: the bare token used to match "bloom" and friends in ordinary output.
  ['oom', /heap out of memory|out of memory|enomem|\boom\b|killed.*signal/i],
  ['disk', /enospc|no space left on device|read-only file system/i],
  ['cli-missing', /command not found|is not recognized|enoent|not found in path|exit code 127/i],
]

const cleanLine = (line: string): string => {
  // Strip ANSI escapes and collapse whitespace for readable one-liners.
  // biome-ignore lint/complexity/useRegexLiterals: ESC chars are banned in regex literals by noControlCharactersInRegex, so build from string form.
  const csi = new RegExp('\\u001B\\[[0-9;?]*[A-Za-z]', 'g')
  // biome-ignore lint/complexity/useRegexLiterals: same ESC constraint as above.
  const osc = new RegExp('\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)', 'g')
  return line.replace(csi, '').replace(osc, '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export const classifyFailure = (
  outputTail: string,
  exitCode: number | null,
  recordedError?: string | null
): ClassifiedFailure => {
  const haystacks = [recordedError ?? '', outputTail ?? '']
  for (const [category, pattern] of PATTERNS) {
    for (const haystack of haystacks) {
      if (!haystack) continue
      const match = pattern.exec(haystack)
      if (match) {
        const line =
          haystacks
            .map((text) => text.split(/\r?\n/).find((candidate) => pattern.test(candidate)) ?? '')
            .find(Boolean) ?? match[0]
        return { category, detail: cleanLine(line) || match[0] }
      }
    }
  }
  if ((exitCode ?? 0) !== 0) {
    const lastMeaningful = cleanLine(
      (outputTail ?? '').split(/\r?\n/).filter(Boolean).slice(-3).join(' │ ') || recordedError || ''
    )
    return { category: 'nonzero-exit', detail: lastMeaningful || `exit ${exitCode}` }
  }
  return {
    category: 'crash',
    detail: cleanLine(recordedError || '') || 'no failure output captured',
  }
}

/** Last N characters of PTY output — enough evidence, never the whole log. */
export const OUTPUT_TAIL_CHARS = 6_000

/**
 * Live distress detection for RUNNING workers (R10 stall problem): the exit
 * classifier only sees dead processes, but a worker blocked on a rate limit,
 * expired quota or auth prompt is still "running" — and looked productive to
 * everyone. This matches only EXPLICIT distress patterns (no exit-code or
 * crash fallbacks), so a busy healthy spinner never false-positives.
 *
 * B4 false-positive guard: only the LAST lines of the tail are eligible. A
 * stuck CLI's distress (error banner, permission dialog) IS its latest
 * rendered output, while a worker that already recovered keeps producing
 * output that pushes the old error out of the current screen — without this
 * window the transcript history re-alerted recovered workers on every scan.
 */
export const LIVE_DISTRESS_TAIL_LINES = 10

export const lastTailLines = (tail: string, lineCount: number): string => {
  if (lineCount <= 0) return ''
  return tail.split(/\r?\n/).slice(-lineCount).join('\n')
}

export const detectLiveDistress = (tail: string): ClassifiedFailure | null => {
  if (!tail) return null
  const recent = lastTailLines(tail, LIVE_DISTRESS_TAIL_LINES)
  for (const [category, pattern] of PATTERNS) {
    const match = pattern.exec(recent)
    if (!match) continue
    const line = recent.split(/\r?\n/).find((candidate) => pattern.test(candidate)) ?? match[0]
    return { category, detail: cleanLine(line) || match[0] }
  }
  return null
}

export const tailOf = (output: string | undefined | null): string =>
  output ? output.slice(-OUTPUT_TAIL_CHARS) : ''

const isSuccessExit = (reason: string): boolean => reason === 'success'

export { isSuccessExit }
