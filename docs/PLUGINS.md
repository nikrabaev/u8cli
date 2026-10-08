# Writing a u8 plugin

A plugin is a module that contributes **indicators**, **commands**, **hooks** and a **readiness**
signal to one workspace. Plugins are loaded into the daemon and run inside it — the vite model:
trusted code, no sandbox, full access to the machine.

`git`, `health` and `protos` are built-in plugins; everything below is how they are written.

```jsonc
// u8.jsonc
"plugins": ["./plugins/ports.ts", { "spec": "@acme/u8-plugin-k8s", "options": { "context": "staging" } }]
```

---

## The module shape

```ts
import { definePlugin } from "u8cli/plugin";

export default definePlugin({
  name: "ports",          // required — also the namespace: ports:check, {ports@open}
  indicators: { … },      // optional
  commands:   { … },      // optional
  hooks:      { … },      // optional
  readiness(ctx) { … },   // optional
  setup(ctx)    { … },    // optional
  teardown()    { … },    // optional
});
```

`definePlugin` is an identity function that pins the types; the shape is what matters, so a plain
object works too — and that is the portable form, because importing it requires `u8cli` to be
installed in the workspace (see [Resolution](#resolution)). The definition may be the default export,
the module itself, or a transpiled CommonJS `exports.default` — all three are unwrapped.

`name` must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` and may not be `app` or `repo` (reserved for the
core commands and indicators). Two plugins claiming the same name is an error for the second one.

### Configuration: the factory export

A plugin that needs no configuration exports a definition object, as above. A plugin that **does**
exports a **factory** instead: a function from its options to a definition.

```jsonc
// u8.jsonc — a bare string is "no options"; the object form carries them
"plugins": [
  "./plugins/ports.ts",
  { "spec": "@acme/u8-plugin-k8s", "options": { "context": "staging", "namespace": "acme" } }
]
```

```ts
// @acme/u8-plugin-k8s
import { definePlugin } from "u8cli/plugin";

export default (options: { context?: string; namespace?: string }) => {
  if (options.context === undefined) throw new Error('"context" is required');
  return definePlugin({
    name: "k8s",
    indicators: { … },
    commands: { … },
  });
};
```

What `u8.jsonc` wrote under `options` reaches the factory **verbatim**. Config validation only checks
that it is an object: the keys mean whatever your plugin says they mean, and u8 knowing every
plugin's schema is not a thing worth building. So validate them yourself and throw — the throw
disables the plugin carrying *your* message, which is the point of doing it there.

Three export shapes count as a factory:

| Shape | Use it when |
| --- | --- |
| `export default (options) => definePlugin({ … })` | the usual form |
| `export const createPlugin = (options) => …` | the module also wants a ready-made instance as its `default` export — what the built-in `health` does, so that importing the module directly still yields a working plugin. It is found on the module or on its default export |
| `module.exports = (options) => …` | a CommonJS plugin |

A factory listed as a bare string is called with `{}` — omitting `options` is not the same as
omitting the factory. It runs at load, between the import and `setup()`, and shares their 10 s
deadline.

Two things can go wrong, and both disable the plugin rather than the daemon:

- **The factory throws.** Reported as `creating it from its options failed: <your message>`.
- **Options for a plugin that has no factory.** An error, not a silent no-op — a workspace that
  configured a plugin which cannot read configuration would otherwise show every sign of having been
  configured and none of the effect:

```console
$ u8 status                 # "plugins": [{ "spec": "./plugins/ports.ts", "options": { … } }]
u8-demo · profile full · 0/4 running
  stopped  db               n/a              {ports@open!}
  …
plugin "ports" is disabled: plugin "./plugins/ports.ts": options were configured for it, but it exports a plugin definition rather than a factory — export a function taking its options (export default (options) => definePlugin({ ... })), or remove the options from u8.jsonc
```

The plugin is gone, so its tokens render as the red `{ports@open!}` marker — the same as any unknown
indicator.

The built-in `protos` is a factory plugin configured this way; `builtins.protos` in
[CONFIG.md](CONFIG.md#protos) is where its options are written, and built-ins additionally receive
the live daemon state no config value could stand in for (`health` gets the supervisor that way).

### Resolution

| `plugins` entry | How it is found |
| --- | --- |
| `./plugins/ports.ts`, `/abs/path.js`, `~/p.mjs` | A path resolved against the workspace directory. A missing extension is tried as `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`. |
| `@acme/u8-plugin-k8s`, `u8-plugin-foo` | An npm package resolved from the **workspace's own** `node_modules` — never u8cli's. Install it where `u8.jsonc` lives. |

`.ts` (and `.mts`, `.cts`) files go through [jiti](https://github.com/unjs/jiti), so a TypeScript
plugin needs no build step, and `./neighbour.js` specifiers written the NodeNext way resolve to their
`.ts` sources. Everything else is a plain dynamic `import`.

A local plugin file's **own** imports resolve like any other Node module: from that file's directory
upward — the workspace's `node_modules`, never u8cli's. Importing `u8cli/plugin` therefore only works
where the workspace itself has `u8cli` installed (`npm i -D u8cli`); a plugin dropped into a
workspace that has no `node_modules` has to be import-free, which it can be, because a plugin may be
a plain object. Type-only imports are the exception: they are erased before the file runs, so they
cost nothing at runtime — but your editor and `tsc` still need the install to resolve them.

Load order is **built-ins first, then `plugins` in config order**, and load order is the contract: it
decides the sequence hooks run in and which readiness verdict wins.

### Failure is disabled, not fatal

A plugin that throws on import, fails validation, or throws in `setup()` is **disabled**. The rest of
the workspace runs as if it had never been listed:

```console
$ u8 status
u8-demo · profile full · 0/4 running
  stopped  db               n/a
  stopped  api              n/a
platform             platform
  stopped  shell            n/a
  stopped  auth-mfe         n/a
plugin "broken" is disabled: plugin "./plugins/broken.ts": commands.oops must define a run() function
```

```console
$ u8 status --json | jq '.plugins[] | select(.ok == false)'
{
  "name": "broken",
  "spec": "./plugins/broken.ts",
  "ok": false,
  "error": "plugin \"./plugins/broken.ts\": commands.oops must define a run() function"
}
```

Loading (import + `setup()`) has a 10 s deadline; a plugin that blows it is disabled and torn back
down if it ever finishes.

---

## The context

Every callback gets the same base, plus whatever its callsite is about:

```ts
interface PluginBaseContext {
  workspace: { id, name, rootDir, configPath };
  logger: Logger;                       // .debug/.info/.warn/.error → daemon.log
  exec(cmd, opts?): Promise<ExecResult>; // shell, pointed at the contextual cwd
  store: Map<string, unknown>;          // one per plugin, shared by every callsite
}
```

`exec` runs `cmd` through `$SHELL -c` (falling back to `/bin/sh`) in its own process group, and
resolves with `{ ok, exitCode, signal, stdout, stderr, durationMs, timedOut }`. **A non-zero exit is
data, not an exception** — it only rejects when the shell itself could not be spawned. Options:
`cwd`, `env`, `timeoutMs`, `killGraceMs`, `maxBuffer`, `input`, `shell`, `signal`.

Two details worth knowing:

- The default `cwd` is the callsite's: the workspace root in `setup`, the repo path for repo-scoped
  indicators, the target's cwd everywhere else.
- The default `env` is the callsite's too, and `exec` always layers it over the daemon's own
  environment (so `PATH` works). **In command and hook contexts, passing `env` replaces the target's
  env rather than merging with it** — spread it yourself: `{ ...ctx.target.env, MY_VAR: "1" }`.

`store` is a `Map` scoped to your plugin, the same instance in every callback, surviving across
invocations. It is how a poll indicator caches a watcher for a command to reuse; the built-in `git`
plugin keeps one `git status` monitor per repo in it.

`TargetInfo` — what a "target" looks like to a plugin:

```ts
{ id, baseId, instance, repoName, name, implicit, cwd, scripts, env, ports, dependsOn, hasHealth }
```

These are copies. Mutating `scripts` or `env` changes nothing in the daemon.

### Instances

A workspace can run several [instances](CONFIG.md#instances) of its apps side by side, and a plugin
sees each copy as a target of its own. Nothing has to be done to support that — but three fields
exist so a plugin can tell copies apart when it needs to:

| Field | Base | Instance `feat-x` |
| --- | --- | --- |
| `target.id` / `repo.name` | `api` / `platform` | `api@feat-x` / `platform@feat-x` — unique, use these as keys |
| `target.baseId` / `repo.baseName` | `api` / `platform` | `api` / `platform` — what the config calls it |
| `target.instance` / `repo.instance` | `"base"` | `"feat-x"` |

`target.cwd`, `repo.path`, `target.env` and `target.ports` are already the instance's own: a plugin
that probes `target.ports.http` or runs something in `ctx.cwd` is talking to the right copy without
knowing instances exist. Do not rebuild an id from a name — key a cache by `target.id`.

An instance's `init` and `teardown` steps run as the commands `instance:init` and
`instance:teardown`, so a plugin can take part in preparing a fresh checkout with an ordinary hook:

```ts
hooks: {
  "instance:init": { async post(ctx) { if (ctx.result?.ok) await linkSharedPackages(ctx); } },
}
```

---

## Indicators

An indicator is a named value rendered in row templates as `{<plugin>@<name>}`.

```ts
indicators: {
  open: {
    scope: "app",                           // "app" (default) | "repo"
    description: "…",                       // documentation; not rendered in v1
    update: { mode: "poll", intervalMs: 5_000 },
    async value(ctx) { return "…"; },
  },
}
```

### Scope

| `scope` | Evaluated once per | `ctx.cwd` | `ctx.target` |
| --- | --- | --- | --- |
| `"app"` (default) | app | the app's working directory | present |
| `"repo"` | repo | the repo root | absent |

Repo-scoped values are what an app row falls back to when the token is not defined at app scope —
that is how `{git@branch}` works in a `templates.app` string.

### Update modes

| `update` | Meaning |
| --- | --- |
| `{ mode: "poll", intervalMs: n }` | `value()` is called every `n` ms. First polls are staggered 25 ms apart across owners. |
| `{ mode: "event" }` | Either a `subscribe()` push provider, or a `value()` re-evaluated whenever the daemon refreshes (every supervisor transition). |
| `{ mode: "static" }` | `value()` is called once, when the provider activates. |

Omit `update` and you get `{ mode: "poll", intervalMs: 5000 }` if you defined `value`, or
`{ mode: "event" }` if you only defined `subscribe`.

### The two forms

**Pull** — return a value:

```ts
async value(ctx) {
  const res = await ctx.exec("git rev-parse --short HEAD");
  return res.ok ? res.stdout.trim() : "";
}
```

A poll provider must answer inside 90% of its interval (clamped to 200 ms–5 s); other modes get 5 s.
A throw, a timeout or a rejection yields an **empty cell** plus a warning in `daemon.log` — never a
stale value and never an outage for the neighbouring cells.

**Push** — subscribe and emit:

```ts
subscribe(ctx, emit) {
  const watcher = fs.watch(ctx.cwd, () => emit(read()));
  emit(read());
  return () => watcher.close();          // the disposer is mandatory if you allocate
}
```

`subscribe` is called once per owner when the provider activates. The returned function is called on
deactivation — a config reload, a namespace being unregistered, the daemon shutting down. Anything
you allocate (watchers, sockets, intervals) must be released there, and any timer you keep should be
`.unref()`'d: an indicator must never be the reason the daemon stays alive.

Defining both `value` and `subscribe` is honoured according to `update.mode`, and the mismatch is
logged. Defining neither logs a warning and leaves the cell empty.

### Return shape

```ts
type IndicatorResult =
  | string
  | { value: string; display?: string; tone?: "ok" | "warn" | "error" | "muted" | "info" }
  | null | undefined;
```

- `value` is the machine-readable text: what `u8 status --json` reports.
- `display` replaces it on screen (this is how `app@status` renders as `●`), and is what `pad()` and
  `max()` then measure. With colour off, a cell that has both a `display` and a `tone` falls back to
  `value` — a colourless glyph means nothing in a log file.
- `tone` is a suggested colour — `ok` green, `warn` yellow, `error` red, `info` cyan, `muted` gray and
  dim. A template's own `color()`/`dim`/`bold` modifier replaces it.
- `null`/`undefined` are an empty cell.

**Every value is sanitized before it is cached**: ANSI escapes and control characters are stripped,
whitespace runs collapse to a single space, and the result is capped at 200 characters with an `…`.
You cannot smuggle a newline or a colour escape into a row.

---

## Commands

A command is registered as `<plugin>:<name>` and is runnable with `u8 run <plugin>:<name> [targets…]`
or from the dashboard palette.

```ts
commands: {
  check: {
    kind: "task",                                   // metadata; see below
    description: "Fail unless the target's $PORT is listening",
    appliesTo: (target) => target.env["PORT"] !== undefined,
    groupBy: "target",                              // or "repo"
    async run(ctx) { … },
  },
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `run(ctx)` | **required** | The work. Throw, or return a non-zero number, to fail this target. |
| `appliesTo(target)` | all targets | Returning `false` skips the target (reported, not silently dropped). A throw counts as `false` and is logged. |
| `groupBy` | `"target"` | `"repo"` runs once per repo: the first selected app represents it, `ctx.cwd` becomes the **repo root**, and the rest are skipped with `covered by "<id>"`. This is what `git:pull` uses. |
| `kind` | `"task"` | Reported in `u8 status --json`. In v1 every plugin command runs to completion — a plugin cannot claim a target's supervised process the way a config `kind: "service"` command can. |
| `description` | — | Shown in the palette and `--json`. |

`CommandContext` adds to the base:

```ts
{ command, runId, repo, target, cwd, log(text), signal }
```

- `log(text)` appends a line to this target's run log and streams it to attached clients
  (`u8 logs <target> --run <runId>`).
- `signal` is aborted when the run is cancelled or the daemon shuts down. **Pass it to anything you
  spawn** — `ctx.exec` already defaults to it, but a `fetch`, a `child_process` call of your own or a
  long loop must honour it, or it outlives the run.

Targets run in parallel under the workspace's concurrency cap (`--serial` / `--concurrency` /
`limits.taskConcurrency`).

### Sub-commands

A command key may use `:` to build a hierarchy under your own namespace: the built-in `protos`
registers `link` and a `link:<package>` per configured package, invoked as `protos:link` and
`protos:link:react-query`. Every segment is still a bare name (letters, digits, `.`, `_`, `-`), and
your namespace is still prefixed for you, so this claims nothing outside it.

It is what a *generated* command set is for. `u8 run <command> [targets…]` spends its trailing
arguments on targets, so a command cannot take one — a plugin that would otherwise want
`u8 run protos:link @myorg/protos` registers one command per package at load instead.

Indicator names do not allow `:`, and deliberately: a colon separates modifiers inside a template
token (`{git@branch:max(20)}`), so such a name would be unrenderable.

---

## Hooks

A hook binds to a command name — or `"*"` for every command — and wraps each `(command, target)`
pair.

```ts
hooks: {
  "app:start": {
    async pre(ctx)  { if (await portBusy(ctx)) throw new Error("port already in use"); },
    async post(ctx) { ctx.logger.info(`${ctx.target.id}: ${ctx.result?.ok}`); },
  },
  "*": { async post(ctx) { … } },
}
```

- **`pre` is a gate.** Throwing aborts *that target only* — the command does not run for it, and
  every other target proceeds. The message lands in the target's run log and the result table.
- **`post` always runs**, including after a failure or an abort, and receives
  `ctx.result: { ok, exitCode, durationMs, error? }`. A throwing `post` is logged and reported but
  does not change the target's verdict.
- Order per target: config-declared shell hooks first, then plugins in load order. Within one plugin,
  its exact-name binding runs before its `"*"` binding.

`HookContext` is the base plus `{ command, phase, runId, repo, target, cwd, result? }`. `pre` and
`post` for a target of a skipped command do not run at all — a skip happens before the pipeline.

---

## Readiness

`readiness()` contributes to `dependsOn` gating: before u8 starts a target, every dependency must be
*ready*.

```ts
async readiness(ctx): Promise<"ready" | "pending" | "n/a"> {
  if (!ctx.target.hasHealth) return "n/a";      // no opinion → the default rule applies
  return probeOk(ctx.target) ? "ready" : "pending";
}
```

- `"ready"` / `"pending"` are answers and stop the search.
- `"n/a"` means *no opinion*: the next plugin in load order is asked, and if nobody has one the
  default rule applies — **ready once the process is running**.
- `ctx` carries `{ target, service }` where `service` is the live `ServiceState`
  (`status`, `pid`, `startedAt`, `exitCode`, `restartAttempts`, …).

It is polled every 100 ms while a dependent waits, up to that dependency's `readyTimeout`. Keep it
cheap and non-blocking. A call that throws is treated as `"n/a"` and logged; a call that does not
settle within **2 s** is abandoned as `"n/a"` — one slow plugin can never wedge a profile start.
Whatever the call spawned through `ctx.exec` is killed when it answers or times out.

This is exactly what the built-in `health` plugin does: `"n/a"` for a target with no health check,
otherwise `"ready"` once it has probed healthy.

---

## Lifecycle

```ts
setup(ctx)   // once, at load. ctx adds { targets: TargetInfo[], repos: RepoInfo[] }
teardown()   // once, at shutdown / reload of the plugin list. No context.
```

`setup` is the place to build indexes or start long-lived work; it shares the 10 s load deadline.
`teardown` takes no arguments, so anything it must release has to be reachable from your module or
your `store`.

**Everything you start needs an owner that disposes it.** The host holds an `AbortSignal` per plugin
and aborts it after `teardown` returns, which reaps children spawned through a context's `exec` — but
it cannot reach a `setInterval`, an `fs.watch` or a socket you opened yourself. Release those in
`teardown` (and in your indicator disposers), and `.unref()` any timer that must not keep the daemon
alive.

The plugin host is rebuilt on a config reload **only when the `plugins` list itself changed**; an
unrelated edit leaves your watchers and probes alone. Because the module is already in the loader
cache, editing a plugin *file* does not reload it — stop the daemon (`u8 daemon stop`) to pick it up.

---

## A complete plugin

`plugins/ports.ts` — an indicator, a command, a hook and lifecycle, in one file. It imports nothing,
so it runs in a copy of `examples/demo` as-is, with no `node_modules` and no install step; this is
the file verbatim as it was run there, and the transcript below is that run.

```ts
/** Connects to a TCP port and exits 0 when something answers. */
const probe = (port: string) =>
  `node -e 'const s=require("net").connect(${port},"127.0.0.1");` +
  `s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));` +
  `s.setTimeout(1000,()=>{s.destroy();process.exit(1)})'`;

/** A target opts in by declaring PORT in its env. */
function portOf(env: Record<string, string> | undefined): string | undefined {
  const port = env?.["PORT"];
  return port !== undefined && /^\d+$/.test(port) ? port : undefined;
}

export default {
  name: "ports",

  indicators: {
    open: {
      scope: "app",
      description: "Whether the target's $PORT accepts connections",
      update: { mode: "poll", intervalMs: 5_000 },
      async value(ctx) {
        const port = portOf(ctx.target?.env);
        if (port === undefined) return "";
        if (ctx.service?.status !== "running") return { value: `:${port}`, tone: "muted" };
        const res = await ctx.exec(probe(port), { timeoutMs: 2_000 });
        return { value: `:${port}`, tone: res.ok ? "ok" : "error" };
      },
    },
  },

  commands: {
    check: {
      kind: "task",
      description: "Fail unless the target's $PORT is listening",
      appliesTo: (target) => portOf(target.env) !== undefined,
      async run(ctx) {
        const port = portOf(ctx.target.env);
        if (port === undefined) return;
        ctx.log(`probing :${port}`);
        const res = await ctx.exec(probe(port), { timeoutMs: 3_000, env: { ...ctx.target.env } });
        if (!res.ok) throw new Error(`nothing is listening on :${port}`);
        ctx.log(`:${port} is open`);
      },
    },
  },

  hooks: {
    "app:start": {
      async post(ctx) {
        const port = portOf(ctx.target.env);
        if (port === undefined || ctx.result?.ok !== true) return;
        ctx.logger.info(`${ctx.target.id} started; :${port} should come up`);
      },
    },
  },

  setup(ctx) {
    const withPort = ctx.targets.filter((t) => portOf(t.env) !== undefined);
    ctx.store.set("watched", withPort.map((t) => t.id));
    ctx.logger.info(`watching ports for ${withPort.length} targets`);
  },

  teardown() {
    // Nothing long-lived here; a plugin holding timers or watchers frees them now.
  },
};
```

In a workspace that *does* have `u8cli` installed, prefer the typed form: wrap the object in
`definePlugin(…)` and annotate the callbacks from `u8cli/plugin`. The example is import-free only so
that it runs with no install.

Wire it up:

```jsonc
"plugins": ["./plugins/ports.ts"],
"templates": {
  // the demo's own app row, with {ports@open} appended
  "app": "  {app@status:pad(8)} {app@name:max(16):pad(16)} {health@status:pad(9)} {app@uptime:dim:pad(5)} {port:dim} {ports@open:dim}"
}
```

And run it:

```console
$ u8 start
✓ db                ok 11ms
✓ platform.shell    ok 11ms
✓ api               ok 1ms
✓ platform.auth-mfe ok 2ms
…

$ u8 status
u8-demo · profile full · 4/4 running
  running  db               healthy   14s   -
  running  api              healthy   12s   3000 :3000
platform             platform
  running  shell            healthy   15s   3100 :3100
  running  auth-mfe         healthy   7s    3101 :3101

$ u8 run ports:check
- db                skipped — command "ports:check" does not apply to this target
✓ api               ok 40ms
✓ platform.shell    ok 40ms
✓ platform.auth-mfe ok 41ms

TARGET             RESULT     TIME  DETAIL
db                 - skipped  0ms   command "ports:check" does not apply to this target
api                ✓ ok       40ms
platform.shell     ✓ ok       40ms
platform.auth-mfe  ✓ ok       41ms
ports:check: 1 skipped, 3 ok in 41ms (run msspr9xj-61ee1ad7)
```

`db` has no `PORT`, so `appliesTo` skipped it and `{ports@open}` is blank for it. (The `platform`
header row shows no branch because this copy of the demo is not a git checkout — the built-in `git`
indicators render empty outside a repo rather than erroring.) `setup` and the `app:start` hook show
up in the daemon log:

```console
$ u8 daemon logs | grep ports
2026-08-14T08:56:55.756Z INFO  [daemon:ports] watching ports for 3 targets
2026-08-14T08:56:55.794Z INFO  [daemon:ports] platform.shell started; :3100 should come up
2026-08-14T08:56:58.025Z INFO  [daemon:ports] api started; :3000 should come up
2026-08-14T08:57:03.185Z INFO  [daemon:ports] platform.auth-mfe started; :3101 should come up
```

### Publishing it as a package

Nothing special: a plugin resolved by name is imported from the workspace's `node_modules` through
the package's `exports` (or `module`/`main`). A minimal ESM package works:

```jsonc
// node_modules/u8-plugin-demo/package.json
{ "name": "u8-plugin-demo", "version": "1.0.0", "type": "module", "exports": { ".": "./index.js" } }
```

Depend on `u8cli` for the types; `definePlugin` is the only runtime export, so a JS plugin can skip
it and export the object directly.

---

## Debugging

- `u8 daemon stop && U8_LOG_LEVEL=debug u8 status` — restart the daemon with verbose logging, then
  `u8 daemon logs -f`. The daemon reads `U8_LOG_LEVEL` from its own environment, which it inherits
  from whichever command *spawns* it, so the variable belongs on the command after the stop, not on
  the stop. Your `ctx.logger` lines appear as `[daemon:<plugin>]`.
- `u8 status --json | jq .plugins` — what loaded, and why the rest did not.
- A plugin's failure never takes the daemon down, so a wedged dashboard is not it — check
  `u8 daemon logs` first.

## Reference

- [`src/plugin/types.ts`](../src/plugin/types.ts) — the whole SDK surface, with the comments that
  explain each field.
- [`src/plugins/builtin/git.ts`](../src/plugins/builtin/git.ts) — repo-scoped push indicators with a
  refcounted watcher, and `groupBy: "repo"` commands.
- [`src/plugins/builtin/health.ts`](../src/plugins/builtin/health.ts) — an event indicator, lifecycle
  hooks and a `readiness()` implementation.
- [`src/plugins/builtin/protos.ts`](../src/plugins/builtin/protos.ts) — a factory plugin: its
  indicators and commands are generated from its options, and it registers nothing without them.
- [SPEC §6](SPEC.md#6-plugin-sdk-u8cliplugin) — the design record.
