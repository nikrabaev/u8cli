# `u8.jsonc` reference

A workspace is a directory holding `u8.jsonc`. `u8` finds it by walking upward from the current
directory (git-style) and resolves the result through symlinks — the real path is what identifies the
workspace, so two routes to the same file always reach the same daemon.

The format is JSONC: `//` and `/* */` comments and trailing commas are allowed. Unknown keys are
rejected everywhere, so a typo is an error at load rather than a setting that silently does nothing.

```jsonc
{
  "$schema": "https://unpkg.com/u8cli/schema.json",
  "repos": { "web": { "path": "~/Work/web", "scripts": { "start": "pnpm dev" } } }
}
```

`repos` is the only required key. Everything else has a default.

---

## Top level

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `$schema` | string | — | Editor completion/validation. The package ships `schema.json`. |
| `name` | string | basename of the workspace directory | Workspace label in the dashboard header and `u8 status`. |
| `env` | `{ [k: string]: string }` | `{}` | Environment for every spawned process; the bottom layer of the merge. Values may hold [`${…}` references](#references). |
| `vars` | `{ [k: string]: string }` | `{}` | Inputs for `${vars.<name>}`; overridable per repo, per app and per instance. |
| `instances` | object | see [Instances](#instances) | Where instances get their worktrees and ports from. |
| `templates` | object | see [Templates](#templates) | Row templates for repo and app rows. |
| `plugins` | `(string \| { spec, options })[]` | `[]` | npm package names, or paths (`./`, `/`, `~`) to local files — each optionally with options. |
| `builtins` | object | `git` and `health` on, `protos` off | Switches a built-in off, or configures one. |
| `limits` | object | see [Limits](#limits) | Log rotation, timeouts, concurrency, daemon idle exit. |
| `indicators` | `{ [name: string]: IndicatorDef }` | `{}` | Your own [indicators](#indicators), rendered as `{name}`. |
| `repos` | `{ [name: string]: Repo }` | **required** | The repos u8 manages. |
| `profiles` | `{ [name: string]: Profile }` | a synthesized `all` | Named selections of targets. |
| `commands` | `{ [name: string]: Command }` | `{}` | Extra commands, plus hooks. |

Repo, app and profile names must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` — no `.`, `:` or `@`, because
those are the separators for target ids (`repo.app`, `repo.app@instance`), command namespaces
(`git:pull`) and indicators (`{git@branch}`). Command and indicator names may additionally contain `.`
(`db.migrate`).

---

## Repos and apps

### Repo

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `path` | string | **yes** | — | Absolute, `~`-prefixed, or relative to the workspace directory. |
| `apps` | `{ [name: string]: App }` | no | — | Omit for a single-service repo; see below. |
| `template` | string | no | `templates.repo` | Overrides the repo header row. |
| `env` | map | no | — | Layered over `env`; inherited by every app. |
| `vars` | map | no | — | Layered over the workspace's `vars`; inherited by every app. |
| `ports` | `{ [name: string]: int }` | no | — | [Named ports](#ports). Only on a repo **without** `apps`. |
| `instance` | object | no | — | [Lifecycle steps](#lifecycle-init-and-teardown) for an instance's checkout of this repo. Not inherited. |
| `scripts` | `{ [name: string]: string }` | no | — | Inherited by every app. |
| `health` | object | no | — | Inherited by every app. |
| `restart` | `"no" \| "on-crash"` | no | `"no"` | Inherited by every app. |
| `dependsOn` | string[] | no | `[]` | Inherited by every app. |
| `readyTimeout` | int > 0 (ms) | no | `limits.readyTimeout` | Inherited by every app. |
| `stopTimeout` | int > 0 (ms) | no | `limits.stopTimeout` | Inherited by every app. |

### App

Same keys minus `apps`, plus:

| Key | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `path` | string | no | the repo's `path` | Relative to the **repo's** path (`~` and absolute also work). |
| `ports` | `{ [name: string]: int }` | no | — | [Named ports](#ports) this app listens on. |
| `instance` | object | no | — | `init` / `teardown` steps run in this app's directory, after the repo's. |

### Implicit apps

The engine only knows apps: every process, log file, status and command target is one. A repo
declared **without** `apps` is normalized into a repo holding a single *implicit* app whose
target id is just the repo name, taking its `path`, `scripts`, `env`, `health`, `restart`,
`dependsOn` and timeouts from the repo entry.

```jsonc
"api": { "path": "./services/api", "scripts": { "start": "node server.js" } }
// → one target, addressed as "api"
```

A repo **with** `apps` is not runnable itself; each app is a target named `repo.app`.

### Repo-level fields are defaults, not shared values

When a repo declares `apps`, the repo-level `scripts`, `env`, `health`, `restart`, `dependsOn`,
`readyTimeout` and `stopTimeout` become per-app defaults:

- `scripts`, `env` and `vars` are **merged key by key** (repo first, app second — an app overrides
  only the keys it names).
- `health`, `restart`, `readyTimeout`, `stopTimeout` are **replaced wholesale** when the app sets
  them. In particular an app's `health` never inherits the repo's `interval`/`threshold`: `http` and
  `cmd` are mutually exclusive, so merging two checks would produce an invalid one.
- `dependsOn` is replaced wholesale too. A repo-level `dependsOn` is resolved once and applied to
  every app that does not declare its own.

### Env merge order

Deepest wins, over the daemon's own environment:

```text
process env of the daemon  →  workspace env  →  repo env  →  app env
```

The daemon's environment is applied at spawn time, so `PATH` and friends are always present. u8 does
**not** read `.env` files.

### Ports

A port an app listens on is declared once, by name, and referenced everywhere else:

```jsonc
"api": {
  "path": "./services/api",
  "ports": { "http": 3000, "debug": 9229 },
  "env": { "PORT": "${ports.http}" },
  "scripts": { "start": "node server.js" },            // reads $PORT, like any shell would
  "health": { "http": "http://localhost:${ports.http}/healthz" }
}
```

The number written is the one the **base** instance uses. Every other [instance](#instances) is
allocated its own from `instances.ports`, which is the reason to declare a port rather than type it
into `env`, the start script and the health URL: the three then move together.

- A port belongs to one process. `ports` on a repo that has `apps` is an error — declare it on the
  app that listens on it.
- Two base apps declaring the same number is a warning, not an error: apps that are never run
  together may share one on purpose.
- The first declared port is the app's primary one: `{app@port}` and `{app@url}` show it.

### References

`env` values and `health.http` may contain `${…}` references, resolved when the config is loaded —
separately for each app, and for each instance of it.

| Reference | Value |
| --- | --- |
| `${ports.<name>}` | This app's own port |
| `${<target>.ports.<name>}` | Another app's port: `${api.ports.http}`, `${platform.shell.ports.http}` |
| `${vars.<name>}` | A var, merged workspace → repo → app → instance |
| `${instance.name}` | `base`, or the instance's name |
| `${instance.slug}` | The name lowercased with everything but letters and digits as `_` |
| `${instance.suffix}` | Empty in base, `_<slug>` elsewhere — for names that must differ per instance |
| `${workspace.name}` / `${workspace.root}` | The workspace's name and directory |
| `${repo.name}` / `${repo.path}` | The repo's name, and the root of **this instance's** checkout |
| `${base.path}` | The root of the base checkout of the same repo |
| `${app.id}` / `${app.name}` / `${app.path}` | The app's qualified id, name and working directory |

Rules worth knowing:

- **Only where there is no shell.** Scripts, `health.cmd`, hooks and indicator commands are handed to
  `$SHELL -c` untouched and read what they need from the environment — so a config never has two
  layers of `$` expansion in one string. Put the value in `env` and use `$NAME` in the script.
- **`$${` is a literal `${`.** Every other `$` is literal already (`$PATH`, `a$b`).
- **A reference to another app follows the instance.** `${api.ports.http}` written on `web` is base's
  api in base. In an instance that has its own api it is that one; in an instance that does not, it is
  base's. That single rule is what lets an instance hold only the apps being worked on.
- **A repo name is only a target when it has one app.** `${platform.ports.http}` is an error that
  lists the apps to choose from.
- **A bad reference is a config error**, reported at the line that wrote it — including `${HOME}`,
  since values are not shell-expanded.

### Path resolution

| Written on | Resolved against |
| --- | --- |
| `repos.<repo>.path` | the workspace directory (the one holding `u8.jsonc`) |
| `repos.<repo>.apps.<app>.path` | that repo's resolved `path` |
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
target strings used everywhere: a repo name expands to all of its apps, `repo.app` names one.
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
| `targets` | string[] | **yes** | Repo names and/or `repo.app` ids. A repo expands to all its apps; duplicates are dropped, config order is kept. |
| `default` | boolean | no | At most one profile may set it — two is a validation error. |

Rules:

- Declare no profiles at all and u8 synthesizes one named **`all`**, marked default, covering every
  repo in config order.
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
| `targets` | `{ [target: string]: string \| null }` | `{}` | Per-target override, or `null` to skip. Keys may be repo names (applies to all their apps) or `repo.app`. |
| `concurrency` | int > 0 | `limits.taskConcurrency` | Cap for this command. |
| `hooks` | `{ pre?: string \| string[], post?: string \| string[] }` | — | Shell hooks; see below. |

### Target resolution

For each selected target, in this order:

1. an entry in `targets` for that exact `repo.app` id → that script (or a skip if `null`);
2. an entry in `targets` for its repo name → that script (or a skip if `null`);
3. otherwise the shared `script`;
4. no shared `script` either → a skip.

An explicit `repo.app` entry always beats a repo-wide one, whatever order they were written in.
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

The three core commands always exist. Their per-target script comes from the app's
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

## Indicators

Config-defined indicators are declared once at workspace level and evaluated **per owner, in that
owner's working directory**. Trimmed stdout is the value.

```jsonc
"indicators": {
  "version": { "cmd": "jq -r .version package.json", "interval": 60000 },
  "size":    { "cmd": "du -sh . | cut -f1", "scope": "repo" }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `cmd` | string | **required** | Shell command; trimmed stdout is the value. |
| `interval` | int > 0 (ms) | `5000` | Poll interval. |
| `scope` | `"app" \| "repo"` | `"app"` | Run once per app (in its cwd) or once per repo (in the repo root). |

They render by bare name — `{version}`, `{size}`. Having no namespace is what marks a token as one
of yours: everything from core (`{app@status}`) or a plugin (`{git@branch}`) carries one, so the two
can never collide and no name is reserved for config indicators. A key containing `@` or `:` is a
validation error, and a bare token that matches nothing declared here renders as `{versoin!}` in red
and is reported as a warning in the daemon log.

A `scope: "app"` probe gets the target's merged `env` on top of the daemon's; a `scope: "repo"`
probe gets only the daemon's, because a repo has no env of its own. Read what you need from the
filesystem rather than from `$PORT` in a repo-scoped probe.

A probe is killed at 80% of its own interval (clamped to 100 ms–5 s), so a slow command can never
pile up. A failing or killed probe yields an **empty** cell and a warning in the daemon log, never a
stale value. Values are sanitized before they are cached: ANSI escapes and control characters are
stripped, whitespace runs collapse to one space, and the result is capped at 200 characters.

---

## Templates

A row is literal text plus tokens — `{ns@indicator}` for a core or plugin indicator, a bare
`{indicator}` for one declared under [`indicators`](#indicators) — with optional `:`-chained modifiers.

```jsonc
"templates": {
  "repo": "{repo@name:max(24):pad(24)} {repo@dirname:dim} {git@branch:color(yellow):max(20)} {git@dirty:color(red)}",
  "app":  "  {app@status:pad(8)} {app@name:max(22):pad(22)} {health@status:pad(9)}"
}
```

Those two strings are also the defaults. `templates.repo` renders a repo header row and
`templates.app` each child row; any repo or app may override its own with a `template` key. A repo
with exactly one app renders as a **single merged row** using the app template.

Each row has its own core namespace: an app row is written with `{app@…}`, a repo header row with
`{repo@…}`. An app row falls back to its repo's cells for a token the app does not have, which is
what lets a merged row mention the repo-scoped `{git@branch}` or `{repo@dirname}`. The fallback runs
one way only: a header row stands for several apps, so `{app@status}` there names nothing — it
renders as `{app@status!}` and is reported as a config warning. Use `{repo@status}`.

Which string a row uses:

| Row | Template |
| --- | --- |
| Header row of a multi-app repo | that repo's `template`, else `templates.repo` |
| Child row | that app's `template`, else `templates.app` |
| Merged row of a single-app repo | the app's `template`, else the **repo's** `template`, else `templates.app` |

So a repo-level `template` on a single-service repo is what its merged row uses, and on a monorepo it
is the header row instead — it never leaks into child rows.

### Grammar

```text
{ns@name}                 {ns@name:mod}            {ns@name:mod(arg):mod}
{name}                    {name:mod}               {name:mod(arg):mod}
```

A token spells a name exactly as it was declared. An indicator is named like a command — letters,
digits, `.`, `_` and `-`, starting with a letter or digit — so `{db.version}` and `{protos@chart.js}`
are tokens; a namespace is a plugin's name, which has no dots. A token with no `@` is an indicator
declared in this config; one from core or a plugin always carries its namespace, so `{status}` is
never short for `{app@status}`. `{{` and `}}` escape a literal brace, and that includes braces around
a number: `{0}` is a token like any other.

Parsing never throws, so a template typo degrades rather than breaking the dashboard — but the two
kinds of typo look different:

- A **malformed head** (`{app@nam e}`) is rendered as the literal text you typed.
- A **malformed modifier** (`{app@name:pad(x)}`) is dropped and the token renders unmodified.
- A **well-formed** token naming an indicator that does not exist (`{git@brunch}`, or a bare
  `{versoin}` with no such key under `indicators`) renders as `{git@brunch!}` / `{versoin!}` in red.

Each of them is also a warning in the daemon log (`u8 daemon logs`), written when the daemon starts
and again on every config reload.

```console
$ u8 status          # templates.app = "  {app@nam e} | {app@name:pad(x)} | {git@brunch} | {{lit}} | {app@name}"
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

There are no conditionals or expressions. Anything conditional belongs in a config indicator or a
plugin.

### Available indicators

| Token | Scope | Value |
| --- | --- | --- |
| `{app@name}` | app | App name; the repo name for an implicit app |
| `{app@dirname}` | app | Basename of the working directory |
| `{app@path}` | app | Absolute working directory |
| `{app@status}` | app | `stopped`, `starting`, `running`, `crashed`, `stopping`, `stale`. Renders as `●`. |
| `{app@pid}` | app | Process id while up, else empty |
| `{app@uptime}` | app | `12s`, `4m`, `1h3m`, `2d5h`; empty unless running |
| `{app@exitcode}` | app | Exit code of the last finished run |
| `{app@port}` | app | The app's first declared port, as this instance has it; empty without one |
| `{app@ports}` | app | Every declared port as `name:number` |
| `{app@url}` | app | `http://localhost:<port>` on the first declared port |
| `{app@instance}` | app | `base`, or the instance this copy runs in |
| `{repo@name}` | repo | Repo name, as the config spells it (no instance suffix) |
| `{repo@instance}` | repo | `base`, or the instance this checkout belongs to |
| `{repo@dirname}` | repo | Basename of the repo root |
| `{repo@path}` | repo | Absolute repo root |
| `{repo@status}` | repo | The worst state among the repo's apps: `crashed` if any crashed, `running` only when all run. Renders as `●`. |
| `{git@branch}` | repo | Branch, or short sha when detached; empty outside a repo |
| `{git@dirty}` | repo | Changed-file count including untracked; empty when clean |
| `{git@ahead}` / `{git@behind}` | repo | Commits vs upstream; empty when zero or no upstream |
| `{health@status}` | app | `healthy`, `unhealthy`, `starting`, `n/a` |
| `{protos@<alias>}` / `{protos@linked}` | app | Shared-package versions, once [protos](#protos) is configured |
| `{<name>}` | as declared | Your config-defined [indicators](#indicators) |
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
| `stopTimeout` | int > 0 (ms) | `10000` | SIGTERM → SIGKILL grace when stopping a process group. Overridable per repo/app. |
| `readyTimeout` | int > 0 (ms) | `60000` | Max wait for a dependency to become ready. Overridable per repo/app. |
| `taskConcurrency` | int > 0 | `4` | Targets running at once, unless the command or the CLI says otherwise. |
| `daemonIdle` | int > 0 (ms) | `600000` (10 min) | Idle time with no clients and no running services before the daemon exits. `U8_IDLE_MS` overrides it for a daemon it spawns; `0` there disables idle exit. |

---

## Plugins

```jsonc
"plugins": [
  "./plugins/deploy.ts",
  { "spec": "@acme/u8-plugin-k8s", "options": { "context": "staging" } }
]
```

An entry is either a **bare spec** or `{ "spec": …, "options": { … } }` — the same spec, plus
settings for that plugin. Any other key in the object is rejected (`plugins[0]: Unrecognized key:
"opts"`), and so is anything that is neither string nor object (`expected a package name or path, or
{ "spec": "…", "options": { … } }`).

A spec starting with `.`, `/` or `~` is a path resolved against the workspace directory (a missing
extension is tried as `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`); anything else is an npm package resolved
from the **workspace's own** `node_modules`. Load order is built-ins first, then this list in order —
and load order is the order hooks run in.

`options` are passed to the plugin **verbatim**: u8 validates only that they form an object, because
what the keys mean belongs to the plugin. A plugin that takes options exports a *factory* — a
function from options to a definition — and giving options to a plugin that exports a plain
definition object is an error rather than a silent no-op, because a setting that looks applied and
is not is the hardest kind of config bug to see. See
[PLUGINS.md](PLUGINS.md#configuration-the-factory-export).

A plugin that fails to load is **disabled**, not fatal: `u8 status` prints a warning on stderr, the
dashboard shows it, and `u8 status --json` reports it under `plugins[].error`. See
[PLUGINS.md](PLUGINS.md).

### Built-ins

`builtins` switches a built-in plugin off — and, for one that takes configuration, is where it is
configured:

```jsonc
"builtins": {
  "health": false,
  "protos": { "packages": ["@myorg/protos", "@myorg/react-query"] }
}
```

| Built-in | Accepts | Default | Registers |
| --- | --- | --- | --- |
| `git` | `true` / `false` | `true` | `{git@branch}`, `{git@dirty}`, `{git@ahead}`, `{git@behind}`, `git:fetch`, `git:pull` |
| `health` | `true` / `false` | `true` | `{health@status}`, the `dependsOn` readiness signal |
| `protos` | `false`, or an options object | **off** | Nothing until configured; see [protos](#protos) |

`git` and `health` are on because they cost nothing until a workspace has a checkout or a
healthcheck. `protos` is the exception: it has nothing to do until it is told which packages are
shared, so it stays off — and enabling it *is* configuring it.

Every way of getting that wrong is a load error rather than a setting that quietly does nothing — and
an invalid config keeps the last-good one in service:

| Written | Error |
| --- | --- |
| `"git": {}` (any object) | `the "git" built-in takes no options: use true or false` — same for `health` |
| `"protos": true` | `the protos built-in has nothing to link until it is told which packages are shared: replace true with { "packages": ["@myorg/protos"] }` |
| `"protos": {}` | `the protos built-in needs "packages": the shared packages it links, e.g. ["@myorg/protos"]` |
| `"protos": { "packages": [] }` | `"packages" must name at least one shared package, e.g. ["@myorg/protos"]` |
| the same package twice | `duplicate package "@myorg/protos"`, pointed at the entry to delete |
| `"packages": ["./protos"]` | `invalid shared package name: expected "name" or "@scope/name"` |
| any other key in the object | `Unrecognized key: "watch"` |
| `"protos": "yes"` | `expected false, or options like { "packages": ["@myorg/protos"] }` |

```console
$ u8 status
invalid workspace config (/Users/me/work/acme/u8.jsonc)
  • builtins.protos: the protos built-in has nothing to link until it is told which packages are shared: replace true with { "packages": ["@myorg/protos"] }
```

`"protos": false` and leaving it out are the same thing: off, registering nothing — no commands, no
indicators, nothing polled.

---

## protos

A shared-contracts repo — `.proto` files that build into packages like `@myorg/protos` and
`@myorg/react-query` — is consumed by most of the apps around it. The local loop when a contract
changes is: edit the protos, build them, `yalc publish`, then `yalc add` the package in each consumer
that needs the new version.

The `protos` built-in owns **that last step and the visibility around it**: commands that link and
unlink, and indicators showing which version each app is actually on. Consumers are detected from
each app's own `package.json`, so nothing has to be listed twice.

```jsonc
"builtins": {
  "protos": {
    "packages": ["@myorg/protos", "@myorg/react-query"],
    "interval": 10000
  }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `packages` | string[] | **required** | The shared package names, `name` or `@scope/name`. At least one, no duplicates. |
| `interval` | int > 0 (ms) | `10000` | How often the installed/linked versions are re-read. |

### Link and unlink only

u8 drives `yalc` and nothing else. It never builds the shared repo, never runs `yalc publish`, never
watches for changes and never runs an install — those are yours, and a dashboard that ran them
uninvited would be guessing at your package manager and your build.

Two consequences worth knowing before the first run:

- **`yalc add` fails if the package was never published.** The link comes from yalc's store, which
  `yalc publish` fills. u8 says so when it happens: the failure reads `yalc add failed — is the
  package built and "yalc publish"ed? Do that in the shared-contracts repo, then link again. yalc
  said: …`, with yalc's own words after the advice — a failed target is shown as a single ~80-column
  cell, so the half worth that budget is the half that says what to do next.
- **Unlinking does not reinstall `node_modules`.** `yalc remove` restores the dependency range in
  `package.json`, but the directory still holds the linked copy — so the code that runs is still the
  local build until you run your own package manager's install. The command logs a line per package
  saying exactly that; it does not run the install for you.

`yalc` itself is yours too: it is not bundled, and a machine without it gets `yalc is not on PATH —
install it ("npm i -g yalc"), then "u8 daemon stop". A running daemon keeps the PATH it started
with, so a fresh install stays invisible to it until it restarts.` rather than a bare ENOENT.

That second sentence is the part people need: the daemon runs these commands and inherits its `PATH`
once, when it is spawned. Install `yalc` and re-run without restarting and you get the same error
back while `which yalc` succeeds in your shell — so `u8 daemon stop` (the next command starts a fresh
daemon) is half the fix, not a footnote.

### Commands it registers

`u8 run <command> [targets…]` spends its trailing arguments on **targets**, so a command can never
take a package name — which is why each configured package gets its own command at load, named after
the package:

| Command | Acts on |
| --- | --- |
| `protos:link` | every configured package the target consumes |
| `protos:unlink` | every configured package currently linked in the target |
| `protos:link:<alias>` | that one package |
| `protos:unlink:<alias>` | that one package |

The alias is the package's last segment — `@myorg/react-query` → `react-query`, so
`u8 run protos:link:react-query platform.shell`. Where that would be ambiguous, the whole name is
flattened instead: configure `@myorg/protos` and `@other/protos` and you get `myorg-protos` and
`other-protos`. The same fallback covers a segment that would collide with the `linked` indicator or
that is not a legal command name. Aliases are derived in config order, so a given config always
produces the same command names.

Selection is the usual one: the targets you name, or the active profile if you name none. Within
that selection, a target is **skipped** — reported, not failed — when it has nothing to do:
`protos:link` skips an app whose `package.json` does not depend on any configured package, and
`protos:unlink` skips one with no link in place. Each app is linked separately, even two apps
of the same repo: they have their own `node_modules` and their own `.yalc`.

```console
$ u8 run protos:link
- db                skipped — command "protos:link" does not apply to this target
✓ api               ok 301ms
✓ platform.shell    ok 296ms
✓ platform.auth-mfe ok 296ms
```

A run links every package it can and fails at the end with the ones it could not, rather than
stopping at the first — a partial link is a state you can finish by hand. The one exception is a
missing `yalc`: there is nothing to retry, so the target fails immediately without attempting the
rest. Each `yalc` invocation is echoed into the target's run log with its output
(`u8 logs <target> --run <runId>`).

### Indicators

| Token | Scope | Value |
| --- | --- | --- |
| `{protos@<alias>}` | app | What that package effectively is here — one per configured package |
| `{protos@linked}` | app | `2 local` when two packages are linked here; empty when none are |

Each cell has four states, read from the app's own `package.json`, `.yalc/` and `node_modules/` —
never from a shell command, so the poll is cheap:

| State | Renders | Meaning |
| --- | --- | --- |
| absent | empty | This app does not depend on the package |
| linked | `1.4.2 local` (yellow) | A yalc link is in place: the version is the local build's own |
| installed | `1.4.2` (green) | The published copy in `node_modules` |
| declared | `^1.4.0` (dim) | Depended on, but nothing installed yet — the range from `package.json` |

Add them to a row like any other token:

```jsonc
"templates": {
  "app": "  {app@status:pad(8)} {app@name:max(16):pad(16)} {protos@protos:pad(12)} {protos@react-query:pad(12)} {protos@linked:pad(8)}"
}
```

```console
$ u8 status
u8-demo · profile full · 0/4 running
  stopped  db
  stopped  api              1.4.2 local  2.0.1        1 local
platform             platform
  stopped  shell            ^1.4.0
  stopped  auth-mfe                      2.0.0
```

All four states in one screen: `db` consumes neither package, `api` is on a local build of one and
the published copy of the other, `shell` declares `@myorg/protos` with nothing installed yet, and
`auth-mfe` has `@myorg/react-query` as a `devDependency`.

The details that decide which state you see:

- A dependency counts from `dependencies`, `devDependencies` or `peerDependencies` — the first of
  those it appears in.
- **Linked** needs both halves of what `yalc add` does: the `file:.yalc/…` range in `package.json`
  *and* the `.yalc/<pkg>` directory. Either alone is a leftover, and the cell falls back to whatever
  is really installed. A linked copy whose own version cannot be read renders as bare `local`.
- The app's **own** `node_modules` is what is inspected, not a hoisted root: that is the tree its
  dev server resolves from.
- A directory that is not a node project, or a `package.json` caught half-written by an install,
  renders blank; the next poll picks it up.

---

## Instances

An **instance** is a parallel copy of part of the workspace: its own checkout of some repos, its own
ports, its own processes. The workspace as `u8.jsonc` describes it is the **base** instance; any
number of others can run beside it, which is what makes it possible to work on several branches —
or have several tools work on several branches — at once.

Instances are created from the command line (`u8 instance create`, `u8 up`) and changed from it
(`u8 instance add`, `u8 instance remove`), not declared in the config: which worktrees exist on a
machine is local state, like the active profile, and lives in the state dir. The config only says how
they are made:

```jsonc
"instances": {
  "dir": ".u8/worktrees",                  // worktrees go to <dir>/<instance>/<repo>
  "ports": { "from": 20000, "to": 20999 }  // every non-base port comes from here
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dir` | string | `.u8/worktrees` | Relative to the workspace directory. Add it to `.gitignore` when the workspace is itself a repo. |
| `ports.from` / `ports.to` | int | `20000` / `20999` | Inclusive. Allocation skips ports base declares, ports another instance holds, and ports in use. |

### What an instance contains

An instance is given a checkout of one or more repos and runs some or all of their apps. Its apps are
ordinary targets with the instance in their id:

| | Base | Instance `feat-x` |
| --- | --- | --- |
| Target id | `api`, `platform.shell` | `api@feat-x`, `platform.shell@feat-x` |
| Working directory | the repo's `path` | the instance's checkout of that repo |
| Ports | as declared | allocated once, kept until the app leaves the instance or the instance is destroyed |
| `env` | as written | the same document, with references resolved for the instance |

Everything else — scripts, health checks, restart policy, command entries, hooks — is the same
definition. An instance is not configured separately; it is the config, read again with different
directories and different ports.

**An instance may be partial.** One created for `platform.auth-mfe` alone has no api of its own, so
its `dependsOn: ["api"]` and its `${api.ports.http}` both point at base's api. Nothing in an instance
is ever *started* in base on its behalf: when what it leans on is not running, `u8 start` says so and
names the command that starts it.

**Commands are scoped.** A target typed inside an instance means that instance's copy, and a name
the instance has no copy of is an error rather than a fallback to base. Reaching another instance
takes an explicit `api@base` or `api@other`.

### Lifecycle: init and teardown

A fresh worktree has none of what git does not track — no `node_modules`, no `.env`. `instance` on a
repo says what to do about that, and what to undo when the instance goes away:

```jsonc
"api": {
  "path": "./services/api",
  "instance": {
    "copy": [".env", ".env.local"],              // from the base checkout, if present
    "init": ["pnpm install --frozen-lockfile"],  // in the new checkout's root
    "teardown": ["dropdb --if-exists \"app_$U8_INSTANCE\""]
  },
  "apps": {
    "server": {
      "instance": { "init": ["pnpm prisma migrate deploy"] }   // in the app's directory
    }
  }
}
```

| Key | Where | Notes |
| --- | --- | --- |
| `copy` | repo | Repo-relative files or directories copied from the base checkout before `init`. Missing in base → skipped. Already in the checkout → kept, never overwritten. |
| `init` | repo, app | A shell string or a list of them, run in order. A failing step stops the ones after it. |
| `teardown` | repo, app | Same shape. Every step runs even when one fails; a failure keeps the instance unless forced. |

Order within a repo: `copy`, the repo's `init` steps in the checkout root, then each app's `init` in
the app's directory. Teardown is the mirror image. Repos run side by side.

`u8 instance add` and `u8 instance remove` run the same steps for the apps they are about and
nobody else's — see [Adding and removing apps](#adding-and-removing-apps) for which of a repo's own
steps come with them.

Steps run as the commands `instance:init` and `instance:teardown`, through the same pipeline as any
run: per-target logs (`u8 logs <target> --run <id>`), the summary table, and plugin hooks bound to
those names. An app's steps get the app's resolved `env`; a repo's steps get the daemon's — plus the
env of the app, for a repo that is its own app. All of them additionally get:

| Variable | Value |
| --- | --- |
| `U8_INSTANCE` | The instance's name |
| `U8_REPO` / `U8_REPO_PATH` | The repo's name, and the root of this instance's checkout |
| `U8_BASE_PATH` | The root of the base checkout of the same repo |
| `U8_WORKSPACE_ROOT` | The workspace directory |
| `U8_TARGET` / `U8_APP` | App steps only: the app's qualified id and its name |

When a checkout is already gone at teardown — the tool that made the worktree removed it — the steps
run from the base checkout instead, with the instance's environment: what teardown undoes is usually
outside the checkout anyway.

### Checkouts: created or adopted

- **Created.** `u8 instance create <name> [targets…]` adds a git worktree per repository on a branch
  named after the instance (`--branch` to choose; `--from` for where a new branch starts). Repos that
  live in the same git repository share one worktree. `u8 instance destroy` removes these worktrees.
  A branch u8 created goes with them only if nothing was committed to it; a branch that existed
  before, or that has commits of its own, is never deleted.
- **Adopted.** `u8 up` typed inside a worktree some other tool made (`--adopt <dir>` on
  `instance create`) uses that directory as it is. u8 never removes an adopted checkout — and once
  every checkout of an adopted instance has disappeared, the daemon stops its services, runs its
  teardown and frees its ports on its own.

### Adding and removing apps

What an instance runs is not fixed when it is created. Both commands act on the instance the current
directory belongs to (`-i <name>` for another) and take targets named the way the config names them —
`api`, `platform.shell`, or a repo for all of its apps. Base cannot be changed this way: what it runs
is what `u8.jsonc` declares.

```bash
u8 instance add api                  # this instance gets its own api
u8 instance remove platform.shell    # and stops running its own shell
```

**`u8 instance add <targets…>`** allocates ports for each new app, then runs the init steps of what
was added — never the whole instance's again. What that covers depends on what the instance already
has of the app's repo:

| The instance… | Checkout | Steps that run |
| --- | --- | --- |
| already runs another app of the repo | the one it has | the new app's `init` |
| has no checkout of the repo | a new worktree — or the directory given with `--adopt <dir>` / `--path <repo=dir>` | the repo's `copy` and `init`, then the app's `init` |
| kept the repo's checkout after its last app left | the one it kept | the repo's `copy` and `init`, then the app's `init` |

A new worktree goes on the branch the instance's other worktrees are on — its name, unless it was
created with `--branch` — and `--branch` / `--from` choose otherwise. A repo that lives in the same
git repository as one the instance already has a worktree of is put into that worktree. If anything
fails before the steps start, the worktrees it made are removed again and the instance is exactly as
it was. If an init step fails, the app is in the instance but the instance reads *not initialised*
until `u8 instance init` has been through.

**`u8 instance remove <targets…>`** stops the apps, runs their `teardown` steps, frees their ports
and drops them from the instance. A repo's own `teardown` runs when the last of its apps leaves, since
that is what undoes the repo's `init`. A failing step keeps the apps unless `--force`. The last app of
an instance cannot be removed: that is `u8 instance destroy`.

What happens to the checkout of a repo left with no apps:

| | Worktree u8 created | Adopted checkout |
| --- | --- | --- |
| `remove` | Kept: still the instance's, reused by a later `add`, removed by `destroy` | Kept in the instance |
| `remove --prune` | Removed if git reports no modified or untracked files; otherwise the command refuses before anything is stopped | Forgotten; the directory is never touched |
| `remove --prune --discard` | Removed with whatever is uncommitted in it | Forgotten; the directory is never touched |

A worktree shared with a repo whose apps still run stays where it is. A branch u8 created goes with
its worktree only if nothing was committed to it, as on `destroy`. `u8 instance remove <repo> --prune`
also works later, on a checkout an earlier `remove` kept.

**Membership changes rewire the neighbours.** References and `dependsOn` point at the instance's own
copy when it has one and at base's otherwise, so an instance that gains an api has its web pointed
at that api, and one that loses it has its web pointed back at base's. Running processes are never
touched: they keep what they were started with, show as `stale`, and both commands name them and the
restart that picks the change up.

One `add` or `remove` runs per instance at a time, and none while the instance's own init is running:
a second is refused until the first run's steps have finished. While an `add` is running its steps the
instance reads *not initialised*, as a new one does.

---

## Config reload

The daemon watches `u8.jsonc` (a directory watch plus a stat poll, so editor rename-on-save is
caught) and re-validates on change.

- Templates, indicators, commands, profiles and the plugin list are **hot-applied**. The plugin host
  is only rebuilt when the set of plugins it was built from changed — the `plugins` entries, the
  `builtins` toggles, or any plugin's `options`. Options count because a plugin is *built* from them:
  adding a package to `builtins.protos` rebuilds `protos` so the new commands and indicators exist.
- **Running processes are never touched.** They keep their spawn-time definition; if the effective
  script, cwd or env changed, the target's status becomes `stale` and the change takes effect on the
  next restart.
- **Instances follow the config.** They are re-read with it: an app that gains a port is allocated one
  in every instance that runs it, and a repo or app the config drops disappears from them too.
- An invalid config keeps the last-good one in service. The error is surfaced in the dashboard header
  and on stderr from `u8 status`, and in `configError` in `u8 status --json`.

---

## Complete annotated example

```jsonc
{
  // Editor completion. Ships with the u8cli package.
  "$schema": "https://unpkg.com/u8cli/schema.json",
  "name": "acme",

  // Bottom layer of the env merge: workspace -> repo -> app, over the daemon's env.
  "env": { "NODE_ENV": "development" },

  "templates": {
    "repo": "{repo@name:max(20):pad(20)} {repo@dirname:dim} {git@branch:color(yellow):max(18)} {git@dirty:color(red)}",
    // status/health are padded: without colour they render as words, not a glyph.
    "app": "  {app@status:pad(8)} {app@name:max(16):pad(16)} {health@status:pad(9)} {app@uptime:dim:pad(5)} {port:dim}"
  },

  // Local file (jiti loads .ts) or an npm package from this workspace's node_modules.
  // An entry may also be { "spec": …, "options": { … } }; the options reach the
  // plugin's factory export verbatim.
  "plugins": ["./plugins/ports.ts"],

  "builtins": {
    // "git": false,                          // turn a built-in off
    // protos is off until configured: this enables protos:link / protos:unlink
    // and a {protos@…} cell per package.
    "protos": { "packages": ["@myorg/protos", "@myorg/react-query"] }
  },

  "limits": { "taskConcurrency": 4, "readyTimeout": 60000, "daemonIdle": 600000 },

  // Instances other than base: where their worktrees go, and where their ports come from.
  "instances": { "dir": ".u8/worktrees", "ports": { "from": 20000, "to": 20999 } },

  // {port}: a shell command polled per target, in that target's cwd.
  "indicators": {
    "port": { "cmd": "printf '%s' \"${PORT:--}\"", "interval": 30000 }
  },

  "repos": {
    // No "apps" -> one implicit app, addressed as "db".
    "db": {
      "path": "./services/infra",              // relative to this file
      "scripts": { "start": "docker compose up postgres" },
      "health": { "cmd": "pg_isready -q -h localhost", "interval": 2000 },
      "restart": "on-crash"                    // 1s,2s,4s,8s,16s,30s… then give up after 10
    },

    "api": {
      "path": "~/Work/acme/api",               // ~ expands
      "ports": { "http": 3000 },               // base's port; instances get their own
      "env": {
        "PORT": "${ports.http}",               // over the workspace env
        "DATABASE_NAME": "acme${instance.suffix}"   // "acme" in base, "acme_feat_x" in feat-x
      },
      "scripts": {
        "start": "pnpm dev",                   // reads $PORT; scripts are never interpolated
        "test": "pnpm test"                    // inert until a command reads it
      },
      "health": { "http": "http://localhost:${ports.http}/healthz" },
      "dependsOn": ["db"],                     // waits for db to probe healthy
      "instance": {
        "copy": [".env.local"],                // what git does not carry into a worktree
        "init": ["pnpm install --frozen-lockfile", "createdb \"$DATABASE_NAME\" || true"],
        "teardown": ["dropdb --if-exists \"$DATABASE_NAME\""]
      }
    },

    // Monorepo: the repo is not runnable; each app is.
    "platform": {
      "path": "~/Work/acme/platform",
      "env": { "TZ": "UTC" },                  // inherited by both apps
      "scripts": { "start": "pnpm dev" },      // default; auth-mfe overrides it
      "apps": {
        "shell": {
          "path": "apps/shell",                // relative to the repo's path
          "ports": { "http": 3100 },
          "env": { "PORT": "${ports.http}" },
          "health": { "http": "http://localhost:${ports.http}/healthz" }
        },
        "auth-mfe": {
          "path": "apps/auth-mfe",
          "ports": { "http": 3101 },
          // Another app's port: the instance's own api when it has one, base's otherwise.
          "env": { "PORT": "${ports.http}", "API_URL": "http://localhost:${api.ports.http}" },
          "scripts": { "start": "pnpm dev --port \"$PORT\"" },
          "health": { "http": "http://localhost:${ports.http}/healthz" },
          "dependsOn": ["api"],                // "api" = that repo's implicit app
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
    // Bare name: "app", "repo" and every plugin name are reserved namespaces.
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
