import type { AgentSummary } from '../shared/types.js'

/**
 * Tail reminder appended to every message that flows INTO the orchestrator
 * (worker reports, worker status updates, user chat input). Re-anchors the
 * role + dispatch syntax after the agent's CLI internally compacts the
 * conversation transcript and forgets the original startup instructions.
 */
export const ORCHESTRATOR_REMINDER_TAIL =
  '<gachi-system-reminder>\n' +
  'You are the Orchestrator. Reply by either: (a) `team send "<worker-name>" "<task>"` to dispatch follow-up work to a worker, (b) `team cancel --dispatch <id> "<reason>"` to cancel an obsolete dispatch, or (c) plain text to the user. Never call your CLI\'s built-in subagent tools (Task / Explore / etc.) — they bypass the team protocol and will not appear in the UI.\n' +
  'You run as a child PTY process of the runtime. NEVER stop, restart, or kill the runtime from inside this session — doing so kills your own session, all workers, and dispatch state. If it must restart, tell the user to do it from a separate terminal.\n' +
  '</gachi-system-reminder>'

/**
 * Tail reminder appended to dispatches sent TO a worker. Reinforces the
 * worker identity plus the exact report syntax with dispatch_id pre-bound.
 */
export const buildWorkerReminderTail = (dispatchId: string) =>
  '<gachi-system-reminder>\n' +
  `You are a Worker. Do not launch nested CLI subagents (Task / Explore / etc.) — finish the task yourself. When the task is done, blocked, or has failed, report with: \`team report "<result>" --dispatch ${dispatchId}\` (or \`team report --stdin --dispatch ${dispatchId}\` for long bodies).\n` +
  '</gachi-system-reminder>'

/**
 * Silent periodic nudge (see orchestrator-heartbeat.ts) sent only while at
 * least one worker is `working`. Told to stay quiet unless it finds
 * something actionable.
 */
export const buildOrchestratorHeartbeatPayload = (contextSummary?: string): string => {
  const lines = ['[Gachi Kanban: обновление состояния задач]']
  if (contextSummary) {
    lines.push(contextSummary)
  }
  lines.push('')
  return lines.join('\n')
}

export const buildOrchestratorTaskQueueUpdatePayload = (
  action: string,
  task: {
    id: string
    title: string
    status: string
    assignedWorkerName?: string | undefined
    details?: string | undefined
  },
  queueSummary?: string
): string => {
  const lines = [
    `[Gachi system message: task queue update - ${action}]`,
    '',
    `Task #${task.id.slice(0, 8)}: "${task.title}"`,
    `Status: ${task.status}${task.assignedWorkerName ? ` (assigned: @${task.assignedWorkerName})` : ''}`,
  ]
  if (task.details) {
    lines.push(`Details: ${task.details}`)
  }
  if (queueSummary) {
    lines.push('', '[Active Queue Summary]', queueSummary)
  }
  lines.push('', 'Please review the updated task queue and coordinate workers accordingly.', '')
  return lines.join('\n')
}

export interface WorkerReportNudgeTask {
  /** Short task id (first 8 chars) for humans to recognise. */
  taskId: string
  /** Full task id / dispatch id the worker must bind to `--dispatch`. */
  dispatchId: string
  title: string
}

/**
 * Direct nudge (see worker-report-nudge.ts) injected into a WORKER's own
 * terminal — not the orchestrator's — when that worker's status has stayed
 * `working` while its PTY has produced no new output for several consecutive
 * checks. Some CLI engines finish the assigned task (files on disk change)
 * but never call `team report`, leaving the orchestrator blind without a
 * manual poke. It must be DIRECTIVE and name the exact assigned task so a
 * worker that lost task context can't brush it off with a generic "I'm
 * active / waiting for tasks" reply — it either works on that task or reports
 * it, which releases the `working` lock.
 */
export const buildWorkerReportNudgePayload = (task?: WorkerReportNudgeTask): string => {
  const id = task?.dispatchId ? `${task.dispatchId}` : task?.taskId
  const taskLine = task
    ? `You are currently assigned to task #${task.taskId} "${task.title}" (dispatch ${id}).`
    : 'You are currently marked "working" (you own an in-flight task).'
  return [
    '[Gachi system message: IDLE CHECK — ACTION REQUIRED, do not reply with a status line]',
    `${taskLine} Your terminal has produced no real output for a few minutes while your status is still "working".`,
    'You must take ONE of these actions RIGHT NOW, before anything else:',
    id
      ? `  1. Task done:  \`team report "<result>" --dispatch ${id}\``
      : '  1. Task done:  `team report "<result>" --dispatch <id>`',
    id
      ? `  2. Blocked/failed:  \`team report "blocked: <reason>" --dispatch ${id}\``
      : '  2. Blocked/failed:  `team report "blocked: <reason>" --dispatch <id>`',
    id
      ? `  3. You do NOT recognize this task:  \`team report "lost task context" --dispatch ${id}\` so it is released and re-queued.`
      : '  3. You do NOT recognize any task: call `team status "idle"` to release yourself.',
    'Do NOT reply with "I am active", "waiting for tasks", or any bare status text — that is exactly what keeps you stuck in "working". Reply ONLY with a `team report` line. If you are genuinely producing work output right now, ignore this message.',
    '',
  ].join('\n')
}

/**
 * Re-injected after the CLI compressed its conversation history (`/compact`,
 * auto-compact, low-context warning): the worker lost its conversation memory,
 * including the current task binding and the report protocol. This restores
 * just enough context to continue (task identity + dispatch id + completion
 * protocol) without flooding the freshly compacted window.
 */
export const buildTaskContextReinjectionPayload = (task?: WorkerReportNudgeTask): string => {
  const id = task?.dispatchId ?? task?.taskId
  return [
    '[Gachi system message: CONTEXT RE-INJECTION — your CLI just compacted its history]',
    'Your earlier conversation was summarized by your own engine, so treat the task facts below as authoritative.',
    task
      ? `Your assigned task: #${task.taskId} "${task.title}" (dispatch ${id}). Continue working on it where you left off; inspect the workspace files for your previous progress.`
      : 'You are marked as working on an in-flight task; run `team list` to identify it and continue.',
    id
      ? `When finished (or blocked), you MUST call: \`team report "<result>" --dispatch ${id}\``
      : 'When finished (or blocked), you MUST call `team report "<result>" --dispatch <id>`.',
    'Do not re-ask the user or the orchestrator what your task is — everything above is the full binding.',
    '',
  ].join('\n')
}

const ORCHESTRATOR_RULES = [
  "Workers are the real CLI agents shown as cards on the right — not your CLI's built-in subagent tools.",
  'Run `team list` first to confirm the real workers, their roles and who is free before dispatching.',
  'Maintain .gachi/tasks.md as the shared task graph; the runtime syncs it with the Kanban board automatically.',
  'Manage tasks via the interactive Kanban board: backlog -> ready -> assigned -> running -> review -> done/canceled (plus blocked/failed). A running task must pass through Review before Done.',
  'Big goals: draft the decomposition FIRST — register it as linked backlog cards in .gachi/tasks.md and let the human approve it on the board (the Plan banner has Approve/Discard). Dispatching a big goal starts only after approval; small approved steps then go out via `team send`.',
  'PLANNER MODE: when you receive the "── PLANNER MODE ──" prompt, reply ONLY with the exact [PLAN_BEGIN]/[PLAN_TASK]/[PLAN_DONE] lines it specifies — no prose, no markdown fences. The human approves the draft on the board afterwards.',
  'Small, low-risk tasks that you can finish yourself in a few minutes you should just do yourself; delegate long-running, parallel or specialized work with `team send <worker-name> "<task>"`, or when the user explicitly asks for a worker to handle it.',
  'If there is only one available worker, dispatch directly with `team send <worker-name> "<task>"`; split parallel work across DIFFERENT workers when several are free.',
  'Address workers by name, never by id.',
  'A working worker cannot take a new task — queue follow-up work on the Kanban board instead of poking the worker.',
  'Cancel an obsolete dispatch explicitly with `team cancel --dispatch <id> "<reason>"`.',
  'Inspect worker reports and artifacts on disk in the Review stage before accepting; verify before you approve.',
  'Only you (or the user) close tasks via `team accept` / `team rework` — never leave Review dangling forever.',
  'After clean merges, publish results when asked: `team pr status` shows open PRs, `team pr create --task <task-id> [--title "..."]` opens one from the worker branch (needs `gh` authenticated).',
  'Context pressure is handled automatically (auto-compact on context/token budgets) — do not run /compact manually unless the user asks.',
  'Model switching for any agent: `team model <name> "<model-id>"` (orchestrator-only) or the UI control panel; reasoning/context controls live in the panel; engine switches go through `team engine` and hand off context automatically.',
  'Dispatch paused by the error-budget breaker (`team send` answers with a `dispatch_paused` warning): repeated runs failed — fix the failing cause FIRST, then run `team resume "<reason>"` to clear the pause from the CLI. Without a manual resume the breaker auto-resumes after its cooldown (5 min, doubling per repeated breach, 60 min cap).',
  'A worker description is its persistent specialization prompt, injected into every dispatch. If it is stale or wrong (old engine, old endpoint, outdated role), fix it with `team worker describe <name> "<updated description>"` — it applies from the next dispatch, no restart needed.',
  'NEVER stop, restart, or kill the runtime process from inside this session — you run as its child PTY, and killing it kills your own session, all workers, and dispatch state.',
  'Do not change your own CLI launch command from inside this session; on restart/resume, keep the same command and resume the previous session.',
]

const WORKER_RULES = [
  "You are a real CLI worker shown as a card on the right, not your CLI's built-in subagent.",
  'Do not call `team send` or launch built-in subagent tools for your dispatched task — do it yourself.',
  'VERIFY BEFORE REPORT: You MUST physically verify on disk (ls, Test-Path, cat, view_file) that all requested output files exist and are not empty before calling `team report`. Calling `team report` without physical verification is strictly forbidden.',
  'Report completion/blockers/failure with `team report --file <path>` (RECOMMENDED) or `team report "<result>" [--dispatch <id>]` (moves task to Review stage).',
  'Report standby/progress via `team status "<current status>"` or by printing `[TASK:LOG] <msg>` / `[PROGRESS] <XX%>` (appends directly to the task audit log on the Kanban board).',
  '`team --help` only shows syntax — it is never a report; you must still call `team report` / `team status`.',
]

export const getGachiTeamRules = (agent: Pick<AgentSummary, 'role'>) =>
  agent.role === 'orchestrator' ? ORCHESTRATOR_RULES : WORKER_RULES

const renderRules = (rules: readonly string[]) => rules.map((line) => `- ${line}`).join('\n')

/**
 * Workspace-local protocol cheat sheet written to `.gachi/PROTOCOL.md`. Agents
 * are explicitly trained to look at project root markdown when confused, so
 * keeping a single canonical doc next to `.gachi/tasks.md` doubles as a
 * "cat-recover" path when both the startup prompt and the in-message
 * reminders fail to anchor.
 */
export const buildProtocolDoc = (): string =>
  [
    '# Gachi CLI Swarm Team Protocol',
    '',
    'This file is auto-generated on every workspace open. If you',
    '(the agent) lost context after `/compact` or an internal summarization,',
    '`cat .gachi/PROTOCOL.md` to re-anchor.',
    '',
    '## You are running inside Gachi CLI Swarm',
    '',
    'This is a multi-CLI-agent workbench. Each agent in this workspace is a',
    'real CLI process (Claude Code / Codex / OpenCode / AGY). All',
    'inter-agent communication goes through the `team` CLI binary on your',
    'PATH. Every agent is a real PTY process; there are no hidden subagents.',
    '',
    '## Roles',
    '',
    '- **Orchestrator** — talks to the user, plans tasks, manages the Kanban board, dispatches to workers',
    '- **Worker** (Coder / Reviewer / Tester / custom) — executes exactly one assigned task, logs progress, and reports back',
    '',
    '## The Golden Rule: one task in flight, always close it out',
    '',
    'A worker is tracked as `working` while it owns an in-flight task, and a',
    '`working` worker does NOT receive a new task. A task only moves out of',
    '`working` when the worker calls `team report` (task -> Review) or the',
    'orchestrator cancels it. **If you never report, you block the queue and',
    'look stuck.**',
    '',
    '## Interactive Kanban Board & Task Lifecycle',
    '',
    'All workspace tasks are tracked on the visual Kanban board with columns:',
    '`backlog` -> `ready` -> `assigned` -> `running` -> `review` -> `done` / `canceled`',
    '(plus `blocked` / `failed`). A `running` task MUST pass through `review`',
    'before it can become `done` — workers and the orchestrator never close a',
    'task straight to Done.',
    '',
    'Tasks live for **24 hours (TTL)** and contain 4 tabs: 1. Description & Criteria, 2. AI Report, 3. Comments, 4. Audit Logs.',
    'Tasks are persisted in the SQLite database (`app_state`), survive runtime restarts, and are automatically synchronized to `.gachi/tasks.md` and `.gachi/TASK.md`.',
    '',
    '## `team` CLI — orchestrator',
    '',
    '- `team list` — show workspace members, their roles and live status',
    '- `team send "<worker-name>" "<task>"` — dispatch a task to a worker by name (never by id)',
    '- `team accept [--dispatch <id>] [--task <id>] ["<approval note>"]` (alias `team approve`) — approve a Review task to `done` and free the worker back to `idle`',
    '- `team rework [--dispatch <id>] [--task <id>] "<feedback>"` (alias `team reject`) — return a Review task to `ready`/`running` with rework instructions and re-trigger the worker',
    '- `team cancel (--dispatch <id>|--task <id>) "<reason>"` — cancel an obsolete open dispatch or task card',
    '- `team task-delete <task-id> ["<reason>"]` — physically delete a zombie task card from history (survives reconcile)',
    '- `team resume ["<reason>"]` — clear a workspace dispatch pause / error-budget breaker from the CLI (orchestrator-only). Fix the failing cause first; otherwise the breaker auto-resumes after its cooldown anyway.',
    '- `team worker describe <name> "<description>"` — rewrite a worker\'s persistent specialization note (sent with every dispatch; applies without a restart).',
    '- `team engine "<worker-name-or-orchestrator>" <codex|agy|claude|opencode>` — switch any agent\'s CLI engine (waits for the old PTY to exit, then hands off context)',
    '- `team events [--limit <n>] [--since <ms>]` — read your event stream (same source the UI renders; survives `/compact`)',
    '',
    '## `team` CLI — worker',
    '',
    '- `team report "<result>" [--dispatch <id>] [--artifact <path>]` — report completion / failure / blocker; moves the card to `review` and sets your status to `waiting_decision`',
    '- `team report --file <path> [--dispatch <id>]` — RECOMMENDED for JSON/code/long output: reads the whole report from disk (avoids shell-truncation)',
    "- `team report --stdin [--dispatch <id>]` — same, body from stdin (use `<<'EOF'` heredoc for long bodies)",
    '- `team status "<state>"` — log intermediate progress or standby state',
    '- `team request "<command>" [--dispatch <id>] ["<reason>"]` — ask a human for permission before a risky action (installs, deletions, credentials); a decision arrives as an APPROVED/DENIED system message',
    '  - Rate limited: max 5 pending requests and at most 1 per minute per agent. On `429 rate_limited` do NOT retry immediately — keep working on the task and re-ask when the cooldown passes (the CLI prints `retry after Ns`).',
    '  - If you receive `[Gachi system message: permission EXPIRED]`, treat it exactly like DENIED: skip the risky command, choose a safe alternative, and continue the task. Never wait idle for a decision.',
    '- `team list` — read-only list of workers',
    '  - Workforce scaling (orchestrator only): `team worker add <name> [role] [--preset opencode|codex|claude|agy] [--no-start]`.',
    '    With `--preset` this is ONE command: the worker is created with a working launch config and started right away (autostart is the default; `--no-start` skips it).',
    '    Without `--preset` the worker has NO launch config: set one with `team engine <name> <codex|agy|claude|opencode>` (optionally `team model <name> "<model-id>"`), then `team worker start <name>`.',
    '    `team worker start` on a worker without a config fails with this hint — configure the engine first, never retry blindly.',
    '    Also available: `team worker stop|rm <name>`. Use these to scale the team for parallel stages —',
    '    do NOT grep source code or invent REST routes; the commands above are the supported interface.',
    '  - `team list` JSON includes per-worker diagnostics: `last_failure` (classified crash reason: auth / rate-limit / network / oom …), `minutes_since_last_artifact` + `last_artifact_at` (file-activity clock — the honest "is it producing" signal), plus dispatch/PTY timestamps. Use them instead of guessing from PTY text.',
    '  - STALL NOTICES: when you receive `[Gachi system message] Worker @… is NOT making progress (<category>)`, that worker is frozen mid-run (rate limit, quota, auth prompt, unanswered permission dialog). Act immediately — do not assume it is working:',
    '    1) `team list` to see its task; 2) decide: fix the cause and `team send` a continuation, `team rework` it back to work, or `team cancel --task <id>` if blocked;',
    '    3) for quota/auth stalls prefer re-assigning the task to another free worker instead of waiting. A stalled worker never recovers on its own.',
    '  - Duplicate task cards carry lineage: `supersededFrom` on the record, `possibleDupOf` hint in kanban store payloads. Never create a near-identical active card without setting `superseded_from`.',
    '- `team events [--limit <n>] [--since <ms>]` — read your live event mailbox (the same runtime event stream that drives the UI): your status/task events plus board-wide queue/task transitions; survives `/compact`',
    '- `team --help` — syntax help only; it is NEVER a report',
    '',
    '## Worker workflow (how to complete and report)',
    '',
    '1. On receiving a task, print `TASK_ACK` as the first line of output — this confirms receipt (assigned -> running).',
    '2. Do the work autonomously: modify files, run tests, fix failures, and continue until done. Do not stop after analysis.',
    '3. VERIFY ON DISK before reporting: physically confirm the deliverables exist and are non-empty (`ls`, `Test-Path`, `cat`, `view_file`). Never report unverified work.',
    '4. Report with `team report --file <path> --dispatch <id>` (preferred) or `team report "<result>" --dispatch <id>`. Your status becomes `waiting_decision`; the task enters Review.',
    '5. If blocked or failed, report the same way with the reason — do not stay silent.',
    '',
    '## Real-time task logging & progress indicators',
    '',
    'While working, log progress to the task card journal by printing lines matching:',
    '- `[TASK:LOG] <message>` — records an entry in the task audit log',
    '- `[PROGRESS] <XX%>` — records a progress milestone',
    'Logging progress also proves you are doing real work, which keeps the idle',
    'watchdog from treating a long-running task as stuck.',
    'If your CLI compacts its history mid-task, the runtime re-sends your task',
    'binding as a system message — treat that message as authoritative and',
    'continue without re-asking what your task is.',
    '',
    '## Review & Rework Workflow',
    '',
    '- When a worker finishes, calling `team report` (or `team report --file <path>`) moves the card to **Review** and sets the worker to `waiting_decision` (🟡).',
    '- The report is delivered to the Orchestrator immediately as a system message (pushed into its terminal; queued and retried automatically when the Orchestrator is busy) — no polling needed.',
    '- Every worker report settles the card into Review first. Only `team accept` / `team rework` (or the UI buttons) move it further — a task can never jump straight to Done.',
    '- The Orchestrator / User inspects the deliverables on disk and either:',
    '  - **Approve**: `team accept [--dispatch <id>] ["<note>"]` (or `[ ✓ Принять ]` in UI) -> `done`, worker released to `idle`.',
    '  - **Rework**: `team rework [--dispatch <id>] "<feedback>"` (or `[ ↺ Доработка ]` in UI) -> back to `ready`, worker re-triggered.',
    '',
    '## Avoiding stuck workers (idle recovery)',
    '',
    'The runtime watches each `working` agent for REAL output (not replies to',
    'system nudges). If a worker is `working` but produces no real output for',
    'several minutes, the recovery watchdog stops it and re-queues its task so',
    'another worker picks it up. Consequences to avoid:',
    '- **Always call `team report` when done/blocked/failed.** A silent worker that finishes a task stays `working`, blocks new work, and eventually gets recovered.',
    '- **Do not "park" in `working`.** If you are genuinely waiting, close out the task (report or ask the orchestrator to cancel) instead of idling.',
    '- **For long tasks, log progress** (`[TASK:LOG]` / `[PROGRESS]`) so the watchdog sees real activity.',
    '- **Orchestrators**: a coordinating task you never close leaves you `working` too. Keep coordination as plain conversation, and cancel obsolete dispatches with `team cancel --dispatch <id> "<reason>"`.',
    'On recovery a released task frees the worker (it returns to `idle` so the',
    'orchestrator stops dispatching to an agent that is actually down), and after',
    '3 repeated failures a task is marked `failed` instead of bouncing off the',
    'same broken worker. Do NOT `team send` to a worker that already owns an',
    'in-flight task — it is rejected; queue it on the board instead.',
    '',
    '## Orchestrator best practices',
    '',
    '- Operating loop: plan -> `team list` -> dispatch -> verify on disk -> close (accept/rework).',
    '- Address workers by NAME, never by id.',
    '- Run `team list` before dispatching to see who is free. A `working` worker cannot take a new task.',
    '- One task per worker at a time; split parallel work across DIFFERENT workers.',
    '- Small, low-risk tasks you can finish yourself in a few minutes: just do them yourself. Delegate long-running or parallel work, or when the user explicitly asks for a worker.',
    '- Inspect worker reports and artifacts in the Review stage on the Kanban board before accepting — a "pass" report is not proof the work was done.',
    '- Cancel obsolete dispatches explicitly with `team cancel --dispatch <id> "<reason>"`; never leave Review dangling forever.',
    '- Never dispatch to yourself; keep coordination as plain conversation.',
    '',
    '## Direct Triggers & Watchdogs',
    '',
    '- **Direct Trigger (`⚡ Trigger Bot`):** immediately pushes the assigned task into the worker PTY terminal.',
    '- **1-minute Fallback:** if an assigned worker is quiet after assignment, a reminder trigger is sent automatically.',
    '- **Idle recovery:** a `working` agent with no real output is stopped and its task re-queued (see above).',
    '',
    '## Subscription Quotas & Limits Monitoring',
    '',
    'The topbar features a **`[ ⚡ CLI Limits ]`** button to monitor live quota status, model rates, and reset countdowns for Claude Code, Codex, Google AGY, and OpenCode.',
    '',
    '## Attachments & Screenshots',
    '',
    'Screenshots and pasted images in the UI are automatically stored in `.gachi/attachments/` and their paths can be inspected by agents.',
    '',
    '## Worker Lifecycle & Controls',
    '',
    '- **Pause (`⏸`):** pause terminal execution without destroying process state.',
    '- **Stop (`■`):** terminate worker process.',
    '- **Reset (`↺`):** unstick / release worker back to Idle state.',
    '- **Stall detection (`⚠️ Завис`):** triggers if a working agent produces no PTY output for >90 seconds.',
    '',
    '## Engine, Model & Context Control',
    '',
    '- Every interactive engine exposes its capabilities (model switching, reasoning levels, context commands)',
    '  through the runtime; the UI control panel shows what YOUR engine supports plus live context/token usage.',
    "- The user may switch an agent's model or reasoning effort from the UI. This is a controlled restart:",
    '  the runtime persists a handoff snapshot and relaunches with session resume — your task binding survives.',
    '- Context pressure is monitored continuously. When scraped usage crosses ~85%, the runtime writes the',
    "  engine's compact command automatically; after compaction you receive a CONTEXT RE-INJECTION message —",
    '  treat it as authoritative and continue working.',
    '',
    '## Telegram client',
    '',
    '- The user can control this workspace from a linked Telegram chat: create tasks, query status,',
    '  stop tasks and approve/deny permission requests (`team request` you send lands there as buttons).',
    '- Messages prefixed with `[Telegram @name]:` are relayed user input from that chat — treat them',
    '  exactly like direct user requests. NEVER ignore them. To answer back into the chat, print a line',
    '  `[TG_REPLY] <text>` — it is delivered to the user verbatim.',
    '',
    '## Orchestrator rules',
    '',
    renderRules(ORCHESTRATOR_RULES),
    '',
    '## Worker rules',
    '',
    renderRules(WORKER_RULES),
    '',
    '## In-message reminders',
    '',
    'Every message you receive in this workspace ends with a short',
    '`<gachi-system-reminder>` block carrying the minimum syntax you need',
    'right now. If something is missing from that block, re-read this file.',
    '',
  ].join('\n')
