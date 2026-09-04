# AGENTS.md

Project rules for AI-assisted work in Gachi CLI Swarm.

This is a local-first open-source application maintained by Sergio1811x,
licensed under Apache-2.0. Treat the current code, README, and tests as the
source of truth. Do not add references to prior product names, external
repositories, package registries, or legacy licenses to public documentation.

## Hard Bans

### No test-only production fallbacks

Do not add production branches just to make a test easier to run. Mock or isolate
test dependencies in tests; keep production code on the real runtime path.

### No broad exception swallowing

Do not catch errors and match strings to hide root causes. Fix the cause or use
typed errors / explicit error codes.

### No fake tests

Avoid tests that only prove a mock was called, `expect(true).toBe(true)`,
source-string assertions, or `not.toThrow()` without checking behavior. A test
must fail when the production behavior is wrong.

### No weak generated IDs

Use `crypto.randomUUID()` for IDs. Do not use `Math.random().toString(36)`.

### No memory-before-database writes

When state is persisted, write to SQLite first and update in-memory state only
after persistence succeeds, or wrap the full change in a transaction.

## Required Practices

### Preserve public protocol contracts

HTTP and JSON payloads use snake_case at the boundary. TypeScript internals may
use camelCase, but serialization must keep the public shape stable.

### Preserve the agent state model

Agent summary status is `idle`, `working`, `waiting_decision`, or `stopped`. The
richer lifecycle (`agent-lifecycle.ts`) adds `created`, `starting`, `ready`,
`waiting`, `waiting_input`, `stuck`, `handoff`, `stopping`, `failed`; `stuck`
is set by the recovery watchdog, and the lifecycle store persists transitions.
PTY exit paths must update the agent summary to `stopped`; dispatch/report/cancel
paths must keep pending work and visible status consistent.

### Preserve autonomous worker execution

Non-orchestrator startup instructions require workers to implement, verify, and
fix work through completion. Do not weaken this into analysis-only responses or
confirmation requests except for destructive actions, missing requirements, or
security concerns.

### Use real integration coverage for runtime behavior

Changes involving HTTP routes, SQLite state, PTYs, terminal websockets, or the
`team` CLI need integration coverage that crosses the real boundary. Pure logic
can stay in `tests/unit`.

### Keep files focused

Avoid growing catch-all files. If a route, store, or component becomes hard to
scan, split it before adding unrelated behavior.

### Keep commits clean

Do not include AI-tool attribution in commits, PR bodies, or comments. Use a
normal human commit message that explains the change.

## Verification

Before submitting a non-trivial change, run:

```bash
pnpm check
pnpm build
pnpm test
```

If you skip a command, say exactly why.

## Current Architecture

- Runtime code: `src/server/`; browser UI: `web/src/`; shared wire types: `src/shared/`.
- Tasks use `backlog`, `ready`, `assigned`, `running`, `review`, `blocked`, `failed`, `done`, `canceled`.
  A task may not transition directly from `running` to `done`; it must enter `review` first.
  `kanban-dispatcher.ts` dispatches `ready` tasks in priority order.
- Sticky task affinity: releasing a task (crash, manual stop, supersede) keeps
  its worker binding; a bound `ready` card dispatches only to that worker and is
  unbound only by deleting the worker or manual reassignment (`task-store.ts`,
  `queue-engine.planNextDispatch`, `tests/server/task-affinity.test.ts`).
- Health: `agent-heartbeat-store.ts` persists `{status, phase, currentAction, lastSeen}` in SQLite
  (`agent_heartbeats`, introduced in schema v22; current v24 also has
  `telegram_links` + `approval_requests`). Do not use stdout sampling as health.
- Recovery: `recovery-watchdog.ts` restarts a worker whose heartbeat is stale while it owns an
  `assigned`/`running` task — `stuck` lifecycle, snapshot to `.gachi/agents/<id>/handoffs/`, restart
  with session resume, 5-minute cooldown.
- Review: `reviewer-pipeline.ts` routes `review` tasks to a free `reviewer`-role worker; the reviewer
  answers via `team report` with `APPROVE` (→ `done`) or `REQUEST_CHANGES` (→ `ready`).
- Live UI events: `tasks-websocket-server.ts` publishes `AGENT_STATUS_CHANGED`, `QUEUE_UPDATED`,
  `RUN_PROGRESS` with `entityVersion`/`updatedAt`; `useWorkspaceWorkers` consumes them.
- Workspace automation lives in `.gachi/`: tasks, memory, agent sessions, role profiles, worktrees and handoffs.
- Engine switching preserves task context through the session journal and handoff prompt; wait for the
  prior PTY to exit before starting the replacement engine.
- `requiredSkills` are a hard assignment constraint: every required skill must be present in the worker
  capability description/profile, not merely score positively.
- Use `tests/unit` for pure logic and `tests/server` for HTTP/SQLite boundaries.
- Real ConPTY tests require an interactive Windows console. Keep them platform-scoped; do not add production fallbacks for non-interactive test sessions.
- Auto-unblock: `prompt-autoresponder.ts` sends Enter to workers stuck on TUI permission dialogs (budget 5/min/runId). OpenCode workers get an allow-all `opencode.json` on first launch (`opencode-permissions.ts`). Do NOT add manual permission-answering flows — auto-unblock covers it.
- PR review autopilot (4.0 T2): per-workspace `pr_autopilot_<wsId>` (dry|live|off)
  watches open PRs on a 60s tick (`gh pr list` incl. `headRefOid`); new/moved
  heads become `ready` review cards (requiredSkills `code-review`). Dedupe by
  head sha + rounds guard (`pr_autopilot_seen_<wsId>`, limit `…limit_<wsId>`,
  default 3) via `pr-autopilot.ts`. `live` → worker runs `gh pr review`;
  `dry` → only `gh pr comment`. Anti-flood `[pr-autopilot:<ws8>#N]`.
- Schedules (4.0 T1): `agent-scheduler.ts` + app-state `schedule_<wsId>` create ready cards on a 30s tick (`runScheduleTick()` exposed for tests/admin). Anti-flood marker `[scheduled:<key>]` in the description blocks duplicates while a copy is open. Morning digest: `telegram_digest_at` fires `getDailyDigest()` at most once per calendar day via the TG poll loop.
- Agent packages (R6): `agent-package.ts` defines the portable `gachi-agent-package` v1 manifest (team roster + optional vendor-skill references). Import validates strictly and reports unknown skills as non-fatal `missing_skills`; it never auto-installs skills — that stays the per-workspace flow.
- Docker sandbox (R5→R10): workspace-level opt-in (`worker_sandbox_<id>=docker`) wraps worker CLI launches in `docker run` with the workspace mounted at /workspace and a strict env allowlist (`docker-sandbox.ts`). The orchestrator is never sandboxed; persisted launch config stays unwrapped so restarts re-wrap fresh. Do not add blanket env forwarding — credentials beyond the allowlist must not leak into containers.
- Telegram relay honesty (stability): `sendToOrchestrator` returns whether the orchestrator PTY actually accepted the payload; the service queues undelivered messages per workspace (cap 30) and re-injects them on every poll tick, confirming to the chat only after real delivery or recovery. Never claim "Forwarded" without a successful write.
- Stall scanner (R10): `agent-stall-scanner.ts` watches LIVE worker PTY tails on the autoresponder tick; explicit distress (rate-limit/quota/auth patterns from failure-classifier, or a surviving permission dialog) escalates once per 10 min per run+category — task journal `[STALL]`, lifecycle `waiting_input`, direct orchestrator-PTY notice. Do not downgrade these notices to logs-only; the whole point is that the orchestrator acts.
- Permission modes (R10): per-workspace `allow-all` (default) vs `ask` via app-state `worker_permissions_<wsId>`. In `ask`, the autoresponder skips that workspace's workers and no blanket opencode.json is written (`shouldGrantOpencodePermissions`). Respect the mode; never reintroduce silent grants.
- Error budget (R10) — timed circuit breaker (`error-budget-breaker.ts`): crossing 5 consecutive failed runs per workspace opens the breaker — `dispatch_paused_<wsId>` plus a cooldown deadline (`dispatch_pause_until_<wsId>`, 5 min doubling per consecutive trip, 60 min cap via `dispatch_pause_stage_<wsId>`). Dispatch resumes AUTOMATICALLY when the cooldown elapses (`isDispatchPaused` gate in `runtime-store-helpers.ts`); auto-resume halves the failure streak so repeated breaches re-trip on the ladder. A clean run (`onBreakerRecovered`) or manual resume (`PUT /dispatch-pause`) fully closes the breaker. Telegram + journal notices fire on trip and on auto-resume.
- Deploy hooks (R4): opt-in per-workspace command (app-state `deploy_hook_command_<wsId>`) executed after a clean worktree merge-back; result journals `[DEPLOY] ok|FAILED` into the originating task. Fire-and-forget — never block dispatch on it.
- Engine adapters (R11): the official engine support surface lives in `engine-adapters.ts` (claude/codex/opencode/gemini + login hints used by doctor). Telemetry scrape is CSI-tolerant and pinned by golden fixtures in `tests/fixtures/engine-output/`. Add new engines there, not as scattered regexes.
- Windows file semantics (R9): atomic writes that rename over an existing file must retry EPERM/EACCES/EBUSY briefly (see `tasks-file.ts renameWithWindowsRetry`). Non-ASCII agent ids are valid — `safeSegment` falls back to a deterministic sha1 slug; do not assume ASCII names anywhere.
- Task-store size caps: `MAX_DESCRIPTION_LEN`, `MAX_LOG_LEN`, etc. prevent the tasks JSON blob from exceeding SQLite's bind limit. Poke-merge uses tail-keep, not append-everything. Self-heal compacts oversized legacy blobs at load time.
- Worker management CLI: `team worker add|start|stop|pause|resume|compact|describe|restart-all-crashed|rm <name>` plus `team note`, `team resume` (orchestrator-only clear of a dispatch pause / error-budget breaker, mirrors the UI resume path), `team ps` (`active_only` filter on team list routes) and `team tasks-cleanup` (unbind/delete stale ready/assigned cards) — orchestrator-only via authz. `add --preset <id>` resolves the full launch config before creation (unknown preset → 400 listing known ids) and autostarts; without a preset, `team engine <name> <engine>` must run first — `worker start` without a launch config answers 400 with that hint, never the opaque launch-config 500. `worker describe <name> "<description>"` rewrites the worker's persistent specialization note used in every dispatch prompt (no restart). Compact supports opencode (`/compact`) alongside claude/codex (`/compact`) and agy/qwen (`/compress`). `worker stop <name> --cancel-task` cancels the in-flight card instead of requeueing it to ready — the unblock recipe for a silently hung worker is `stop --cancel-task` → `team send` (a plain stop lets the dispatcher re-assign the released bound card before the send lands, so the send 409s). Do not invent REST routes; use these.
- Context guard: the auto-compact percent threshold is per-workspace app-state `context_guard_threshold_percent` (default 85; `0` disables the percent trigger, token budget stays independent). 2-minute quiet window after a fresh run without arming the cooldown; 30-minute cooldown between firings; each firing journals `[CONTEXT] compact requested (N%)` into the worker's bound card.
- Crash auto-restart: opt-in per-workspace app-state `worker_autorestart_<wsId>` (default off). The supervisor relaunches a crashed worker on a 1m/5m/15m backoff ladder, max 3 attempts; a clean exit resets the streak and a manual stop cancels a pending restart.
- Memory watchdog (`memory-watchdog.ts`, 60s tick): when free RAM drops below app-state `memory_watchdog_free_percent` (default 8; `0` off), fresh dispatch is held globally via `dispatch_paused_memory` — running tasks are untouched, and the hold auto-clears with +5pt hysteresis plus a Telegram notice. This is separate from the error-budget breaker, which also auto-resumes (timed cooldown). The same tick samples live worker engine RSS (`rss_mb` on team list / worker cards, 3-min cache) and, per opt-in `worker_mem_rotation_<wsId>` (RSS MB threshold), session-resume restarts a ballooned idle worker (min uptime 10 min, 30-min cooldown). While the global hold is active, emergency rotation applies: an idle worker at or above `EMERGENCY_ROTATION_RSS_MB` (2048) is restarted even without the per-workspace opt-in — pausing dispatch alone frees no memory. Config: `PUT /api/workspaces/:id/memory-watchdog`.
- Session resume: capture timeout 600s + delivery monitor re-paste + legacy fallback (newest JSONL ≤7 days) — see S-1 in AUDIT_APPLICATION.md.
