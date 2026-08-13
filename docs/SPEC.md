# u8cli — Specification

**Status**: approved design, v1 scope
**Date**: 2026-08-14

u8cli (`u8`) is a workspace-scoped orchestrator for long-running microservice apps spread across the disk. It provides a live TUI dashboard of a profile's apps/subapps, daemon-managed processes that survive the terminal, a configurable command system with hooks, and a plugin system that contributes indicators, commands, and hook bindings.

---

## 1. Platform & stack

| Decision | Choice |
|---|---|
| Runtime | Node.js ≥ 22, ESM, TypeScript |
| Package | Single npm package `u8cli`, bin `u8`; plugin SDK exported as `u8cli/plugin` |
| TUI | Ink (React for terminals) |
| Headless CLI | commander |
| Config validation | zod (JSON schema published for editor `$schema` support) |
| Tests | vitest |
| Platforms | macOS + Linux only (Windows deferred; WSL works) |

Internal module layout (single package):

```
src/
  config/      # discovery, JSONC parsing, zod schema, normalization, watch/reload
  daemon/      # daemon entrypoint, lifecycle, supervisor
  ipc/         # unix socket server/client, JSON-RPC framing, push streams
  engine/      # command resolution, task runner, hooks, dependsOn ordering
  process/     # spawn, process-tree signals, log capture/rotation
  indicators/  # provider registry, value cache, poll/event scheduling
  plugins/     # loader (npm + local), built-ins: git, health
  template/    # token parser, modifiers, renderer
  tui/         # Ink app: list, log view, palette, profile switcher
  cli/         # headless subcommands
```

---

## 2. Concepts

### 2.1 Workspace

A directory containing `u8.jsonc`. Discovered by walking upward from cwd (git-style). `u8 init` scaffolds a commented skeleton config in cwd (no repo scanning in v1).

- Config format: **JSONC** (comments + trailing commas), validated by zod; a JSON schema is published so `"$schema"` gives editor completion.
- Workspace identity: hash of the config file's real (symlink-resolved) path.
- State dir: `~/.u8/<workspace-hash>/` — daemon socket, daemon log, pid file, process logs, local state (active profile).

### 2.2 App

A high-level repo, located anywhere on disk (`path` absolute or relative to the workspace). Apps are grouping + app-scoped indicator surface (e.g. git). Apps are **not** runnable.

### 2.3 Subapp — the runnable unit

The engine only knows subapps. Every process, log stream, status, health probe, and command target is a subapp.

- An app with no `subapps` is normalized at config-load into an app with one **implicit subapp** (same path, scripts taken from the app entry). Single code path downstream.
- Fields: `path` (cwd relative to the app's path), `scripts` (map of name → shell string), `env`, `dependsOn`, `health`, `restart`, `template` override.
- Scripts are **arbitrary shell strings**, executed via the user's `$SHELL` in the subapp's cwd. No package-manager assumptions.

Target addressing: `appName` (all its subapps, or its implicit one) or `appName.subappName`.

### 2.4 Profile

A named list of targets (apps and/or specific subapps). Pure selection — no overrides in v1.

- Exactly one profile may be marked `default: true`.
- Active profile is switched with `u8 profile use <name>` (or the TUI switcher) and persisted in the **state dir**, not the shared config.

### 2.5 Command

A named unit of work runnable against targets.

- `kind: "service" | "task"` (default `task`).
  - **service**: spawned process is registered with the supervisor — status, restart, log tracking. "Done" = running.
  - **task**: runs to completion; success = exit 0; output captured to a per-run log.
- Script resolution (many-to-one): optional shared `script` run in each target's cwd, plus a `targets` map of target → script overriding the shared one. A target matching neither is **skipped**.
- Built-in commands: `app:start`, `app:stop`, `app:restart` (service semantics). Their per-target script defaults from the subapp's `scripts.start`; overridable like any command.
- Task execution across targets: **parallel with a concurrency cap** (default 4; per-command `concurrency`; `--serial` flag). Per-target output capture; pass/fail summary table at the end; per-target progress in the TUI.

### 2.6 Hooks

Per `(command, target)` pair: `pre` → script → `post`.

- A failing `pre` **aborts that target only**; other targets proceed.
- `post` **always runs**, receiving the result (exit code / final status).
- Multiple bindings run in registration order: config-defined hooks first, then plugins in load order.
- In config, a hook is a shell string (run in the target's cwd; non-zero exit in `pre` = abort). In plugins, a hook is an async function (see §6); a thrown error in `pre` = abort.

### 2.7 Indicator

A named, per-target (or per-app) value rendered in templates as `{ns@name}`.

- Providers live **in the daemon** (from core, plugins, or config). Each declares its update mode:
  - **event** — pushed by the engine (e.g. process status),
  - **poll** — evaluated on an interval,
  - **static** — computed once at load.
- The daemon caches current values and pushes deltas to connected clients. Headless `u8 status` reads the same cache — one source of truth.
- **Config-defined indicators** (`x@` namespace): declared once at **workspace level** as a shell command + poll interval; executed **per target, in the target's cwd**; stdout (trimmed) is the value.

### 2.8 Plugin

An npm package (resolved from the workspace's `node_modules`) or a relative path to a local JS/TS file. Loaded **into the daemon**. A plugin exports `indicators`, `commands`, and `hooks` (all optional). Built-ins `git` and `health` ship inside u8cli, enabled by default, disable-able in config.

---

## 3. Naming conventions

- **Commands**: `ns:name`. Reserved namespaces: `app` (core) and every loaded plugin's name (e.g. `git:pull`). User commands in config are **bare names** (`test`, `deploy`); a bare name using a reserved prefix is rejected at validation.
- **Indicators**: `{ns@name}`. `app@…` core, `<plugin>@…` plugin, `x@…` config-defined.
- Collisions inside a namespace are validation errors.

Core indicators (v1): `app@name`, `app@dirname`, `app@path`, `app@status`, `app@pid`, `app@uptime`, `app@exitcode`.

`app@status` values: `stopped | starting | running | crashed | stopping | stale`. (`stale` = running with a spawn-time definition that no longer matches config; see §8.)

---

## 4. Templates

Row templates are strings of literal text + tokens with optional colon-chained modifiers:

```
{app@status} {app@name:pad(24)} {git@branch:color(yellow):max(15)} {health@status}
```

- Grammar: `{ns@indicator(:modifier(args))*}`.
- Modifiers (v1): `pad(n)` (right-pad/align to width), `max(n)` (truncate with `…`), `color(name)`, `dim`, `bold`. Indicators may carry a semantic default rendering (e.g. `app@status` renders `●` colored by state); modifiers override it.
- **No conditionals or expressions.** Anything conditional belongs in a custom indicator.
- Configuration: workspace-level `templates.app` (app header row) and `templates.subapp` (child row); any app or subapp may override with its own `template`. Single-subapp apps render as **one merged row** using the subapp template.
- Unknown token → rendered as `{ns@name!}` in red (not a crash); validation warns at load.

---

## 5. Architecture

### 5.1 Daemon (per workspace)

- One daemon per workspace, owns all processes, indicator cache, and log files.
- **Spawn**: first `u8` invocation auto-spawns it (detached, stdout/stderr → `daemon.log` in the state dir). Version check: a client with a different u8cli version than the daemon prompts to restart the daemon (only if no services running, otherwise warns).
- **Exit**: self-exits after ~10 min with no running services and no attached clients. `u8 daemon stop|status|logs` for manual control. Stale socket/pid detection: on connect failure, clean up and respawn.
- On daemon shutdown (`u8 daemon stop`), running services are stopped gracefully (SIGTERM to process group → SIGKILL after timeout).

### 5.2 IPC

- Unix domain socket in the state dir; newline-delimited JSON-RPC 2.0 (requests/responses) plus server-push notifications for streams (indicator deltas, log lines, task progress, config-reload events).
- Debuggable with `socat` + `jq`; no auth (socket file mode 0600).

### 5.3 Process management

- Services spawn via `$SHELL -c <script>` in the target cwd, in their **own process group**; stop = SIGTERM to the group, SIGKILL after a timeout (default 10 s, configurable).
- Env: processes inherit the daemon's environment, merged with `env` maps in order **workspace → app → subapp**. u8 does **not** parse `.env` files; repos keep their own env story.
- Crash policy: default **no auto-restart** — status flips to `crashed` (exit code surfaced), logs preserved, one-key restart in the TUI. Per-subapp opt-in `restart: "on-crash"` with capped exponential backoff (1s → 2s → 4s … max 30s; give up after 10 consecutive failures → `crashed`).

### 5.4 Startup ordering

`dependsOn: [target...]` forms a DAG (cycles = validation error). On profile start, targets start in dependency order; each dependency must be **ready** before dependents launch:

- has a healthcheck → ready = `healthy`;
- no healthcheck → ready = `running`.

Readiness wait has a timeout (default 60 s, per-subapp override); on timeout the dependent is not started and is marked with an error status.

### 5.5 Logs

- Services: one current log file per subapp, rotated at 10 MB keeping 3 files.
- Tasks: one log file per (run, target), pruned after 20 runs per command.
- Caps configurable in workspace config. `u8 logs <target>` tails/follows; TUI log view reads the same files plus the live push stream.

---

## 6. Plugin SDK (`u8cli/plugin`)

```ts
import { definePlugin } from "u8cli/plugin";

export default definePlugin({
  name: "example",
  indicators: {
    // {example@thing}
    thing: {
      scope: "subapp",            // "subapp" | "app"
      update: { poll: 5000 },      // or { event: true } / { static: true }
      async value(ctx) {           // ctx: { target, app, cwd, exec, logger, store }
        return "42";
      },
    },
  },
  commands: {
    // example:greet
    greet: {
      kind: "task",
      async run(ctx) { await ctx.exec("echo hello"); },
    },
  },
  hooks: {
    // bind to any command by name; "*" matches all
    "app:start": {
      async pre(ctx) { /* throw to abort this target */ },
      async post(ctx) { /* ctx.result: { ok, exitCode, durationMs } */ },
    },
  },
});
```

- Hook/command/indicator context: `{ workspace, command, target, phase, result?, logger, exec(cmd, opts) }` (fields per callsite). `exec` runs in the target's cwd by default.
- Plugins run **inside the daemon process** (trusted code, like vite plugins). A plugin that throws at load is disabled with an error surfaced in TUI/CLI; it never takes the daemon down.
- Local `.ts` plugin files are loaded via jiti (or Node's native TS support where available).

---

## 7. Built-in plugins

### 7.1 `git`

- **Indicators** (scope: app): `git@branch`, `git@dirty` (changed-file count, empty when clean), `git@ahead`, `git@behind` (vs upstream).
- Updated via `git status --porcelain=v2 --branch`, triggered by fs-watch on `.git/HEAD` + index with debounce, plus a slow fallback poll (30 s).
- **Commands**: `git:fetch`, `git:pull` (task kind, run across the active profile's apps — dedup: once per app, not per subapp). Read-only chores only; no checkout/mutation commands in v1.
- Non-git app dirs: indicators render empty; commands skip the app.

### 7.2 `health`

- Per-subapp opt-in:

```jsonc
"health": { "http": "http://localhost:3001/healthz" }
// or
"health": { "cmd": "pg_isready -q", "interval": 5000, "timeout": 2000, "threshold": 2 }
```

- Defaults: interval 5 s, timeout 2 s, threshold 2 consecutive failures → `unhealthy`.
- **Indicator**: `health@status` ∈ `healthy | unhealthy | starting | n/a` (n/a when no healthcheck or process not running; `starting` between spawn and first success).
- Provides the **readiness signal** consumed by `dependsOn` gating (§5.4).
- Probes only run while the subapp's process is running.

---

## 8. Config reload

The daemon watches `u8.jsonc`:

- On change: re-validate; **hot-apply** templates, indicators, commands, profiles, plugin list.
- Running processes are untouched — they keep their spawn-time definition. If a running target's effective definition (script/env/cwd) changed, its status shows `stale`; changes take effect on next (re)start.
- Invalid config: keep last-good config, surface the error in TUI header and CLI.

---

## 9. Interfaces

### 9.1 TUI (`u8` with no args)

- Main screen: list of the active profile's apps (header rows) with subapp rows beneath, rendered from templates. Cursor selection.
- Keys (defaults): `s` start / `x` stop / `r` restart selection; `S`/`X`/`R` whole profile; `Enter` log view (follow + scrollback, `Esc` back); `:` or `p` command palette (run any defined command on selection or profile); `P` profile switcher; `q` quit (daemon and processes keep running).
- Header shows workspace name, active profile, daemon state, config-error banner when applicable.
- Task runs show inline per-target progress and a result summary.

### 9.2 Headless CLI

```
u8 init                     # scaffold u8.jsonc
u8                          # open TUI
u8 start|stop|restart [target|--all]
u8 run <command> [target] [--serial] [--concurrency n]
u8 status [--json]          # rendered from the same indicator cache
u8 logs <target> [-f] [-n N]
u8 profile list|use <name>
u8 daemon status|stop|logs
```

`--json` on status (and machine-readable exit codes on `run`) make it scriptable/CI-friendly.

---

## 10. Config example

```jsonc
{
  "$schema": "https://unpkg.com/u8cli/schema.json",

  "templates": {
    "app": "{app@name:pad(24)} {app@dirname:dim} {git@branch:color(yellow):max(20)} {git@dirty:color(red)}",
    "subapp": "  {app@status} {app@name:pad(22)} {health@status} {x@version:dim}"
  },

  "plugins": ["./plugins/deploy.ts"],          // git + health are built-in

  "indicators": {
    "version": { "cmd": "jq -r .version package.json", "interval": 60000 }  // {x@version}
  },

  "apps": {
    "gateway": {
      "path": "~/Work/proj/gateway",           // no subapps → implicit subapp
      "scripts": { "start": "pnpm dev" },
      "health": { "http": "http://localhost:3000/healthz" }
    },
    "platform": {
      "path": "~/Work/proj/platform-monorepo",
      "subapps": {
        "shell":    { "path": "apps/shell",    "scripts": { "start": "pnpm dev --port 3100" } },
        "auth-mfe": { "path": "apps/auth-mfe", "scripts": { "start": "pnpm dev --port 3101" },
                      "dependsOn": ["gateway"] }
      }
    },
    "db": {
      "path": "~/Work/proj/infra",
      "scripts": { "start": "docker compose up postgres" },
      "health": { "cmd": "pg_isready -q -h localhost" },
      "restart": "on-crash"
    }
  },

  "profiles": {
    "full":     { "default": true, "targets": ["db", "gateway", "platform"] },
    "frontend": { "targets": ["platform.shell", "platform.auth-mfe"] }
  },

  "commands": {
    "test": { "script": "pnpm test", "targets": { "db": null } },   // null = skip
    "deploy": {
      "targets": { "gateway": "./scripts/deploy.sh", "platform.shell": "pnpm deploy" },
      "hooks": { "pre": "git diff --quiet || exit 1" }              // abort if dirty
    }
  }
}
```

---

## 11. v1 non-goals

- Windows support (named pipes, job objects).
- Per-profile overrides (env/args/templates) — profiles are selection only.
- Template conditionals/expressions; column-table layout.
- Git mutation commands (checkout/branch sync).
- Global cross-workspace daemon/registry; workspace picker.
- `.env` file parsing; managed env as source of truth.
- Plugin sandboxing / permissions; plugin API versioning beyond semver of `u8cli/plugin`.
- Multi-pane simultaneous log view, log search (v2 candidates).
- Auto-detection magic (repo scanning in `init`, port discovery).

## 12. Testing strategy

- Unit: template parser/renderer, config normalization (implicit subapps, target resolution), command script resolution, dependsOn DAG ordering, hook ordering/abort semantics.
- Integration: spawn a real daemon against fixture workspaces (tiny shell-script "services"), drive it over the socket — lifecycle, crash detection, restart backoff, health gating, log rotation, config reload staleness.
- TUI: ink-testing-library for list rendering from indicator snapshots; keep TUI logic thin over the client API.
