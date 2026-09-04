# Golden fixtures: engine PTY output (ROADMAP R11)

These files hold real-shaped terminal output samples per supported engine,
ANSI escapes included. They pin the scrape contracts in `agent-telemetry.ts`:
when an engine update changes its status line format, the fixture test fails
here first — before the swarm silently loses telemetry.

Format: raw text as delivered through the PTY bus, chunked arbitrarily.
Each file ends with a line matching that engine's context/tokens footer.
