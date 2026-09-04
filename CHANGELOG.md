# Changelog

Notable user-facing changes. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.5.0] — 2026-09-01

First public release of Gachi CLI Swarm — a local-first orchestrator that runs
autonomous swarms of CLI coding agents (Claude Code, Codex, OpenCode, AGY,
Qwen, or any custom command) as a visible team in your browser.

### Highlights

- **Kanban orchestration** — create tasks on a board, the dispatcher assigns
  them to workers in priority order, work flows through
  `backlog → ready → assigned → running → review → done`.
- **Multi-engine workers** — one swarm can mix engines; per-worker launch
  presets, models, and specialization notes.
- **Review pipeline** — a task cannot reach `done` without review; a free
  reviewer-role worker approves or requests changes.
- **Local-first & private** — SQLite state, sessions, and worktrees stay on
  your machine; your code never leaves it.

### Reliability

- **Error budget circuit breaker** — 5 consecutive failed runs pause dispatch
  for the workspace, with an escalating cooldown (5 min doubling, 60 min cap)
  that auto-resumes.
- **Recovery watchdog** — a worker with a stale heartbeat and an owned task is
  restarted with a handoff snapshot and session resume.
- **Sticky task affinity** — released tasks keep their worker binding through
  crashes and restarts.
- **Session resume** — crashed workers continue their previous engine session
  (capture timeout, delivery monitor, legacy JSONL fallback).
- **Memory watchdog** — global dispatch pause on low free memory, per-worker
  RSS telemetry, and opt-in rotation of ballooned idle workers.
- **Stall detection** — workers stuck on rate limits, quotas, or permission
  dialogs are detected from live PTY output and escalated to the orchestrator.
- **Failure policies** — classified failures (rate limit, quota, auth, network,
  OOM) back off on a per-category ladder instead of retrying blindly.
- **Crash auto-restart** — opt-in supervisor relaunch with a 1m/5m/15m backoff
  ladder.
- **Process hygiene** — reliable process-tree termination and orphan reaping on
  Windows and POSIX.

### Control & automation

- **Agent control plane** — start/stop/restart workers, switch models, set
  reasoning level, run context actions, send follow-up prompts to a live run.
- **Auto-compact** — percent- and token-budget triggers compact an engine's
  context before it drowns.
- **Telegram interface** — pairing, roles, `/status /tasks /workers /create
  /stop /approve /deny`, natural-language task creation, honest delivery with
  offline queueing.
- **GitHub PR autopilot** — watches open PRs and turns new heads into review
  cards; auto-PR creation after clean merges; deploy hooks (fire-and-forget).
- **LLM planner** — draft a whole plan from one goal, approve or discard it as
  a group.
- **Schedules** — cron-like workspace schedules create ready cards on a tick.
- **Docker sandbox** — opt-in per-workspace container wrapping for worker CLIs
  with a strict env allowlist.

### Platform

- **Windows, macOS, and Linux** — platform-aware process management, secrets
  (DPAPI / Keychain / libsecret), folder pickers, and shell handling.
- **Swarm metrics** — durable token totals, task success rate, and average
  task duration per workspace, persisted across restarts.
- **Browser UI** — React + Vite PWA with terminal panes, kanban board,
  worker dashboards, and push updates; i18n for 13 languages.
- **CLI** — `gachi` runtime with `doctor` environment checks and a full
  `team` command surface (workers, tasks, send, report, PR, engine, notes).

[1.5.0]: https://github.com/sergio1811x/Gachi-CLI-Swarm/releases/tag/v1.5.0