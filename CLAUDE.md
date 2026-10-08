# u8cli — agent guide

Node ≥ 22 (developed on 24), ESM + TypeScript strict, `moduleResolution: NodeNext`; Ink 6 + React 19 TUI; zod 4 config validation; commander 14 CLI; vitest 3. A per-workspace daemon supervises long-running microservice processes and clients talk to it over a unix socket.

## Commands

- Install: `pnpm install`
- Test: `pnpm test` — single file: `npx vitest run test/engine/hooks.test.ts`
- Typecheck: `pnpm typecheck` (must be clean repo-wide) · Build: `pnpm build`
- Run from source: `pnpm u8 -- status` · Run built: `node dist/cli/main.js status`
- (Full list: see `package.json` scripts — do not duplicate here.)

No linter or formatter is configured. Match the surrounding file.

## Project structure

Layers depend downward only; a lower layer never imports a higher one.

- `src/config` — discovery, JSONC + zod validation, normalization, pure resolvers
- `src/template` — row-template grammar, modifiers, ANSI-aware width
- `src/ipc` — NDJSON JSON-RPC over a unix socket (transport only, no business logic)
- `src/process` — detached-group spawn, one-shot exec, rotating log files
- `src/daemon` — supervisor, daemon wiring, RPC handlers, entry point, client launcher, config watcher
- `src/indicators` — provider registry, value cache, core `app@` providers
- `src/engine` — command runs, hook pipeline, `dependsOn` orchestration
- `src/plugins` — host/loader plus the `git` and `health` built-ins under `src/plugins/builtin`
- `src/cli`, `src/tui` — the two front ends; both render rows through `src/template`
- `examples/demo` — a real 3-repo workspace used for end-to-end checks

## Frozen contracts

These files are the seams every layer codes against. Changing one ripples across
areas, so treat an edit as a design decision, not a refactor: check every
consumer and update the tests that pin the behaviour.

- `src/config/types.ts` — the normalized workspace model
- `src/ipc/protocol.ts` — the wire contract (`RpcMethods`, `RpcNotifications`)
- `src/process/types.ts` — `ProcessHandle`, `ExecResult`
- `src/plugin/types.ts` — the public plugin API (re-exported from `src/plugin/index.ts`)
- `src/daemon/contracts.ts` — `Supervisor`, `IndicatorRegistry`, `Engine`, `PluginHost`

## Code style

- Relative imports carry an explicit extension — ✅ `import { exec } from "./exec.js"` 🚫 `from "./exec"`
- Type-only imports are marked (`verbatimModuleSyntax`) — ✅ `import type { Logger } from ...` 🚫 `import { Logger }`
- `noUncheckedIndexedAccess` is on: handle the `undefined` — ✅ `const first = xs[0]; if (!first) return;` 🚫 `xs[0]!`
- JSDoc explains *why*, not what — ✅ `/** Head-biased: the start of a failing command's output is what explains it. */` 🚫 `/** Returns the output. */`
- Errors carry a code from `U8Error` in `src/util/errors.ts` — ✅ `throw new U8Error("UNKNOWN_TARGET", ...)` 🚫 `throw new Error("bad target")`

## Testing

- Framework: vitest. Each area under `test/` mirrors its counterpart under `src/`, with files named `*.test.ts` (`.tsx` for Ink components) and shared setup in a sibling helpers module.
- Tests exercise real behaviour — real child processes, real sockets, real git repos, real HTTP servers in a tmpdir. Do not mock the code under test.
- Point `U8_STATE_HOME` at a tmpdir for anything that starts a daemon, and tear down every daemon and service in `afterEach`, including on failure.
- Socket paths are capped by the kernel (~104 bytes); keep test state dirs short or `connect()` fails with a bare `EINVAL`. See `statePaths` in `src/util/paths.ts`.
- A new regression test must be shown to fail against the unfixed code — otherwise it pins nothing.

## Git / PR workflow

- Branch off `main`; commit subject in the imperative mood, body explaining why.
- `pnpm typecheck` and `pnpm test` both pass before declaring work done.

## Boundaries

- ✅ **Always:** dispose what you create — every timer, watcher, subscription, child process and file handle needs an owner; `unref()` timers that must not hold the event loop open.
- ✅ **Always:** verify a supervisor change by asserting no orphaned processes survive (`pgrep -f`), not just that tests pass.
- ⚠️ **Ask first:** editing a frozen contract; adding a dependency; changing the on-disk log format or the state-dir layout; anything that changes `--json` output shape.
- 🚫 **Never:** commit secrets.
- 🚫 **Never:** resolve `app:stop` through `commandTargets` — a `null` there means "signal the process group", not "skip". Use `coreStopScript` in `src/config/resolve.ts`.
- 🚫 **Never:** inject `process.env` inside `src/process` — the daemon owns the env merge (workspace → repo → app) so what runs is what config says.
- 🚫 **Never:** let a plugin failure take down the daemon; a bad plugin is disabled and reported.
- 🚫 **Never:** reference line numbers in docs, or duplicate `package.json` / config bodies.

## Deep docs

- Design contract → `docs/SPEC.md`; phased build plan → `docs/PLAN.md`
- Config reference → `docs/CONFIG.md`; plugin authoring → `docs/PLUGINS.md`
- User-facing overview → `README.md`

---
Source of truth: `src/`, `docs/SPEC.md`, `package.json`. Update when: commands or stack change, a frozen contract gains or loses a seam, a layer is added or moved, or a new guardrail is agreed.
