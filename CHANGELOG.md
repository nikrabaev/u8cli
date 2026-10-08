# Changelog

Notable changes to u8cli. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The two levels of the workspace model are renamed.** What was an *app* (a checkout on disk) is now a **repo**, and what was a *subapp* (the runnable unit) is now an **app** — the word the core commands (`app:start`) and indicators (`{app@status}`) already used for it. Target ids (`api`, `platform.shell`), the state directory and the log paths are unchanged. Everything that carried the old words moved with them:

  | Before | After |
  | --- | --- |
  | `apps` / `subapps` in `u8.jsonc` | `repos` / `apps` |
  | `templates.app` / `templates.subapp` | `templates.repo` / `templates.app` |
  | `scope: "app"` / `"subapp"` on a config or plugin indicator | `"repo"` / `"app"` |
  | `{app@name}`, `{app@dirname}`, `{app@path}`, `{app@status}` on a header row | `{repo@name}`, `{repo@dirname}`, `{repo@path}`, `{repo@status}` |
  | `groupBy: "app"` on a plugin command | `groupBy: "repo"` |
  | `ctx.app`, `ctx.apps`, `AppInfo`, `TargetInfo.appName` in the plugin API | `ctx.repo`, `ctx.repos`, `RepoInfo`, `TargetInfo.repoName` |
  | `apps[].subapps[]` and `appName` in `u8 status --json` | `repos[].apps[]` and `repoName`, under `schemaVersion: 2` |

  A config still written with the old keys is rejected with one message naming every rename, and an `{app@…}` token left on a repo header row is reported as a config warning. `repo` joins `app` and `x` as a name a plugin may not take. The wire protocol is now v2, so a daemon left running by an older build has to be stopped with `u8 daemon stop` before the new client will talk to it.

### Fixed

- **Plugin packages resolve only from the workspace's `node_modules`.** The resolver also honoured `NODE_PATH`, which a package manager's bin shim points at the launched tool's own dependency tree — so with u8 started through pnpm, a plugin the workspace had not installed could load a copy from inside u8cli's dependencies instead of being reported as missing.

## [0.1.0-rc.1] — 2026-08-14

First release candidate. Everything in the v1 design is implemented and covered by 785 tests.

### Added

- **Workspace model.** A `u8.jsonc` discovered by walking up from the current directory defines apps (repos anywhere on disk), their subapps (services inside a monorepo), profiles (named target selections), commands, and indicators. An app declared without subapps becomes one implicit subapp, so every runnable thing is addressable as `app` or `app.subapp`.
- **Per-workspace daemon.** Auto-spawns on first use, owns every service process, and survives the terminal that started it — close the shell, reopen `u8`, reattach to a running stack. Exits on its own after ten idle minutes. Clients talk to it over a unix socket with newline-delimited JSON-RPC.
- **Supervised services** with crash detection, an opt-in `on-crash` restart policy with capped exponential backoff, custom stop scripts that cannot leave orphans behind, and per-service rotating logs.
- **Dependency-ordered startup.** `dependsOn` forms a DAG; each dependency must be ready before its dependents launch — healthy if it declares a healthcheck, running otherwise — with a per-target timeout that reports which dependency never came up.
- **Commands** with a shared script, per-target overrides, and `null` to skip. Tasks run in parallel under a concurrency cap; `kind: "service"` commands are supervised like `app:start`. Every command carries `pre`/`post` hooks per target: a failing `pre` aborts that target alone, and `post` always runs and receives the outcome.
- **Indicators** rendered through a template grammar — `{app@status:pad(8)} {git@branch:color(yellow):max(20)}` — configurable per workspace, app, or subapp. Values come from one daemon-side cache, so the dashboard, `u8 status`, and `u8 status --json` can never disagree.
- **Plugins** loaded from npm packages or local `.ts`/`.js` files, contributing indicators, commands, hooks, and a readiness verdict. A plugin that fails is disabled and reported, never fatal. A plugin that needs configuration exports a factory taking its options; `builtins` entries and `plugins` entries both accept an options object, and options handed to a plugin with no factory are an error rather than a silent no-op.
- **Built-in plugins**: `git` (branch, dirty count, ahead/behind, `git:fetch`, `git:pull`), `health` (HTTP and command probes with threshold semantics), and `protos` (below). The first two are on by default.
- **`protos` built-in** for the shared-contract loop: link a locally-built package into the subapps that consume it, so a new contract can be tried end to end before it is published. Configure it with the package names and it registers `protos:link` / `protos:unlink` plus a pair per package (`protos:link:react-query`), since u8 commands take no arguments. Consumers are detected from each subapp's `package.json`, so a target that does not use a package is skipped rather than failing. `{protos@<name>}` indicators show the effective version and distinguish a yalc link (`9.9.9-local local`) from an installed version, a declared range, and a package this subapp does not consume. Link/unlink only: building and `yalc publish` stay yours, and the failure you will meet most — the package was never published to the store — says so and tells you where to run it.
- **Ink dashboard** (`u8`) with cursor selection, lifecycle keys, a follow-mode log view with bounded scrollback, a filterable command palette scoped to the selection or the whole profile, and a profile switcher.
- **Headless CLI** for `init`, `start`/`stop`/`restart`, `run`, `status` (text or versioned `--json`), `logs -f`, `profile`, and `daemon`. Exit codes reflect target outcomes, so a run is usable as a CI gate.
- **Config hot-reload.** Editing `u8.jsonc` re-applies templates, indicators, commands, profiles, and the plugin *list* without touching running processes; a target whose definition changed is marked stale until restarted. A broken save keeps the last good config and recovers on the next good one.

### Known limitations

Platform and scope:

- macOS and Linux only. Windows is not supported in v1 (WSL works).
- One daemon per workspace, with no cross-workspace view: there is no "what is running on this machine" command and no port-conflict detection between workspaces.
- Profiles select targets only — no per-profile env, argument, or template overrides.
- u8 does not read `.env` files and is not the source of truth for service env. It merges `env` maps (workspace → app → subapp) over the environment it inherited; each repo keeps its own env story.

Behaviour worth knowing before you rely on it:

- A service is judged on surviving a 500 ms start grace. One that dies later still reports `ok` for that run — a healthcheck is what catches those.
- A `restart: "on-crash"` service that crashes inside that grace fails the run and skips its dependents, even though backoff brings it up moments later.
- Editing a plugin's own source does not hot-reload it; changing the plugin *list* in `u8.jsonc` does. Restart the daemon to pick up plugin code changes.
- Plugin commands run in the daemon, which inherits `PATH` once at spawn. Installing a tool a plugin shells out to (yalc, say) after the daemon started needs a `u8 daemon stop` before it is visible.
- `protos` does not reinstall `node_modules` after unlinking; it tells you to run your package manager rather than guessing npm, pnpm, or yarn.
- Backfilled log lines read from disk all report the `stdout` stream — the on-disk format carries a timestamp but no stream marker. Live lines are tagged correctly.
- Templates take tokens and modifiers, not conditionals or expressions; anything conditional belongs in a custom indicator.
- Wide CJK and emoji count as one column when padding template rows, so those cells under-pad.

Deliberately absent in v1:

- The `git` built-in reads only — no checkout or cross-repo branch syncing.
- The dashboard shows one log stream at a time, with no multi-pane view and no log search.
- `u8 init` writes a skeleton; it does not scan for repos, and nothing auto-detects ports.
- Plugins are trusted code loaded into the daemon: no sandboxing and no permission model. Treat a plugin the way you would treat a build script.
- Editor completion for `u8.jsonc` relies on the `$schema` URL resolving from a registry, so it only works once the package is published. `schema.json` ships in the package meanwhile.
