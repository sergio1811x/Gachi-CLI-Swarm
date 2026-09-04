/**
 * Structured task completion contract.
 *
 * Workers are encouraged to report completion with a machine-readable block so
 * the runtime does not rely on free text alone. A report body may carry an
 * optional block like:
 *
 *   TASK_COMPLETED {
 *     "taskId": "...",
 *     "summary": "what changed and why",
 *     "filesChanged": ["src/a.ts", "tests/a.test.ts"],
 *     "tests": ["pnpm test"]
 *   }
 *
 * The `status` value matches the block keyword (completed | failed | blocked).
 * If no structured block is present the report is treated as unstructured free
 * text (legacy behaviour) and `parseStructuredCompletion` returns `undefined`.
 */
export interface TaskCompletion {
  filesChanged: string[]
  status: 'completed' | 'failed' | 'blocked'
  summary: string
  tests: string[]
}

const COMPLETION_BLOCK_RE = /TASK_(COMPLETED|FAILED|BLOCKED)\s*\{([\s\S]*?)\}\s*/iu

const isString = (value: unknown): value is string => typeof value === 'string'

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(isString) : []

export const parseStructuredCompletion = (text: string): TaskCompletion | undefined => {
  const match = COMPLETION_BLOCK_RE.exec(text)
  if (!match) return undefined
  const statusWord = match[1]
  const raw = match[2]
  if (!statusWord || !raw) return undefined
  const status = statusWord.toLowerCase() as TaskCompletion['status']
  try {
    const body = JSON.parse(`{${raw}}`) as {
      filesChanged?: unknown
      summary?: unknown
      tests?: unknown
    }
    return {
      filesChanged: toStringArray(body.filesChanged),
      status,
      summary: isString(body.summary) ? body.summary : '',
      tests: toStringArray(body.tests),
    }
  } catch {
    // The block was malformed; fall back to treating the whole report as text.
    return undefined
  }
}
