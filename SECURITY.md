# Security Model

Gachi CLI Swarm is a **local-first** application. This page describes what that
means for security: what the built-in protections cover, and what they
deliberately do not.

## Trust model

The orchestrator daemon runs on your machine **with your user's full
privileges**. It can read and write everything your user can, and workers it
launches (Claude Code, Codex, OpenCode, Gemini CLI, ...) run as child processes
with the same privileges. Whoever can control the daemon can do anything you
can do on this machine.

This is the core trade-off of the local-first design: your code and data never
leave your machine, and in exchange the machine itself is the trust boundary.

## What the UI token protects

All mutating HTTP endpoints require a UI token (`gachi_ui_token`), delivered as
an `HttpOnly; SameSite=Strict` cookie and additionally checked against
`Origin`/`Host`. This protects the **network perimeter**:

- other devices on your LAN,
- cross-site requests from websites you visit (CSRF),
- access through a forwarded port.

## What the UI token does not protect

Processes on the **same machine**. `GET /api/ui/session` mints a token to any
local caller without authentication — that is how the browser bootstraps its
session, and any local process can do the same. Workers are local processes
with network access to the daemon, so a compromised or prompt-injected worker
can obtain a UI token and act as the orchestrator (read workspaces, write
app-state, start/stop agents).

If your threat model includes hostile task content, treat workers as
untrusted and apply the mitigations below.

## Mitigations

- **Keep the daemon on loopback.** The default binding is `127.0.0.1`. For
  remote access prefer a VPN or SSH tunnel over opening the port.
- **Docker sandbox** (opt-in per workspace): wraps worker CLI launches in
  `docker run` with a strict environment allowlist, so worker credentials
  beyond the allowlist never reach the containers. The orchestrator itself is
  never sandboxed.
- **Deploy hooks** (opt-in per workspace): a shell command executed after a
  clean merge-back. Whoever can write app-state (i.e. anyone with a UI token)
  can change it, so only configure commands you fully control, and treat the
  hook configuration as admin-only.
- **Telegram relay**: pairing a chat grants full control of the workspace via
  the bot; the pairing code is generated with a cryptographically secure RNG.
  Keep the bot token and the pairing code private.
- **Regenerate the UI token** (`POST /api/ui/session/regenerate`, requires the
  current token) if you suspect it leaked.

## Practical guidance

- Do not point workspaces at repositories you do not trust, and do not keep
  production secrets in worker environments for workspaces that execute
  untrusted task content.
- Review the task journal (`.gachi/`) if a worker behaved unexpectedly.
- The recovery watchdog, stall scanner, and error-budget breaker limit blast
  radius of runaway workers, but they are reliability features — not security
  boundaries.

## Reporting

Found a security issue? Do not publish details. Contact the project owner
privately with a minimal reproduction (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
