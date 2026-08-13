# u8cli — Implementation Plan

Derived from [SPEC.md](./SPEC.md). Phases are dependency-ordered; each ends in a verifiable state (tests pass, a demo-able capability exists). Within a phase, tasks are sequential unless noted.

Progress convention: mark tasks `[x]` as they land; one commit per task or coherent task group.

---

## Phase 0 — Scaffolding

- [ ] 0.1 `package.json` (name `u8cli`, `"type": "module"`, bin `u8`, exports map incl. `./plugin`), `tsconfig.json` (NodeNext, strict), vitest config, `.gitignore`.
- [ ] 0.2 Dependencies: `commander`, `zod`, `ink`, `react`, `jsonc-parser`, `jiti`; dev: `typescript`, `vitest`, `tsx`, `@types/node`, `ink-testing-library`.
- [ ] 0.3 `src/cli/main.ts` stub wired to bin — `u8 --version` works via `tsx` and via built output (`tsc`).

**Done when**: `pnpm build && node dist/cli/main.js --version` prints the version; `pnpm test` runs (0 tests).

## Phase 1 — Config layer (`src/config/`)

- [ ] 1.1 zod schema for the full config surface (§2, §10): apps/subapps, profiles, commands (+`kind`, shared script, `targets` map with `null` = skip), workspace `indicators`, `templates`, `plugins`, hook strings, limits (log caps, stop timeout).
- [ ] 1.2 JSONC loading (`jsonc-parser`) + upward discovery of `u8.jsonc` from cwd; friendly validation errors (path + message).
- [ ] 1.3 Normalization pass → internal model: implicit subapp for subapp-less apps; `~` and relative path resolution; target-ID canonicalization (`app`, `app.subapp`); reserved-namespace rejection for user command names; `dependsOn` cycle detection; profile default uniqueness.
- [ ] 1.4 Target resolution helpers: profile → subapp list; target string → subapps; command → per-target script resolution (shared/override/null-skip/absent-skip).
- [ ] 1.5 Workspace identity (real-path hash) + state-dir paths module (`~/.u8/<hash>/…`).
- [ ] 1.6 `u8 init` — write commented skeleton `u8.jsonc` (refuse to overwrite).
- [ ] 1.7 Generate `schema.json` from the zod schema at build time (zod v4 native JSON-schema conversion).

**Done when**: unit tests cover normalization, resolution, cycle/reserved-name/default-profile validation errors; `u8 init` produces a config that loads cleanly.

## Phase 2 — Template engine (`src/template/`)

Independent of everything else; pure functions.

- [ ] 2.1 Token parser: `{ns@name(:modifier(args))*}` grammar; parse errors → load-time warnings; unknown-token render as `{ns@name!}` red.
- [ ] 2.2 Modifiers: `pad(n)`, `max(n)`, `color(name)`, `dim`, `bold`; semantic default rendering hook (e.g. status → colored ●), modifiers override.
- [ ] 2.3 Renderer: `(template, valueLookup) → styled string` (ANSI), plus a plain-text mode for `--json`/tests.

**Done when**: unit tests cover grammar, each modifier, truncation+padding interaction, unknown tokens, ANSI vs plain output.

## Phase 3 — IPC (`src/ipc/`)

- [ ] 3.1 Unix-socket server: newline-delimited JSON-RPC 2.0 (request/response) + server-push notifications; socket file mode 0600; multi-client.
- [ ] 3.2 Client: connect, request/response correlation, typed notification subscription, reconnect-on-daemon-respawn.
- [ ] 3.3 Shared typed protocol definitions (`src/ipc/protocol.ts`): all methods + notification payloads used by later phases (status, start/stop, run, logs, indicator deltas, task progress, config events). Stub server handlers.

**Done when**: integration test — client + server over a real socket exchange requests and push streams; two clients receive the same notification.

## Phase 4 — Process layer (`src/process/`)

- [ ] 4.1 Spawn via `$SHELL -c` in target cwd, own process group; env merge (daemon env → workspace → app → subapp).
- [ ] 4.2 Stop: SIGTERM to group → SIGKILL after timeout (default 10 s, configurable); reliable exit detection with exit code/signal.
- [ ] 4.3 Log capture: stdout+stderr → per-target file; rotation at 10 MB keep 3; task-run logs (per run+target) pruned after 20 runs; tail/read API.

**Done when**: integration tests with fixture shell scripts — clean stop, kill-after-timeout, tree kill (child of child dies), rotation triggers, exit codes surface.

## Phase 5 — Daemon core (`src/daemon/`)

- [ ] 5.1 Daemon entrypoint: load config, state dir, IPC server, pid file; stdout/stderr → `daemon.log`.
- [ ] 5.2 Client-side auto-spawn: detect missing/stale socket (connect-fail → cleanup pid/socket → respawn detached); version handshake (mismatch → prompt restart if nothing running, warn otherwise).
- [ ] 5.3 Supervisor: service registry — states `stopped|starting|running|crashed|stopping|stale`; start/stop/restart per target; crash detection (default no respawn); `restart: "on-crash"` with capped backoff (1s→30s, give up after 10).
- [ ] 5.4 Idle self-exit (~10 min, no services + no clients); graceful shutdown stops services; `daemon status|stop|logs` RPC handlers.

**Done when**: integration tests — auto-spawn from cold, start/crash/restart-backoff of a fixture service, idle exit (shortened timer), stale-socket recovery, `u8 daemon stop` kills service tree.

## Phase 6 — Indicators (`src/indicators/`)

- [ ] 6.1 Provider registry: `scope: app|subapp`, update mode `event|poll|static`; per-target value cache; poll scheduler (per-provider interval, no overlapping runs).
- [ ] 6.2 Delta push over IPC (`indicator.changed` notifications); full snapshot on client attach; `status --json` reads the same cache.
- [ ] 6.3 Core `app@` providers: name, dirname, path (static), status, pid, uptime, exitcode (event-driven from supervisor).
- [ ] 6.4 Config-defined `x@` indicators: shell cmd per target in target cwd, trimmed stdout, poll interval; failures render empty + log warning.

**Done when**: integration test — client sees snapshot then live deltas as a fixture service starts/crashes; `x@` indicator polls and updates.

## Phase 7 — Engine (`src/engine/`)

- [ ] 7.1 Command model: built-ins `app:start|stop|restart` (service kind) + config commands; resolution via 1.4.
- [ ] 7.2 Task runner: parallel across targets with cap (default 4, per-command override, `--serial`); per-target run logs; aggregated pass/fail result; `task.progress` notifications.
- [ ] 7.3 Hook pipeline per (command, target): config shell hooks then plugin hooks; `pre` failure aborts that target only; `post` always runs with result `{ok, exitCode, durationMs}`.
- [ ] 7.4 `dependsOn` orchestration on profile start: DAG-ordered start; readiness = pluggable predicate (healthy if healthcheck registered, else running); 60 s default timeout → dependent not started, error status.

**Done when**: integration tests — mixed shared/override/skip command across targets; concurrency cap observed; pre-hook abort isolates one target; post runs on failure; dependsOn ordering + timeout behavior.

## Phase 8 — Plugin system (`src/plugins/`, `u8cli/plugin`)

- [ ] 8.1 SDK: `definePlugin`, typed contexts (`{workspace, command, target, phase, result?, logger, exec}`), exported via `u8cli/plugin` subpath.
- [ ] 8.2 Loader: npm names (workspace `node_modules` resolution) + relative paths (`.ts` via jiti); registration of indicators/commands/hooks into the registries; plugin name = reserved namespace.
- [ ] 8.3 Isolation-lite: load or runtime throw → plugin disabled + error surfaced (TUI banner / CLI warning), daemon survives.

**Done when**: integration test — a fixture local plugin adds an indicator, a command, and a `*` post-hook; a throwing plugin is disabled without daemon crash.

## Phase 9 — Built-in plugins

- [ ] 9.1 `git`: indicators branch/dirty/ahead/behind via `git status --porcelain=v2 --branch`; fs-watch on `.git/HEAD` + index with debounce + 30 s fallback poll; non-git dirs → empty values.
- [ ] 9.2 `git` commands: `git:fetch`, `git:pull` — task kind, deduped once per app across the profile.
- [ ] 9.3 `health`: http + cmd probes (interval 5 s, timeout 2 s, threshold 2), `health@status` (healthy|unhealthy|starting|n/a), probes only while running; registers the readiness predicate for 7.4.
- [ ] 9.4 Disable switches in config for built-ins.

**Done when**: integration tests — branch/dirty react to a fixture repo mutation; health flips on a fixture HTTP server going up/down; dependsOn actually gates on health.

## Phase 10 — Headless CLI (`src/cli/`)

- [ ] 10.1 `start|stop|restart [target|--all]`, `run <command> [target] [--serial] [--concurrency n]` (exit code reflects failures), `status [--json]`.
- [ ] 10.2 `logs <target> [-f] [-n N]`, `profile list|use`, `daemon status|stop|logs`.
- [ ] 10.3 Human output: status rendered through the template engine (same rows as TUI); task summary table.

**Done when**: end-to-end script against a fixture workspace exercises every subcommand; `status --json` is stable/typed.

## Phase 11 — TUI (`src/tui/`)

- [ ] 11.1 Ink app shell: connect/attach, header (workspace, profile, daemon state, config-error banner), main list from indicator snapshot + deltas (app header rows + subapp rows via templates, merged row for single-subapp apps).
- [ ] 11.2 Selection + lifecycle keys (`s/x/r` target, `S/X/R` profile) with task/inline progress display.
- [ ] 11.3 Log view: Enter → follow + scrollback (file backfill + live stream), Esc back.
- [ ] 11.4 Command palette (`:`/`p`): run any command on selection or profile; result summary. Profile switcher (`P`).

**Done when**: ink-testing-library tests for list rendering and key dispatch; manual demo — full loop (start stack, watch health go green, tail logs, run a task) against a demo workspace.

## Phase 12 — Config hot-reload

- [ ] 12.1 Daemon watches `u8.jsonc`; revalidate; hot-apply templates/indicators/commands/profiles/plugin list; invalid → keep last-good + error event to clients.
- [ ] 12.2 Stale detection: running services whose effective (script/env/cwd) definition changed → status `stale`; cleared on restart.

**Done when**: integration tests — template edit reflects without restart; broken edit keeps stack alive + surfaces error; script edit marks target stale, restart clears it.

## Phase 13 — Release polish

- [ ] 13.1 Demo workspace under `examples/` (3 fixture services incl. one monorepo, healthchecks, dependsOn) used by docs and manual QA.
- [ ] 13.2 README: install, quickstart, config reference (generated from schema), plugin authoring guide.
- [ ] 13.3 Package hygiene: `files` whitelist, `schema.json` shipped, `engines.node >= 22`, smoke-test `npm pack` install in a temp dir.

---

## Standing risks / watch items

- **Ink under long sessions**: memory/render perf with fast log streams — throttle log-view rendering (batch per frame), keep scrollback windowed.
- **fs-watch portability** (git plugin, config watch): debounce + fallback polling everywhere; never rely on watch alone.
- **Shell quoting**: scripts run through `$SHELL -c` verbatim — document that config authors own quoting; never interpolate into scripts.
- **jiti + TS plugins**: pin the loading path with a test fixture early (8.2) so Node-version drift is caught by CI, not users.
