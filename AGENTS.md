# AGENTS.md

## Repo Scope

This repository contains the Agent Control plugin for OpenClaw. It is a TypeScript ESM project that ships source files directly; there is no separate build step in normal development.

## Local Verification

Run the full local verification stack before finishing non-trivial changes:

```bash
npm run lint
npm run typecheck
npm test
```

When the change affects tests, coverage, or CI behavior, also run:

```bash
npm run coverage
```

Coverage output is written to `coverage/`, including `coverage/lcov.info` for Codecov-compatible uploads.

## Testing Conventions

- Prefer behavioral tests over implementation-detail tests.
- Write test names as concise behavioral summaries.
- Express Given/When/Then structure as code comments inside the test body.
- Use Vitest for unit and integration-style tests.
- Assert externally visible outcomes first: return values, registered hooks, emitted logs, blocked tool calls, resolved context, and client calls.
- Mock boundary dependencies such as `agent-control`, session/context helpers, and runtime-loading edges when needed, but keep the assertions focused on plugin behavior.
- When adding a new branch in plugin logic, add or update tests in the corresponding `test/*.test.ts` file.

Examples of the preferred naming style:

- `it("defaults to warn", () => { ... })`
- `it("blocks the tool call when fail-closed sync fails", async () => { ... })`

## Project Conventions

- Keep imports ESM-compatible and include the `.ts` suffix for local TypeScript imports, matching the current codebase style.
- This repo uses `oxlint` for linting and `tsc --noEmit` for semantic typechecking. `npm run lint` is not a substitute for `npm run typecheck`.
- Preserve the plugin's quiet default behavior. New logs should fit the existing `logLevel` model:
  - `warn`: warnings, errors, and block events
  - `info`: important lifecycle events
  - `debug`: verbose diagnostics

## When Changing Config or User-Facing Behavior

Keep these files aligned when config shape or documented behavior changes:

- `src/types.ts`
- `openclaw.plugin.json`
- `README.md`
- relevant tests under `test/`

If a change affects CI expectations or coverage behavior, also update:

- `.github/workflows/lint.yml`
- `package.json`
- `vitest.config.ts`

## CI Expectations

The main GitHub Actions workflow is `.github/workflows/lint.yml`. Changes to scripts or coverage generation should keep local commands and CI steps in sync.
