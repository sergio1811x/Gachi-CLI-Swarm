# Contributing to Gachi CLI Swarm

Gachi CLI Swarm is maintained by its owner. Coordinate proposed changes with
the project owner before beginning work.

## Before you file something

- **Bug or feature request?** Send a concise reproduction, expected result,
  and affected files to the project owner.
- **Security issue?** Do not publish details. Contact the project owner
  privately with a minimal reproduction.

## Development setup

```bash
pnpm install
pnpm dev
```

Dev mode runs the runtime on `127.0.0.1:4010` and Vite on `127.0.0.1:5180`.
See the **Development** section of [README.md](./README.md) for a
production-style local run. Node.js 22 or newer is required.

## Before submitting a change

```bash
pnpm check    # Biome lint + format
pnpm build    # TypeScript build + Vite web build
pnpm test     # Vitest (unit + integration)
```

On Windows, real-ConPTY integration tests require an interactive console. Run their platform suite
from a normal terminal session; do not weaken runtime behavior to accommodate a non-interactive runner.

CI runs the same three checks on macOS, Ubuntu, and Windows for every push
to `main` and every PR.

## PR style

- Keep commits focused: one logical change per commit, imperative subjects
  (`fix worker card spacing on long names`), no trailing period.
- Squash review fixups before merge.
- PR body: 1–2 sentences on the why, plus testing notes if non-obvious.

## Test discipline

The full rules live in [AGENTS.md §3](./AGENTS.md). Two hard rules worth
calling out:

1. **Integration tests under `tests/server/*` and `tests/cli/*` may not mock
   `node-pty`.** Use the real PTY through `tests/helpers/`. Pure logic tests
   go under `tests/unit/`.
2. **Every assertion must fail if the production code is implemented
   backwards.** Patterns like `expect(x).not.toThrow()` chains,
   tautological array checks, and assertions on self-fed mocks count as
   fake tests and will be removed during review.
3. **Task/engine behavior needs lifecycle coverage.** A task cannot bypass
   `review` on the path from `running` to `done`; engine switching must prove
   the old PTY exits before the replacement starts and receives handoff context.

## Code style

- TypeScript everywhere. Avoid `any` unless documented.
- Let `pnpm check` (Biome) decide formatting; do not hand-format.
- Prefer editing existing files over creating new ones.
- Add a comment only when the *why* is non-obvious. Don't restate what the
  code already says.

## License

By contributing, you agree that your contributions are licensed under
the Apache License 2.0; see [LICENSE](./LICENSE).
