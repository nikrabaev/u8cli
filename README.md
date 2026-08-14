# u8cli

u8cli (`u8`) is a workspace-scoped orchestrator for long-running microservice apps that live in
separate repos anywhere on disk: one `u8.jsonc` describes the stack, and `u8` brings it up in
dependency order with health gating. A per-workspace daemon owns the processes, so services keep
running after you close the terminal, and a live dashboard renders their state from the daemon's
indicator cache.

---

## Concepts

| Concept | What it is |
| --- | --- |
| **Workspace** | A directory holding `u8.jsonc`, found by walking up from the cwd. Everything `u8` does is scoped to one. |
| **App** | A repo, located anywhere (`path` is absolute, `~`-relative, or relative to the workspace). Groups subapps and carries app-scoped indicators. Not runnable itself. |
| **Subapp** | The runnable unit: one process, one log, one status. An app declared without `subapps` gets one *implicit* subapp whose id is the app name. |
| **Profile** | A named selection of targets. The active profile is per-machine state, not config — switching it never touches `u8.jsonc`. |
| **Command** | A named unit of work run against targets. `kind: "task"` runs to completion; `kind: "service"` is supervised. Built-ins: `app:start`, `app:stop`, `app:restart`. |
| **Indicator** | A named value rendered in row templates as `{ns@name}` — `app@status`, `health@status`, `git@branch`, `x@`… for config-defined ones. |
| **Plugin** | An npm package or local file loaded into the daemon, contributing indicators, commands, hooks and a readiness signal. `git` and `health` are built in. |

A **target** is addressed as `app` (every subapp of that app) or `app.subapp` (exactly one).

---

## Install

Requires **Node.js ≥ 22** on **macOS or Linux**. Windows is not supported in v1 (WSL works).

```sh
npm install -g u8cli      # or: pnpm add -g u8cli
u8 --version
```

## Quickstart

```console
$ cd ~/Work/my-stack
$ u8 init
created u8.jsonc
edit the apps you want u8 to run, then: u8 status
```

Point the apps at your repos and give each one a `start` script, then bring the stack up. (The
transcripts below are [`examples/demo`](examples/demo) in this repo: two single-service repos, a
monorepo with two subapps, healthchecks and `dependsOn` throughout.)

```console
$ u8 start
✓ db                ok 506ms
✓ platform.shell    ok 516ms
✓ api               ok 504ms
✓ platform.auth-mfe ok 506ms

TARGET             RESULT  TIME   DETAIL
db                 ✓ ok    506ms
api                ✓ ok    504ms
platform.shell     ✓ ok    516ms
platform.auth-mfe  ✓ ok    506ms
app:start: 4 ok in 8.6s (run mssv98od-977d9716)
```

Each target reports about half a second because a service is only called started once it has
survived a 500 ms grace — a script that dies on spawn is reported failed rather than ok, so the
exit code is worth something in CI. The 8.6 s wall time on top of that is `dependsOn` gating: `api`
waited for `db` to pass its healthcheck, and `platform.auth-mfe` waited for `api` (see
[CONFIG.md](docs/CONFIG.md#dependson-and-readiness)).

```console
$ u8 status
u8-demo · profile full · 4/4 running
  running  db               healthy   14s   -
  running  api              healthy   12s   3000
platform             platform main 9
  running  shell            healthy   15s   3100
  running  auth-mfe         healthy   7s    3101
```

`db` and `api` are single-service repos, so each renders as one merged row; `platform` is a monorepo,
so it gets a header row plus one row per subapp. Every column is a template token: status, name,
`{health@status}`, `{app@uptime}` and a config-defined `{x@port}` on the child rows, and
`{git@branch}` plus `{git@dirty}` on the header — the `9` is nine changed files in that checkout.
In a terminal the status column is a coloured `●`; piped (as above) it falls back to the word,
because a colourless dot means nothing in a log file.

`u8 status --json` prints the same data in a stable, script-readable shape.

That demo workspace — four services across three repos, healthchecks, `dependsOn`, a config-defined
indicator and a task command with hooks — is `cd examples/demo && u8 start` away, and its
[`u8.jsonc`](examples/demo/u8.jsonc) is annotated.

---

## Commands

Global options are accepted on either side of the subcommand (`u8 --cwd x status` ≡ `u8 status --cwd x`):

| Option | Effect |
| --- | --- |
| `--config <path>` | Use this `u8.jsonc`, skipping upward discovery |
| `--cwd <dir>` | Act as if `u8` was started in `<dir>` |
| `--no-color` | Never emit ANSI colour |
| `-V, --version` | Print the u8 version |

| Command | What it does |
| --- | --- |
| `u8` | Open the dashboard |
| `u8 init` | Write a commented `u8.jsonc` skeleton in the current directory (refuses to overwrite) |
| `u8 start [targets...] [--all]` | Start services in dependency order. No targets = the active profile; `--all` = every target in the workspace |
| `u8 stop [targets...] [--all]` | Stop services (reverse dependency order) |
| `u8 restart [targets...] [--all]` | Stop then start |
| `u8 run <command> [targets...] [--serial] [--concurrency <n>]` | Run a command (`test`, `git:pull`, …). `--serial` means one target at a time |
| `u8 status [--json] [--profile <name>]` | Print the profile's rows. `--profile` renders another profile without switching to it |
| `u8 logs <target> [-f] [-n <lines>] [--run <runId>]` | Print, and optionally follow, a target's log (200 lines by default, 5000 max). `--run` reads a task run's log instead of the service log |
| `u8 profile list` | List profiles; `*` marks the active one |
| `u8 profile use <name>` | Switch the active profile (persisted in the state dir) |
| `u8 daemon status` | Report the daemon's version, pid, uptime, clients and idle deadline. Exits non-zero when no daemon is running |
| `u8 daemon stop` | Stop the daemon and its services |
| `u8 daemon logs [-f] [-n <lines>]` | Print the daemon log, 50 lines by default (works while the daemon is down) |

`--all` cannot be combined with explicit targets. Exit codes: `0` success, `1` any failure
(including a run where a target failed), `130` interrupted with Ctrl-C.

Ctrl-C during `u8 start` / `u8 run` **detaches** — it stops the printing, not the run. The daemon owns
the work; pick it back up with `u8 status` or `u8 logs <target> --run <runId>`.

Environment: `U8_STATE_HOME` (state dir root, default `~/.u8`), `U8_LOG_LEVEL=debug` (verbose daemon
and CLI logging), `U8_IDLE_MS` (idle-exit override for a daemon this command spawns; `0` disables it),
`U8_NO_TUI` (bare `u8` prints the status view instead of the dashboard), `NO_COLOR` / `FORCE_COLOR`,
and `SHELL` (the shell every script is run with, falling back to `/bin/sh`).

---

## The dashboard

`u8` with no arguments is the interactive front end: the active profile's apps and subapps as
template-rendered rows, refreshed from the daemon's push stream, with a log view and a command
palette.

| Key | Action |
| --- | --- |
| `↑` `↓` or `k` `j` | Move the cursor |
| `PgUp` `PgDn`, `g` / `G` | Page through the list; first / last row |
| `s` / `x` / `r` | Start / stop / restart the selected target |
| `S` / `X` / `R` | Start / stop / restart the whole profile |
| `Enter` | Log view for the selection (follow + scrollback); `Esc` or `q` goes back |
| `:` or `p` | Command palette — run any defined command on the selection or the profile |
| `P` | Profile switcher |
| `?` | Toggle the key help |
| `q` | Quit. The daemon and every service keep running |

Inside the log view the same navigation keys scroll the buffer. In the palette, type to filter,
`↑`/`↓` (or `Ctrl-N`/`Ctrl-P`) to move, `Tab` to switch between running on the selection and on the
whole profile, `Enter` to run, `Esc` to close.

Everything the dashboard does is also a headless command, and both read the same indicator cache, so
they can never disagree about a target's state.

The dashboard needs a real terminal on both ends. Piped, redirected, in CI, or with `U8_NO_TUI` set,
a bare `u8` prints the status view instead and says so on stderr.

---

## The daemon

One daemon per workspace, identified by a hash of the *real* (symlink-resolved) path of `u8.jsonc` —
two checkouts of the same project never share one.

- **Auto-spawn.** Any `u8` command connects to the workspace's unix socket and, if nobody answers,
  spawns the daemon detached with its output already pointed at `daemon.log`. You never start it by
  hand. If it fails to come up because the config is broken, the CLI prints the config errors rather
  than a log tail.
- **It owns everything.** Processes (each in its own process group), log files, the indicator cache
  and every loaded plugin live in the daemon. Closing the terminal, or Ctrl-C'ing `u8 start`, does not
  touch them.
- **Idle exit.** After 10 minutes with no clients connected and no running services it exits by
  itself. Set `limits.daemonIdle` in the config, or `U8_IDLE_MS` in the environment of the command
  that spawns it (which wins, and where `0` turns idle exit off). `u8 daemon status` reports the
  current deadline.
- **Version checks.** A daemon speaking a different IPC protocol version than the client is a hard
  error telling you to `u8 daemon stop`; a same-protocol version difference is only a warning.
- **Stopping.** `u8 daemon stop` shuts services down gracefully (SIGTERM to the process group, SIGKILL
  after `stopTimeout`) before exiting.

The daemon watches `u8.jsonc` and re-applies it in place: templates, indicators, commands, profiles
and the plugin list are hot-applied, an invalid edit keeps the last-good config in service and
surfaces the error, and **running processes are never touched** — a target whose script, cwd or env
changed goes `stale` and picks the change up on its next restart. Editing a plugin's own *file* is
the exception: the module is already imported, so that needs `u8 daemon stop`.

### State directory

Everything runtime lives under `$U8_STATE_HOME/<workspace-id>/` (default `~/.u8/<workspace-id>/`):

```text
~/.u8/df48413e6129/
├── daemon.sock              # unix socket, mode 0600 (falls back to $TMPDIR if the path is too long)
├── daemon.pid
├── daemon.log               # u8 daemon logs
├── state.json               # local state: the active profile (written once you switch)
└── logs/
    ├── services/<target>.log            # one rotating file per subapp (10 MB, 3 generations)
    └── tasks/<command>/<runId>/<target>.log   # one per (run, target); oldest runs pruned
```

Nothing here is checked in. Deleting a workspace's directory while its daemon is running is not a
free operation, though: the daemon notices its own state dir has gone, stops its services and exits,
so you lose the running stack along with the logs and the active profile. Stop the daemon first
(`u8 daemon stop`) if you meant to keep the services up.

---

## Further reading

- [docs/CONFIG.md](docs/CONFIG.md) — the complete `u8.jsonc` reference: every field, default and rule.
- [docs/PLUGINS.md](docs/PLUGINS.md) — writing a plugin, with a complete working example.
- [docs/SPEC.md](docs/SPEC.md) — the design record: architecture, IPC, and what v1 deliberately leaves out.

The package ships `schema.json`, so `"$schema": "https://unpkg.com/u8cli/schema.json"` at the top of
`u8.jsonc` gives your editor completion and validation for the whole config.

## License

MIT.
