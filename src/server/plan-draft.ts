import type { WorkerRole } from '../shared/types.js'

/**
 * Plan draft capture (ROADMAP R2.2): turns the orchestrator's structured
 * reply into a draft plan group.
 *
 * Contract (prompt side, see buildPlannerPrompt):
 *   [PLAN_BEGIN] <planGroupId>
 *   [PLAN_TASK] <title> :: <description> :: <deps 1-based csv> :: <skills csv> :: <role>
 *   ...
 *   [PLAN_DONE] <planGroupId>
 *
 * Lines may be painted with ANSI colors / TUI bullets — the assembler strips
 * them exactly like the [TG_REPLY] bridge. Chunks arrive arbitrarily split,
 * so buffering mirrors the reply forwarder.
 */

export interface ParsedPlanTask {
  title: string
  description: string
  dependencyOrdinals: number[]
  requiredSkills: string[]
  role: WorkerRole
}

const ROLES_ALIASES: Record<string, WorkerRole> = {
  coder: 'coder',
  code: 'coder',
  backend: 'coder',
  frontend: 'coder',
  tester: 'tester',
  qa: 'tester',
  test: 'tester',
  reviewer: 'reviewer',
  review: 'reviewer',
  custom: 'custom',
}

const MAX_TASKS = 12

/** CSI + OSC + single-char escape sequences, same class as the TG bridge. */
const ANSI_ESCAPE_RE = new RegExp(
  '\\u001b\\[[0-9;?]*[ -/]*[@-~]' + '|\\u001B\\].*?(?:\\u0007|\\u001B\\\\)' + '|\\u001B[@-Z\\-_]',
  'g'
)

const cleanLine = (raw: string): string =>
  raw
    // A bare \r is a TUI cursor rewind (spinner repaint): everything before
    // it was overwritten on the terminal, so only the tail survives. (The
    // old code deleted \r outright, gluing repaints onto the stale prefix
    // and silently breaking the anchored [PLAN_*] matches.)
    .slice(raw.lastIndexOf('\r') + 1)
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/^\s*[●•*>·]+\s*/, '')
    .trim()

export const buildPlannerPrompt = (goal: string, groupId: string): string => {
  const trimmedGoal = goal.trim().slice(0, 4000)
  return [
    '',
    '── PLANNER MODE ──────────────────────────────────────────────',
    'Decompose the GOAL below into an ordered task graph for the swarm.',
    'Reply STRICTLY in this machine format (one line per task), no prose:',
    '',
    '[PLAN_BEGIN] GROUP',
    '[PLAN_TASK] Title :: what exactly to do :: deps(1-based csv, may be empty) :: skills csv :: role',
    '[PLAN_DONE] GROUP',
    '',
    'Rules: 3–12 tasks; deps reference ordinal numbers of this list and must',
    'point BACKWARD; roles: coder|tester|reviewer|custom; skills lowercase.',
    'Replace GROUP with the exact group id given at the end of this message.',
    `GOAL: ${trimmedGoal}`,
    `GROUP: ${groupId}`,
    '──────────────────────────────────────────────────────────────',
    '',
  ].join('\n')
}

export interface PlanDraftCapture {
  push: (chunk: string) => void
}

export interface PlanDraftCaptureDeps {
  /** Group ids this runtime actually requested (unknown groups are ignored). */
  isPending: (groupId: string) => boolean
  /** Persists one parsed task (ordinal is 1-based position in this list). */
  createTask: (groupId: string, task: ParsedPlanTask) => boolean
  /** Called on [PLAN_DONE]; acceptedCount lets the wiring drop empty plans. */
  finish: (groupId: string, acceptedCount: number) => void
}

interface ParseResult {
  task: ParsedPlanTask | null
}

const parseTaskLine = (payload: string): ParseResult => {
  const parts = payload.split('::').map((part) => part.trim())
  if (!parts[0]) return { task: null }
  const title = parts[0].slice(0, 200)
  if (!title) return { task: null }
  const description = (parts[1] ?? '').slice(0, 4000)
  const deps = (parts[2] ?? '')
    .split(',')
    .map((n) => Number.parseInt(n.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1)
  const skills = (parts[3] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8)
  const rawRole = (parts[4] ?? 'custom').trim().toLowerCase()
  const role: WorkerRole = ROLES_ALIASES[rawRole] ?? 'custom'
  return {
    task: {
      title,
      description,
      dependencyOrdinals: [...new Set(deps)],
      requiredSkills: skills,
      role,
    },
  }
}

export const createPlanDraftCapture = (deps: PlanDraftCaptureDeps): PlanDraftCapture => {
  let buffer = ''
  let activeGroup: string | null = null
  let accepted = 0

  const reset = () => {
    buffer = ''
    activeGroup = null
    accepted = 0
  }

  return {
    push(chunk: string) {
      // Normalize CRLF first: \r\n is a line break, a bare \r is a repaint
      // rewind — same CR discipline as the [TG_REPLY] bridge.
      buffer += chunk.replace(/\r\n/g, '\n')
      if (buffer.length > 128_000) buffer = buffer.slice(-64_000)
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const line = cleanLine(rawLine)

        const beginMatch = /^\[PLAN_BEGIN\]\s*([A-Za-z0-9-]{8,64})$/i.exec(line)
        if (beginMatch) {
          const groupId = beginMatch[1] ?? ''
          activeGroup = deps.isPending(groupId) ? groupId : null
          accepted = 0
          newlineIndex = buffer.indexOf('\n')
          continue
        }

        const doneMatch = /^\[PLAN_DONE\]\s*([A-Za-z0-9-]{8,64})$/i.exec(line)
        if (doneMatch) {
          const groupId = doneMatch[1] ?? ''
          if (activeGroup !== null && deps.isPending(groupId)) {
            deps.finish(groupId, accepted)
          }
          reset()
          newlineIndex = buffer.indexOf('\n')
          continue
        }

        const taskMatch = /^\[PLAN_TASK\]\s*(.+)$/i.exec(line)
        if (taskMatch && activeGroup !== null && accepted < MAX_TASKS) {
          const { task } = parseTaskLine(taskMatch[1] ?? '')
          if (task) {
            // Ordinals reference THIS list and must point backward.
            task.dependencyOrdinals = task.dependencyOrdinals.filter(
              (d) => d >= 1 && d < accepted + 1
            )
            if (deps.createTask(activeGroup, task)) accepted += 1
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
      // The unterminated tail is a partial line: a trailing bare \r means
      // the TUI is repainting it, so everything before the rewind is stale.
      const lastCr = buffer.lastIndexOf('\r')
      if (lastCr !== -1) buffer = buffer.slice(lastCr + 1)
    },
  }
}
