# Gachi CLI Swarm

**Enterprise-grade local AI orchestration platform** - run autonomous swarms of AI agents that execute your entire development pipeline with production-grade reliability.

<div align="center">

**🚀 What makes it different:**

- **Local-first & private** - Your data never leaves your machine
- **Production-grade reliability** - Error budgets, circuit breakers, auto-recovery
- **Multi-engine support** - Claude, OpenAI, Gemini, custom CLI agents
- **Real orchestration** - Kanban task board, worker lifecycle, session resume

[![GitHub stars](https://img.shields.io/github/stars/sergio1811x/Gachi-CLI-Swarm?style=social)](https://github.com/sergio1811x/Gachi-CLI-Swarm)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()

</div>

<div align="center">

![Gachi CLI Swarm overview](web/public/screenshots/wide-overview.webp)

</div>

---

## 🎯 Why Gachi?

**Unlike simple AI assistants, Gachi is a distributed orchestration platform:**

- **Kanban task board** with drag-and-drop workflow management
- **Sticky task affinity** - workers remember their assigned tasks through crashes
- **Circuit breakers** - automatic dispatch pause when failures repeat
- **Session resume** - workers recover from crashes with full context
- **Docker sandboxing** - isolate risky operations in containers
- **Telegram integration** - control your swarm from anywhere
- **180+ marketplace agents** - specialized workflows ready to deploy

**Perfect for:**
- 🏢 **Enterprise teams** needing privacy and control
- 🛠️ **Startups** building AI-powered products
- 👨‍💻 **Individual developers** automating complex workflows

---

## ⚡ Quick Start (5 minutes)

### Prerequisites

- Node.js 22+ (`node --version` to check)
- pnpm (`npm install -g pnpm`)
- API keys for AI engines you want to use

### Install & Run

```bash
# Clone the repository
git clone https://github.com/sergio1811x/Gachi-CLI-Swarm.git
cd gachi-CLI-Swarm

# Install dependencies
pnpm install

# Check your environment (engines, auth, database, Docker)
pnpm build && pnpm doctor

# Start the runtime + web UI
pnpm dev:all

# Or use the one-command launcher
#   Windows:         gachi-start.cmd
#   macOS / Linux:   ./gachi-start.sh
```

### Create Your First Agent

1. **Open the UI** → http://localhost:4010
2. **Create a workspace** → Point to any folder on your machine
3. **Add a worker** → Configure your AI engine (Claude, OpenAI, etc.)
4. **Send your first task** → create a card on the Kanban board (or send a message via the Telegram relay):

```text
Read package.json and suggest improvements
```

The dispatcher assigns the card to a free worker and the worker starts on it.

That's it! Your agent will:
- Analyze the task
- Execute terminal commands
- Read/write files
- Report back with results

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser UI (React)                      │
│              Task board / Workers / Terminal                │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP/WebSocket
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                 Orchestrator (Node.js)                      │
│  - Runtime supervisor with error-budget circuit breaker    │
│  - Kanban dispatcher with sticky task affinity             │
│  - Recovery watchdog with session resume                   │
│  - Telegram relay for remote control                       │
└────────┬────────────────────────────────────┬───────────────┘
         │                                     │
    ┌────▼────┐                          ┌────▼────┐
    │ SQLite  │                          │ Workers  │
    │ State   │                          │          │
    └─────────┘                          └────┬─────┘
                                              │
         ┌────────────────────────────────────┼──────────────────────────┐
         │                                      │                          │
    ┌────▼─────┐                        ┌─────▼──────┐          ┌──────▼─────┐
    │ Worker A │                        │  Worker B  │          │  Worker C  │
    │ (Claude) │                        │  (OpenAI)  │          │  (Custom)  │
    └─────┬────┘                        └─────┬──────┘          └──────┬─────┘
          │                                    │                          │
          └────────────────────────────────────┼──────────────────────────┘
                                               │
                                    ┌──────────▼──────────┐
                                    │  Workspaces/.gachi  │
                                    │  - SQLite DB        │
                                    │  - Session logs     │
                                    │  - Agent configs    │
                                    │  - Task journal     │
                                    └─────────────────────┘
```

### Key Design Decisions

**Why local-first?**
- **Privacy**: Code and data never leave your machine
- **Cost**: No API markup, pay engines directly
- **Reliability**: Works offline, no cloud dependencies

**Why Kanban board?**
- **Visibility**: See all tasks, workers, and status at a glance
- **Control**: Drag tasks between columns, reassign workers
- **Transparency**: Full audit trail of task lifecycle

**Why circuit breakers?**
- **Stability**: Prevent cascading failures when workers crash
- **Recovery**: Auto-pause dispatch, resume when healthy
- **Cost control**: Stop runaway API calls during errors

---

## 📚 Use Cases Gallery

### 1. **Automated Code Review**

```bash
# Create a reviewer worker (UI: Workers → Add worker, preset "code-reviewer").
# From an agent session with the injected environment you can also use:
#   team worker add reviewer --preset code-reviewer

# Review is automatic: finished tasks move to review and a free reviewer-role
# worker approves (APPROVE → done) or rejects (REQUEST_CHANGES → back to ready).
```

**What happens:**
- Worker analyzes pull requests
- Generates detailed feedback
- Approves or requests changes
- Updates Kanban board automatically

### 2. **Deployment Pipeline**

```bash
# Create a deployment task card on the Kanban board (or via Telegram):
# "Deploy latest build to production"
```

**What happens:**
- Worker runs tests
- Builds project
- Executes deployment script
- Reports success/failure with logs

### 3. **Bug Investigation**

```bash
# Task with context — create a card on the Kanban board:
# "Investigate why auth fails for user@example.com"
```

**What happens:**
- Worker reads auth logs
- Checks database records
- Reproduces the issue
- Proposes fix with explanation

### 4. **Telegram Control**

```bash
# Link Telegram chat to workspace
# (From UI: Settings → Telegram → Link chat)

# Send tasks from Telegram
"Check build status and report"
```

**What happens:**
- Orchestrator receives message
- Assigns to worker
- Worker executes and replies
- Response sent back to Telegram

---

## 🔧 Advanced Features

### Docker Sandboxing (Workspace-level)

```bash
# Enable sandbox mode for a workspace by setting its app-state key:
#   worker_sandbox_<workspace-id> = docker
# (optionally pin the image with worker_sandbox_image_<workspace-id>;
#  writable via the app-state settings API or the workspace settings UI)
```

**What it does:**
- Wraps worker CLI launches in `docker run`
- Mounts workspace at `/workspace`
- Strict environment allowlist
- Credentials stay outside containers

### Session Resume & Recovery

Workers crash? No problem:
- **Automatic recovery watchdog** restarts stuck workers
- **Session resume** restores full context after crashes
- **Handoff prompts** preserve state during engine switches
- **Task journaling** captures every decision

### Error Budget Circuit Breaker

When failures repeat:
1. **5 consecutive failures** → dispatch paused
2. **Cooldown starts** (5 min, doubles each breach, 60 min cap)
3. **Auto-resume** when cooldown expires
4. **Manual resume** via `team resume "<reason>"`

When the breaker trips, the UI shows a paused banner with a resume button.

```bash
# Resume manually from an agent session (the `team` CLI and its environment
# are injected into every worker/orchestrator session; orchestrator-only):
team resume "Fixed the issue"
```

### Memory Watchdog

Prevents system overload:
- **Global pause** when free RAM drops below threshold (default 8%)
- **Worker rotation** when RSS exceeds limit (opt-in per workspace)
- **Auto-recovery** when memory frees up
### Swarm Economics

Every workspace exposes durable usage aggregates — token totals, per-agent peaks,
task success rate and average task duration — persisted in SQLite so they survive
restarts:

```bash
# Requires the UI session token (the browser sends it as a cookie):
curl -b "gachi_ui_token=<token>" "http://localhost:4010/api/workspaces/<id>/metrics?window_hours=24"
```

```json
{
  "window_hours": 24,
  "tasks": { "done": 12, "failed": 1, "success_rate": 92, "avg_task_duration_ms": 483000 },
  "tokens_total": 1834000,
  "agents": [ ... ],
  "samples": [ ... ]
}
```

The same numbers power the **Swarm Dashboard** in the browser UI — you always know
what your swarm costs and how reliable it is.

---

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Run in development mode (runtime + web UI)
pnpm dev:all

# Run tests
pnpm test

# Build for production
pnpm build

# Check code quality
pnpm check
```

### Project Structure

```
gachi-cli-swarm/
├── src/
│   ├── cli/               # Command-line interface (`gachi`, `doctor`)
│   ├── server/            # Orchestrator runtime (flat, focused modules)
│   │   │                  #   dispatch, recovery, telemetry, telegram relay,
│   │   │                  #   HTTP routes, SQLite stores, PTY management
│   │   └── agent-discovery/
│   └── shared/            # Shared wire types (snake_case protocol)
├── web/src/               # Browser UI (React, Vite)
└── tests/
    ├── unit/              # Pure logic tests
    ├── server/            # Integration tests (HTTP/SQLite boundaries)
    ├── web/               # UI component tests
    └── integration/       # End-to-end runtime tests
```

---

## 📖 Documentation

- **[Overview](./OVERVIEW.md)** — what Gachi is and how the pieces fit together
- **[Security model](./SECURITY.md)** — trust model, protections, and limits
- **[Changelog](./CHANGELOG.md)** — release history
- **[Contributing](./CONTRIBUTING.md)** — guidelines for contributors
- **[Agent behavior rules](./AGENTS.md)** — conventions the codebase follows

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

Areas where we especially need help:
- **Documentation** - tutorials, examples, guides
- **Integrations** - new AI engines, tools
- **Testing** - edge cases, platform-specific bugs
- **UI improvements** - UX enhancements

---

## 📄 License

Apache-2.0 — see [LICENSE](./LICENSE).

Third-party marketplace prompt snapshots keep their upstream licenses (see [NOTICE](./NOTICE)).

---

## 🔗 Links

- **GitHub**: https://github.com/sergio1811x/Gachi-CLI-Swarm
- **Issues**: https://github.com/sergio1811x/Gachi-CLI-Swarm/issues
- **Discussions**: https://github.com/sergio1811x/Gachi-CLI-Swarm/discussions

---

<div align="center">

**⭐ Star us on GitHub** — it helps more people discover Gachi!

**Built with ❤️ for teams who want reliable, private AI orchestration**

</div>