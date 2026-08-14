# `u8.jsonc` reference

A workspace is a directory holding `u8.jsonc`. `u8` finds it by walking upward from the current
directory (git-style) and resolves the result through symlinks — the real path is what identifies the
workspace, so two routes to the same file always reach the same daemon.

The format is JSONC: `//` and `/* */` comments and trailing commas are allowed. Unknown keys are
rejected everywhere, so a typo is an error at load rather than a setting that silently does nothing.

```jsonc
{
  "$schema": "https://unpkg.com/u8cli/schema.json",
  "apps": { "web": { "path": "~/Work/web", "scripts": { "start": "pnpm dev" } } }
}
```

`apps` is the only required key. Everything else has a default.

---

## Top level

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `$schema` | string | — | Editor completion/validation. The package ships `schema.json`. |
| `name` | string | basename of the workspace directory | Workspace label in the dashboard header and `u8 status`. |
| `env` | `{ [k: string]: string }` | `{}` | Environment for every spawned process; the bottom layer of the merge. |
| `templates` | object | see [Templates](#templates) | Row templates for app and subapp rows. |
| `plugins` | string[] | `[]` | npm package names, or paths (`./`, `/`, `~`) to local files. |
| `builtins` | `{ git?: boolean, health?: boolean }` | both `true` | Switches off a built-in plugin. |
| `limits` | object | see [Limits](#limits) | Log rotation, timeouts, concurrency, daemon idle exit. |
| `indicators` | `{ [name: string]: IndicatorDef }` | `{}` | Config-defined `{x@…}` indicators. |
| `apps` | `{ [name: string]: App }` | **required** | The repos u8 manages. |
| `profiles` | `{ [name: string]: Profile }` | a synthesized `all` | Named selections of targets. |
| `commands` | `{ [name: string]: Command }` | `{}` | Extra commands, plus hooks. |

App, subapp and profile names must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` — no `.`, `:` or `@`, because
those are the separators for target ids (`app.subapp`), command namespaces (`git:pull`) and
indicators (`{git@branch}`). Command and `x@` indicator names may additionally contain `.`
(`db.migrate`).

---

## Apps and subapps

### App

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `path` | string | **yes** | — | Absolute, `~`-prefixed, or relative to the workspace directory. |
| `subapps` | `{ [name: string]: Subapp }` | no | — | Omit for a single-service repo; see below. |
| `template` | string | no | `templates.app` | Overrides the app header row. |
| `env` | map | no | — | Layered over `env`; inherited by every subapp. |
| `scripts` | `{ [name: string]: string }` | no | — | Inherited by every subapp. |
| `health` | object | no | — | Inherited by every subapp. |
| `restart` | `"no" \| "on-crash"` | no | `"no"` | Inherited by every subapp. |
| `dependsOn` | string[] | no | `[]` | Inherited by every subapp. |
| `readyTimeout` | int > 0 (ms) | no | `limits.readyTimeout` | Inherited by every subapp. |
| `stopTimeout` | int > 0 (ms) | no | `limits.stopTimeout` | Inherited by every subapp. |

### Subapp

Same keys minus `subapps`, plus:

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `path` | string | no | the app's `path` | Relative to the **app's** path (`~` and absolute also work). |

### Implicit subapps

The engine only knows subapps: every process, log file, status and command target is one. An app
declared **without** `subapps` is normalized into an app holding a single *implicit* subapp whose
target id is just the app name, taking its `path`, `scripts`, `env`, `health`, `restart`,
`dependsOn` and timeouts from the app entry.

```jsonc
"api": { "path": "./services/api", "scripts": { "start": "node server.js" } }
// → one target, addressed as "api"
```

An app **with** `subapps` is not runnable itself; each subapp is a target named `app.subapp`.

### App-level fields are defaults, not shared values

When an app declares `subapps`, the app-level `scripts`, `env`, `health`, `restart`, `dependsOn`,
`readyTimeout` and `stopTimeout` become per-subapp defaults:

- `scripts` and `env` are **merged key by key** (app first, subapp second — a subapp overrides only
  the keys it names).
- `health`, `restart`, `readyTimeout`, `stopTimeout` are **replaced wholesale** when the subapp sets
  them. In particular a subapp's `health` never inherits the app's `interval`/`threshold`: `http` and
  `cmd` are mutually exclusive, so merging two checks would produce an invalid one.
- `dependsOn` is replaced wholesale too. An app-level `dependsOn` is resolved once and applied to
  every subapp that does not declare its own.

### Env merge order

Deepest wins, over the daemon's own environment:

```text
process env of the daemon  →  workspace env  →  app env  →  subapp env
```

The daemon's environment is applied at spawn time, so `PATH` and friends are always present. u8 does
**not** read `.env` files.

### Path resolution

| Written on | Resolved against |
| --- | --- |
| `apps.<app>.path` | the workspace directory (the one holding `u8.jsonc`) |
| `apps.<app>.subapps.<sub>.path` | that app's resolved `path` |
| `plugins` entries starting with `.`, `/` or `~` | the workspace directory |

A leading `~` or `~/` expands to the home directory in all three places. Absolute paths are used
as-is.

### Scripts

`scripts` maps a name to an **arbitrary shell string**, run with `$SHELL -c` (falling back to
`/bin/sh`) in the target's working directory. There are no package-manager assumptions.

Two names are special:

- `scripts.start` backs `u8 start` / `app:start`. A target with no `start` script is **skipped**.
- `scripts.stop` backs `u8 stop` / `app:stop`. With no `stop` script, u8 signals the process group
  directly (SIGTERM, then SIGKILL after `stopTimeout`) — which is the normal case.

Every other name is inert unless a command or a plugin reads it.

### Health checks

```jsonc
"health": { "http": "http://localhost:3000/healthz" }
"health": { "cmd": "pg_isready -q", "interval": 5000, "timeout": 2000, "threshold": 2 }
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `http` | string | — | GET; 2xx and 3xx are healthy. Exactly one of `http`/`cmd` is required. |
| `cmd` | string | — | Shell probe in the target's cwd with its merged env; exit 0 is healthy. |
| `interval` | int > 0 (ms) | `5000` | Time between probes. |
| `timeout` | int > 0 (ms) | `2000` | A probe that outruns this fails. |
| `threshold` | int > 0 | `2` | *Consecutive* failures before the verdict flips to `unhealthy`. One success resets the count. |

Setting both `http` and `cmd`, or neither, is a validation error. Probes only run while the target's
process is up; otherwise `{health@status}` reads `n/a`. A freshly started process reads `starting`
until the first probe succeeds. An `https://` URL pointed at loopback accepts a self-signed
certificate; anything else is verified normally.

### Restart policy

| Value | Behaviour |
| --- | --- |
| `"no"` (default) | A crash leaves the target `crashed` with its exit code and log preserved. Restart it from the dashboard (`r`) or `u8 restart <target>`. |
| `"on-crash"` | The supervisor restarts it on a capped exponential backoff: 1s, 2s, 4s, 8s, 16s, then 30s for every further attempt. After 10 consecutive failed attempts it gives up and stays `crashed`. |

A restart requested by you (or by `u8 restart`) resets the attempt counter; so does a process that
stays up.

### `dependsOn` and readiness

`dependsOn` lists targets that must be **ready** before this one is launched. Entries are the same
target strings used everywhere: an app name expands to all of its subapps, `app.subapp` names one.
Cycles are a validation error naming the loop.

A dependency counts as ready when:

- it declares a `health` check → it has probed **healthy**;
- it declares none → its process is **running**.

(A plugin may contribute its own readiness verdict; the first plugin in load order with an opinion
wins, and the rule above is the fallback. See [PLUGINS.md](PLUGINS.md#readiness).)

Readiness is polled every 100 ms up to that dependency's `readyTimeout` (default 60 s). On timeout
the dependent is **not** started and is reported `failed` with the reason
(`dependency "db" did not become ready within 60000ms`); it blocks its own dependents in turn, which
are reported `skipped` (`not started: dependency "api" never became ready`). A timed-out dependency
therefore fails the run — `u8 start` exits 1 — rather than silently dropping half a stack. Only
dependencies that are part of the same run are waited on.

`u8 stop` walks the same graph in reverse.

---

## Profiles

```jsonc
"profiles": {
  "full":     { "default": true, "targets": ["db", "api", "platform"] },
  "frontend": { "targets": ["platform.shell", "platform.auth-mfe"] }
}
```

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `targets` | string[] | **yes** | App names and/or `app.subapp` ids. An app expands to all its subapps; duplicates are dropped, config order is kept. |
| `default` | boolean | no | At most one profile may set it — two is a validation error. |

Rules:

- Declare no profiles at all and u8 synthesizes one named **`all`**, marked default, covering every
  app in config order.
- Declare profiles but mark none `default: true` and the **first one declared** becomes the default.
- Profiles are pure selection. They cannot override env, scripts or templates.
- The *active* profile is per-machine state (`state.json` in the state dir), not config. Switch it
  with `u8 profile use <name>` or `P` in the dashboard; `u8 status --profile <name>` renders another
  one without switching.
- If a reload removes the active profile, the daemon falls back to the default and logs it.

---

## Commands

```jsonc
"commands": {
  "test": {
    "description": "Run each service's test suite",
    "script": "pnpm test",
    "targets": { "api": "node --test", "db": null }
  }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `kind` | `"task" \| "service"` | `"task"` | `task` runs to completion (success = exit 0). `service` is supervised: the script becomes the target's process and "done" means running. |
| `description` | string | — | Shown in `u8 status --json` and the dashboard palette. |
| `script` | string | — | Shared script, run in **every** selected target's cwd. |
| `targets` | `{ [target: string]: string \| null }` | `{}` | Per-target override, or `null` to skip. Keys may be app names (applies to all their subapps) or `app.subapp`. |
| `concurrency` | int > 0 | `limits.taskConcurrency` | Cap for this command. |
| `hooks` | `{ pre?: string \| string[], post?: string \| string[] }` | — | Shell hooks; see below. |

### Target resolution

For each selected target, in this order:

1. an entry in `targets` for that exact `app.subapp` id → that script (or a skip if `null`);
2. an entry in `targets` for its app name → that script (or a skip if `null`);
3. otherwise the shared `script`;
4. no shared `script` either → a skip.

An explicit `app.subapp` entry always beats an app-wide one, whatever order they were written in.
Both kinds of skip are *reported*, not dropped — the summary table shows `no script for "<id>" in
command "<name>"` — and neither runs the command's hooks. Skipped targets are not failures: the run's
exit code only reflects targets that actually failed.

`kind: "service"` commands use exactly the same resolution — they never fall back to the target's own
`scripts.start`.

### Concurrency

Targets run in parallel with a cap. Precedence, first match wins:

1. `--serial` on the command line → 1
2. the command's own `concurrency`
3. `--concurrency <n>` on the command line
4. `limits.taskConcurrency` (default 4)

A per-command `concurrency` therefore overrides `--concurrency`; use `--serial` to force one at a
time regardless.

### Command names must be bare

`:` is the namespace separator, and every namespace is reserved: `app` for the core commands
(`app:start`, `app:stop`, `app:restart`) and each loaded plugin's name for its own (`git:pull`).
A config command name containing `:` or `@` is a validation error. Write `test`, `deploy`,
`db.migrate`.

The three core commands always exist. Their per-target script comes from the subapp's
`scripts.start` / `scripts.stop`, and they can be given hooks by a plugin (config `hooks` live on
config commands only).

### Hooks

A hook is a shell string — or an array of them — run in the target's working directory with the
target's environment, per `(command, target)` pair:

```text
pre …  →  the command's script  →  post …
```

- A failing `pre` (non-zero exit) **aborts that target only**; every other target proceeds. Its
  reason lands in the target's run log and the result table.
- `post` **always runs**, including after a failure or an abort, and a failing `post` is reported but
  does not change the target's verdict.
- Order is: config hooks in the order written, then plugin hooks in plugin load order (built-ins
  first, then `plugins` in config order).

```jsonc
"deploy": {
  "targets": { "api": "./scripts/deploy.sh" },
  "hooks": {
    "pre": "git diff --quiet || (echo 'refusing: dirty tree' && exit 1)",
    "post": "echo deploy finished"
  }
}
```

---

## Indicators (`x@`)

Config-defined indicators are declared once at workspace level and evaluated **per owner, in that
owner's working directory**. Trimmed stdout is the value.

```jsonc
"indicators": {
  "version": { "cmd": "jq -r .version package.json", "interval": 60000 },
  "size":    { "cmd": "du -sh . | cut -f1", "scope": "app" }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `cmd` | string | **required** | Shell command; trimmed stdout is the value. |
| `interval` | int > 0 (ms) | `5000` | Poll interval. |
| `scope` | `"subapp" \| "app"` | `"subapp"` | Run once per subapp (in its cwd) or once per app (in the app root). |

They render as `{x@version}`. Names are bare — `x` is the reserved namespace, so `"x@version"` as a
key is a validation error.

A `scope: "subapp"` probe gets the target's merged `env` on top of the daemon's; a `scope: "app"`
probe gets only the daemon's, because an app has no env of its own. Read what you need from the
filesystem rather than from `$PORT` in an app-scoped probe.

A probe is killed at 80% of its own interval (clamped to 100 ms–5 s), so a slow command can never
pile up. A failing or killed probe yields an **empty** cell and a warning in the daemon log, never a
stale value. Values are sanitized before they are cached: ANSI escapes and control characters are
stripped, whitespace runs collapse to one space, and the result is capped at 200 characters.

---

## Templates

A row is literal text plus `{ns@indicator}` tokens with optional `:`-chained modifiers.

```jsonc
"templates": {
  "app":    "{app@name:max(24):pad(24)} {app@dirname:dim} {git@branch:color(yellow):max(20)} {git@dirty:color(red)}",
  "subapp": "  {app@status:pad(8)} {app@name:max(22):pad(22)} {health@status:pad(9)}"
}
```

Those two strings are also the defaults. `templates.app` renders an app header row and
`templates.subapp` each child row; any app or subapp may override its own with a `template` key. An
app with exactly one subapp renders as a **single merged row** using the subapp template — and a
subapp row falls back to the app's cells for a token the subapp does not have, which is what lets a
merged row mention the app-scoped `{git@branch}`.

Which string a row uses:

| Row | Template |
| --- | --- |
| Header row of a multi-subapp app | that app's `template`, else `templates.app` |
| Child row | that subapp's `template`, else `templates.subapp` |
| Merged row of a single-subapp app | the subapp's `template`, else the **app's** `template`, else `templates.subapp` |

So an app-level `template` on a single-service app is what its merged row uses, and on a monorepo it
is the header row instead — it never leaks into child rows.

### Grammar

```text
{ns@name}                 {ns@name:mod}            {ns@name:mod(arg):mod}
```

Both halves of `ns@name` must start with a letter and continue with letters, digits, `_` or `-`.
`{{` and `}}` escape a literal brace.

Parsing never throws, so a template typo degrades rather than breaking the dashboard — but the two
kinds of typo look different:

- A **malformed head** (`{app@nam e}`) is rendered as the literal text you typed. In this build
  nothing else reports it, so a row echoing its own template *is* the error message.
- A **malformed modifier** (`{app@name:pad(x)}`) is dropped and the token renders unmodified.
- A **well-formed** token naming an indicator that does not exist (`{git@brunch}`) renders as
  `{git@brunch!}` in red.

```console
$ u8 status          # templates.subapp = "  {app@nam e} | {app@name:pad(x)} | {git@brunch} | {{lit}} | {app@name}"
tw · profile all · 0/1 running
  {app@nam e} | a | {git@brunch!} | {lit} | a
```

### Modifiers

| Modifier | Effect |
| --- | --- |
| `pad(n)` | Right-pads to `n` display columns. Never clips — longer text is left alone. |
| `max(n)` | Truncates to `n` columns, spending the last one on `…`. |
| `color(name)` | One of `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`. |
| `dim` | Dim. Takes no arguments. |
| `bold` | Bold. Takes no arguments. |

`n` is an integer between 0 and 1000. Modifiers apply left to right, so `max(24):pad(24)` gives a
column that is exactly 24 wide — `pad` alone only sets a minimum, and one long name would shift
everything to its right on that row.

Some indicators carry a default appearance: `{app@status}` renders as a `●` coloured by state, and
`{health@status}` and `{git@dirty}` carry a tone. The **first** explicit style modifier
(`color`/`dim`/`bold`) discards that default entirely rather than merging with it. Layout modifiers
(`pad`, `max`) do not.

There are no conditionals or expressions. Anything conditional belongs in an `x@` indicator or a
plugin.

### Available indicators

| Token | Scope | Value |
| --- | --- | --- |
| `{app@name}` | both | Subapp name / app name |
| `{app@dirname}` | both | Basename of the working directory / repo root |
| `{app@path}` | both | Absolute working directory / repo root |
| `{app@status}` | both | `stopped`, `starting`, `running`, `crashed`, `stopping`, `stale`. On an app row: the worst of its subapps. Renders as `●`. |
| `{app@pid}` | subapp | Process id while up, else empty |
| `{app@uptime}` | subapp | `12s`, `4m`, `1h3m`, `2d5h`; empty unless running |
| `{app@exitcode}` | subapp | Exit code of the last finished run |
| `{git@branch}` | app | Branch, or short sha when detached; empty outside a repo |
| `{git@dirty}` | app | Changed-file count including untracked; empty when clean |
| `{git@ahead}` / `{git@behind}` | app | Commits vs upstream; empty when zero or no upstream |
| `{health@status}` | subapp | `healthy`, `unhealthy`, `starting`, `n/a` |
| `{x@<name>}` | as declared | Your config-defined indicators |
| `{<plugin>@<name>}` | as declared | Plugin indicators |

`stale` is not a lifecycle state: it means a *running* process whose spawn-time script, cwd or env no
longer matches the config. It clears on the next restart.

---

## Limits

```jsonc
"limits": { "logMaxBytes": 10485760, "logKeep": 3, "taskRunsKeep": 20,
            "stopTimeout": 10000, "readyTimeout": 60000,
            "taskConcurrency": 4, "daemonIdle": 600000 }
```

| Key | Type | Default | What it caps |
| --- | --- | --- | --- |
| `logMaxBytes` | int > 0 | `10485760` (10 MB) | Size at which a service log rotates. |
| `logKeep` | int > 0 | `3` | Rotated generations kept per service. |
| `taskRunsKeep` | int > 0 | `20` | Task runs kept per command before the oldest are pruned. |
| `stopTimeout` | int > 0 (ms) | `10000` | SIGTERM → SIGKILL grace when stopping a process group. Overridable per app/subapp. |
| `readyTimeout` | int > 0 (ms) | `60000` | Max wait for a dependency to become ready. Overridable per app/subapp. |
| `taskConcurrency` | int > 0 | `4` | Targets running at once, unless the command or the CLI says otherwise. |
| `daemonIdle` | int > 0 (ms) | `600000` (10 min) | Idle time with no clients and no running services before the daemon exits. `U8_IDLE_MS` overrides it for a daemon it spawns; `0` there disables idle exit. |

---

## Plugins

```jsonc
"plugins": ["./plugins/deploy.ts", "@acme/u8-plugin-k8s"],
"builtins": { "git": true, "health": true }
```

An entry starting with `.`, `/` or `~` is a path resolved against the workspace directory (a missing
extension is tried as `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`); anything else is an npm package resolved
from the **workspace's own** `node_modules`. Load order is built-ins first, then this list in order —
and load order is the order hooks run in.

A plugin that fails to load is **disabled**, not fatal: `u8 status` prints a warning on stderr, the
dashboard shows it, and `u8 status --json` reports it under `plugins[].error`. See
[PLUGINS.md](PLUGINS.md).

---

## Config reload

The daemon watches `u8.jsonc` (a directory watch plus a stat poll, so editor rename-on-save is
caught) and re-validates on change.

- Templates, indicators, commands, profiles and the plugin list are **hot-applied**. The plugin host
  is only rebuilt when the `plugins` list itself changed.
- **Running processes are never touched.** They keep their spawn-time definition; if the effective
  script, cwd or env changed, the target's status becomes `stale` and the change takes effect on the
  next restart.
- An invalid config keeps the last-good one in service. The error is surfaced in the dashboard header
  and on stderr from `u8 status`, and in `configError` in `u8 status --json`.

---

## Complete annotated example

```jsonc
{
  // Editor completion. Ships with the u8cli package.
  "$schema": "https://unpkg.com/u8cli/schema.json",
  "name": "acme",

  // Bottom layer of the env merge: workspace -> app -> subapp, over the daemon's env.
  "env": { "NODE_ENV": "development" },

  "templates": {
    "app": "{app@name:max(20):pad(20)} {app@dirname:dim} {git@branch:color(yellow):max(18)} {git@dirty:color(red)}",
    // status/health are padded: without colour they render as words, not a glyph.
    "subapp": "  {app@status:pad(8)} {app@name:max(16):pad(16)} {health@status:pad(9)} {app@uptime:dim:pad(5)} {x@port:dim}"
  },

  // Local file (jiti loads .ts) or an npm package from this workspace's node_modules.
  "plugins": ["./plugins/ports.ts"],
  // "builtins": { "git": false },   // turn a built-in off

  "limits": { "taskConcurrency": 4, "readyTimeout": 60000, "daemonIdle": 600000 },

  // {x@port}: a shell command polled per target, in that target's cwd.
  "indicators": {
    "port": { "cmd": "printf '%s' \"${PORT:--}\"", "interval": 30000 }
  },

  "apps": {
    // No "subapps" -> one implicit subapp, addressed as "db".
    "db": {
      "path": "./services/infra",              // relative to this file
      "scripts": { "start": "docker compose up postgres" },
      "health": { "cmd": "pg_isready -q -h localhost", "interval": 2000 },
      "restart": "on-crash"                    // 1s,2s,4s,8s,16s,30s… then give up after 10
    },

    "api": {
      "path": "~/Work/acme/api",               // ~ expands
      "env": { "PORT": "3000" },               // over the workspace env
      "scripts": {
        "start": "pnpm dev",
        "test": "pnpm test"                    // inert until a command reads it
      },
      "health": { "http": "http://localhost:3000/healthz" },
      "dependsOn": ["db"]                      // waits for db to probe healthy
    },

    // Monorepo: the app is not runnable; each subapp is.
    "platform": {
      "path": "~/Work/acme/platform",
      "env": { "TZ": "UTC" },                  // inherited by both subapps
      "scripts": { "start": "pnpm dev" },      // default; auth-mfe overrides it
      "subapps": {
        "shell": {
          "path": "apps/shell",                // relative to the app's path
          "env": { "PORT": "3100" },
          "health": { "http": "http://localhost:3100/healthz" }
        },
        "auth-mfe": {
          "path": "apps/auth-mfe",
          "env": { "PORT": "3101" },
          "scripts": { "start": "pnpm dev --port 3101" },
          "health": { "http": "http://localhost:3101/healthz" },
          "dependsOn": ["api"],                // "api" = that app's implicit subapp
          "readyTimeout": 90000
        }
      }
    }
  },

  "profiles": {
    "full":     { "default": true, "targets": ["db", "api", "platform"] },
    "frontend": { "targets": ["platform.shell", "platform.auth-mfe"] }
  },

  "commands": {
    // Bare name: "app" and every plugin name are reserved namespaces.
    "test": {
      "description": "Run each service's test suite",
      "script": "pnpm test",                   // every target that has no override
      "targets": {
        "api": "pnpm test --run",              // per-target override
        "db": null                             // explicit skip
      }
    },
    "deploy": {
      "concurrency": 1,                        // beats --concurrency; --serial still wins
      "targets": { "api": "./scripts/deploy.sh", "platform.shell": "pnpm deploy" },
      "hooks": {
        "pre": "git diff --quiet || exit 1",   // non-zero aborts THIS target only
        "post": "echo deploy finished"         // always runs, even after a failure
      }
    }
  }
}
```

Run `u8 init` for a commented skeleton of this in your own workspace.
