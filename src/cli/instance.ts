/**
 * Everything about instances a person or a tool types: `u8 instance …`, plus
 * the three commands that exist because of them — `u8 up`, `u8 ports` and
 * `u8 exec`.
 *
 * Those three are the answer to one question, asked by anything that works in a
 * worktree and cannot watch a dashboard: *bring my copy up and tell me where it
 * is*. `up` is a single idempotent step that only returns once the copy
 * answers; `ports` says which addresses are this copy's, so nothing has to
 * guess `localhost:3000` and test somebody else's process; and `exec` runs a
 * command with this copy's environment, which is how a test suite ends up
 * pointed at the right one.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import {
  BASE_INSTANCE,
  findApp,
  findInstance,
  instanceNameProblem,
  loadWorkspaceFrom,
  resolveTargetStrings,
  type NormalizedApp,
  type NormalizedWorkspace,
} from "../config/index.js";
import type { AttachedClient } from "../daemon/index.js";
import type { InstanceAddParams, InstanceCreateParams, Snapshot, TaskResult } from "../ipc/protocol.js";
import { U8Error } from "../util/errors.js";
import { requireRegistered, scopeOf, withAttached, type CliContext, type Scope } from "./context.js";
import { EXIT_FAILURE } from "./errors.js";
import { renderTable } from "./format.js";
import {
  addressesOf,
  checkoutOutcomes,
  failureTailTitle,
  nameForWorktree,
  readFailureTails,
  rewiredApps,
  rewiredMessage,
  typed,
  urlsOf,
} from "./instance-report.js";
import { writeLine, writeLines, type OutputStream } from "./io.js";
import { followRun, warnAboutBase } from "./tasks.js";

// ---------------------------------------------------------------------------
// instance list
// ---------------------------------------------------------------------------

export interface InstanceListJson {
  instances: Array<{
    name: string;
    isBase: boolean;
    initialized: boolean;
    running: number;
    checkouts: Record<string, { path: string; owned: boolean; branch: string | null }>;
    apps: Array<{ id: string; baseId: string; status: string; ports: Record<string, number>; urls: Record<string, string> }>;
  }>;
}

export function buildInstanceListJson(snapshot: Snapshot): InstanceListJson {
  const apps = new Map(snapshot.repos.flatMap((r) => r.apps).map((a) => [a.id, a]));
  const status = new Map(snapshot.services.map((s) => [s.targetId, s.status]));
  return {
    instances: snapshot.instances.map((instance) => ({
      name: instance.name,
      isBase: instance.isBase,
      initialized: instance.initialized,
      running: instance.appIds.filter((id) => status.get(id) === "running").length,
      checkouts: Object.fromEntries(
        Object.entries(instance.checkouts).map(([repo, c]) => [
          repo,
          { path: c.path, owned: c.owned, branch: c.branch ?? null },
        ]),
      ),
      apps: instance.appIds.map((id) => {
        const app = apps.get(id);
        return {
          id,
          baseId: app?.baseId ?? id,
          status: status.get(id) ?? "stopped",
          ports: { ...app?.ports },
          urls: urlsOf(app?.ports ?? {}),
        };
      }),
    })),
  };
}

export async function instanceListCommand(ctx: CliContext, opts: { json?: boolean }): Promise<number> {
  const scope = scopeOf(ctx);
  return withAttached(ctx, {}, async (attached) => {
    const snapshot = attached.snapshot();
    if (opts.json === true) {
      writeLine(ctx.io.stdout, JSON.stringify(buildInstanceListJson(snapshot), null, 2));
      return 0;
    }
    const { instances } = buildInstanceListJson(snapshot);
    // A checkout `instance remove` left in place is still the instance's, and
    // is removed with it — so it is listed, and marked, since nothing runs from it.
    const inUse = new Set(snapshot.repos.filter((r) => r.apps.length > 0).map((r) => r.name));
    const rows = instances.map((instance) => [
      instance.name === scope.instance ? ctx.style.green("*") : " ",
      instance.name,
      `${instance.running}/${instance.apps.length} running`,
      instance.initialized ? "" : ctx.style.yellow("not initialised"),
      ctx.style.dim(
        instance.isBase
          ? "the config's own checkouts"
          : Object.entries(instance.checkouts)
              .map(([repo, c]) => `${c.path}${c.owned ? "" : " (adopted)"}${inUse.has(repo) ? "" : " (no apps)"}`)
              .join(", "),
      ),
    ]);
    writeLines(ctx.io.stdout, renderTable(rows));
    return 0;
  });
}

// ---------------------------------------------------------------------------
// instance create / init / destroy
// ---------------------------------------------------------------------------

export interface InstanceCreateOptions {
  branch?: string;
  from?: string;
  /** Existing git worktrees to use instead of creating new ones. */
  adopt?: string[];
  /** `repo=dir` pairs: an existing directory for one repo. */
  path?: string[];
  /** `name=value` pairs overriding `${vars.<name>}`. */
  set?: string[];
}

export async function instanceCreateCommand(
  ctx: CliContext,
  name: string,
  targets: readonly string[],
  opts: InstanceCreateOptions,
): Promise<number> {
  const params: InstanceCreateParams = {
    name,
    targets: targets.length === 0 ? undefined : [...targets],
    branch: opts.branch,
    from: opts.from,
    adopt: (opts.adopt ?? []).map((dir) => path.resolve(ctx.cwd, dir)),
    paths: Object.fromEntries(
      pairs(opts.path ?? [], "--path", "repo=dir").map(([repo, dir]) => [repo, path.resolve(ctx.cwd, dir)]),
    ),
    vars: Object.fromEntries(pairs(opts.set ?? [], "--set", "name=value")),
  };

  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const { result, code } = await followRun(ctx, attached, () => attached.client.request("instance.create", params));
    if (result !== undefined && !result.ok) await printFailureTails(ctx, attached, result);
    if (code !== 0) return code;
    const snapshot = await attached.client.request("workspace.snapshot", {});
    printAddresses(ctx, snapshot, name);
    writeLine(ctx.io.stderr, ctx.style.dim(`start it with: u8 -i ${name} up`));
    return 0;
  });
}

/** `[key, value]` for every `key=value`, or a usage error naming the flag. */
function pairs(values: readonly string[], flag: string, shape: string): Array<[string, string]> {
  return values.map((value) => {
    const at = value.indexOf("=");
    if (at <= 0) throw new U8Error("INSTANCE_INVALID", `${flag} expects ${shape}, got "${value}"`);
    return [value.slice(0, at), value.slice(at + 1)];
  });
}

/** The instance a command means when none was named: the one this directory is. */
function namedOrCurrent(scope: Scope, name: string | undefined, action: string): string {
  if (name !== undefined) return name;
  if (scope.instance !== BASE_INSTANCE) return scope.instance;
  throw new U8Error(
    "UNKNOWN_INSTANCE",
    `${action} needs an instance name — this directory is not inside one`,
  );
}

export async function instanceInitCommand(ctx: CliContext, name: string | undefined): Promise<number> {
  const scope = scopeOf(ctx);
  const target = name ?? scope.instance;
  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const { result, code } = await followRun(ctx, attached, () =>
      attached.client.request("instance.init", { name: target }),
    );
    if (result !== undefined && !result.ok) await printFailureTails(ctx, attached, result);
    return code;
  });
}

export async function instanceDestroyCommand(
  ctx: CliContext,
  name: string | undefined,
  opts: { force?: boolean },
): Promise<number> {
  const scope = scopeOf(ctx);
  const target = namedOrCurrent(scope, name, "u8 instance destroy");
  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const { result, code } = await followRun(ctx, attached, () =>
      attached.client.request("instance.destroy", { name: target, force: opts.force }),
    );
    if (result !== undefined && !result.ok) await printFailureTails(ctx, attached, result);
    if (code === 0) writeLine(ctx.io.stdout, `instance ${ctx.style.bold(target)} destroyed`);
    return code;
  });
}

// ---------------------------------------------------------------------------
// instance add / remove
// ---------------------------------------------------------------------------

/**
 * The instance a membership change is about: the one `-i` names, else the one
 * this directory belongs to. There is no falling back to base here — base's
 * apps are the config's, so "no instance" can only be a mistake.
 */
function editedInstance(scope: Scope, action: string): string {
  if (scope.instance !== BASE_INSTANCE || scope.source !== "default") return scope.instance;
  throw new U8Error(
    "UNKNOWN_INSTANCE",
    scope.unregistered === undefined
      ? `${action} needs an instance — this directory is not inside one, so name it with -i <name>`
      : `${action} needs an instance, and this worktree has none yet — \`u8 up\` gives it one, or name another with -i <name>`,
  );
}

/**
 * Names the running apps a membership change left on their old wiring, and the
 * restart that makes the change real for them.
 */
function printRewired(ctx: CliContext, before: Snapshot, after: Snapshot, instanceName: string): void {
  const stale = rewiredApps(before, after, instanceName);
  if (stale.length === 0) return;
  writeLine(
    ctx.io.stderr,
    ctx.style.yellow(rewiredMessage(stale, `u8 -i ${instanceName} restart ${typed(after, stale)}`)),
  );
}

export interface InstanceAddOptions {
  /** Branch for a worktree that has to be created; defaults to the instance's own. */
  branch?: string;
  from?: string;
  /** Existing git worktrees to use instead of creating new ones. */
  adopt?: string[];
  /** `repo=dir` pairs: an existing directory for one repo. */
  path?: string[];
}

export async function instanceAddCommand(
  ctx: CliContext,
  targets: readonly string[],
  opts: InstanceAddOptions,
): Promise<number> {
  const name = editedInstance(scopeOf(ctx), "u8 instance add");
  const params: InstanceAddParams = {
    name,
    targets: [...targets],
    branch: opts.branch,
    from: opts.from,
    adopt: (opts.adopt ?? []).map((dir) => path.resolve(ctx.cwd, dir)),
    paths: Object.fromEntries(
      pairs(opts.path ?? [], "--path", "repo=dir").map(([repo, dir]) => [repo, path.resolve(ctx.cwd, dir)]),
    ),
  };

  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const before = attached.snapshot();
    let added: string[] = [];
    const { result, code } = await followRun(ctx, attached, async () => {
      const answer = await attached.client.request("instance.add", params);
      added = answer.added;
      return answer;
    });
    // Interrupted: the run carries on, and what it leaves is not known yet.
    if (result === undefined) return code;
    if (!result.ok) await printFailureTails(ctx, attached, result);

    const after = await attached.client.request("workspace.snapshot", {});
    // The apps are in the instance from the moment the request is accepted,
    // whatever became of their init steps — so their neighbours are rewired
    // either way, and that is said either way.
    printRewired(ctx, before, after, name);
    if (code !== 0) {
      writeLine(
        ctx.io.stderr,
        ctx.style.dim(
          `${typed(after, added)} joined instance "${name}" without finishing init — fix the step, then: u8 -i ${name} instance init`,
        ),
      );
      return code;
    }
    printAddresses(ctx, after, name, added);
    writeLine(ctx.io.stderr, ctx.style.dim(`start with: u8 -i ${name} start ${typed(after, added)}`));
    return 0;
  });
}

export interface InstanceRemoveOptions {
  /** Remove the apps even if one of their teardown steps fails. */
  force?: boolean;
  /** Also give up the checkout of a repo left with no apps. */
  prune?: boolean;
  /** With `prune`: remove a worktree that has uncommitted changes. */
  discard?: boolean;
}

export async function instanceRemoveCommand(
  ctx: CliContext,
  targets: readonly string[],
  opts: InstanceRemoveOptions,
): Promise<number> {
  const name = editedInstance(scopeOf(ctx), "u8 instance remove");

  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const before = await attached.client.request("workspace.snapshot", {});
    let removed: string[] = [];
    const { result, code } = await followRun(ctx, attached, async () => {
      const answer = await attached.client.request("instance.remove", {
        name,
        targets: [...targets],
        force: opts.force,
        prune: opts.prune,
        discard: opts.discard,
      });
      removed = answer.removed;
      return answer;
    });
    if (result === undefined) return code;
    if (!result.ok) await printFailureTails(ctx, attached, result);

    // Read back rather than inferred from the exit code: a forced removal
    // reports its failed teardown and still removes, and a refused one fails
    // having changed nothing.
    const after = await attached.client.request("workspace.snapshot", {});
    const left = new Set(after.instances.find((i) => i.name === name)?.appIds ?? []);
    const gone = removed.filter((id) => !left.has(id));
    if (gone.length > 0) {
      writeLine(ctx.io.stdout, `removed ${typed(before, gone)} from instance ${ctx.style.bold(name)}`);
    }
    printCheckouts(ctx, before, after, name, opts.prune === true);
    printRewired(ctx, before, after, name);
    if (gone.length > 0) await warnAboutBase(ctx, attached, name);
    return code;
  });
}

/**
 * What became of the checkouts a removal left without apps — and, for one that
 * was kept, the two ways on from it.
 */
function printCheckouts(ctx: CliContext, before: Snapshot, after: Snapshot, instanceName: string, pruning: boolean): void {
  for (const outcome of checkoutOutcomes(before, after, instanceName)) {
    switch (outcome.kind) {
      case "kept": {
        // Asked to go and still here: the run's own failure says why.
        const next = pruning
          ? ""
          : ` — bring it back with: u8 -i ${instanceName} instance add ${outcome.repo}; ` +
            `give it up with: u8 -i ${instanceName} instance remove ${outcome.repo} --prune`;
        writeLine(ctx.io.stderr, ctx.style.dim(`${outcome.text}${next}`));
        break;
      }
      case "forgotten":
        writeLine(ctx.io.stdout, `${outcome.text} ${ctx.style.dim(outcome.note ?? "")}`);
        break;
      case "shared":
        writeLine(ctx.io.stderr, ctx.style.dim(outcome.text));
        break;
      case "removed":
        writeLine(ctx.io.stdout, outcome.text);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

export interface UpOptions {
  /** Branch for worktrees `up` has to create; defaults to the instance name. */
  branch?: string;
  from?: string;
}

/**
 * Makes sure this directory's instance exists, is initialised and is up — and
 * returns only when it is ready, or with the reason it is not.
 *
 * Idempotent on purpose: it is the one command a tool can run without first
 * working out what state things are in. Each step is skipped when already done.
 */
export async function upCommand(ctx: CliContext, targets: readonly string[], opts: UpOptions): Promise<number> {
  const scope = scopeOf(ctx);
  const requested = targets.length === 0 ? undefined : [...targets];

  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const existing = attached.snapshot().instances.find((i) => i.name === scope.instance);
    let name = scope.instance;
    /** Whether `targets` already went into choosing the instance's apps. */
    let created = false;

    if (scope.unregistered !== undefined) {
      // A worktree somebody else made: it becomes an instance as it is.
      name = nameForWorktree(scope.unregistered, attached.snapshot());
      writeLine(ctx.io.stderr, ctx.style.dim(`creating instance "${name}" from ${scope.unregistered}`));
      const step = await runStep(ctx, attached, () =>
        attached.client.request("instance.create", { name, adopt: [scope.unregistered ?? ""], targets: requested }),
      );
      if (step !== 0) return step;
      created = true;
    } else if (existing === undefined) {
      // Named with `-i` but not there yet: u8 makes the worktrees.
      const problem = instanceNameProblem(name);
      if (problem !== undefined) throw new U8Error("INSTANCE_INVALID", problem, { name });
      writeLine(ctx.io.stderr, ctx.style.dim(`creating instance "${name}"`));
      const step = await runStep(ctx, attached, () =>
        attached.client.request("instance.create", {
          name,
          targets: requested,
          branch: opts.branch,
          from: opts.from,
        }),
      );
      if (step !== 0) return step;
      created = true;
    } else if (!existing.initialized) {
      const step = await runStep(ctx, attached, () => attached.client.request("instance.init", { name }));
      if (step !== 0) return step;
    }

    const started = await runStep(ctx, attached, () =>
      attached.client.request("service.start", {
        instance: name,
        targets: created ? undefined : requested,
        wait: true,
      }),
    );
    if (started !== 0) return started;

    const snapshot = await attached.client.request("workspace.snapshot", {});
    printAddresses(ctx, snapshot, name);
    await warnAboutBase(ctx, attached, name);
    return 0;
  });
}

/** One followed run; on failure, the tail of what failed, so nothing has to be looked up. */
async function runStep(
  ctx: CliContext,
  attached: AttachedClient,
  start: () => Promise<{ runId: string }>,
): Promise<number> {
  const { result, code } = await followRun(ctx, attached, start);
  if (result !== undefined && !result.ok) await printFailureTails(ctx, attached, result);
  return code;
}

/** The end of each failed target's output, so nothing has to be looked up. */
async function printFailureTails(ctx: CliContext, attached: AttachedClient, result: TaskResult): Promise<void> {
  const tails = await readFailureTails((params) => attached.client.request("logs.read", params), result);
  for (const tail of tails) {
    writeLine(ctx.io.stderr);
    writeLine(ctx.io.stderr, ctx.style.dim(failureTailTitle(tail)));
    for (const line of tail.lines) writeLine(ctx.io.stderr, line);
  }
}

// ---------------------------------------------------------------------------
// ports / env / exec — answered from the config, no daemon needed
// ---------------------------------------------------------------------------

/** The addresses of an instance's apps — all of them, or just the ones in `only`. */
function printAddresses(ctx: CliContext, snapshot: Snapshot, instanceName: string, only?: readonly string[]): void {
  const rows = addressesOf(snapshot, instanceName, only).map((a) => [a.id, ctx.style.dim(a.port), a.url]);
  if (rows.length === 0) return;
  writeLine(ctx.io.stdout);
  writeLines(ctx.io.stdout, renderTable(rows));
}

/** The workspace as the config and the instance records describe it right now. */
function loadScoped(ctx: CliContext): { scope: Scope; ws: NormalizedWorkspace } {
  const scope = scopeOf(ctx);
  const ws = loadWorkspaceFrom(scope.configPath);
  if (!findInstance(ws, scope.instance)) {
    throw new U8Error("UNKNOWN_INSTANCE", `unknown instance "${scope.instance}"`, {
      instance: scope.instance,
      known: ws.instances.map((i) => i.name),
    });
  }
  return { scope, ws };
}

function appsFor(ws: NormalizedWorkspace, scope: Scope, targets: readonly string[]): NormalizedApp[] {
  const ids =
    targets.length === 0
      ? (findInstance(ws, scope.instance)?.appIds ?? [])
      : resolveTargetStrings(ws, targets, scope.instance);
  return ids.map((id) => findApp(ws, id)).filter((a): a is NormalizedApp => a !== undefined);
}

export interface PortsJson {
  instance: string;
  apps: Array<{ id: string; baseId: string; cwd: string; ports: Record<string, number>; urls: Record<string, string> }>;
}

export function portsCommand(ctx: CliContext, targets: readonly string[], opts: { json?: boolean }): number {
  const { scope, ws } = loadScoped(ctx);
  const apps = appsFor(ws, scope, targets);

  if (opts.json === true) {
    const json: PortsJson = {
      instance: scope.instance,
      apps: apps.map((a) => ({ id: a.id, baseId: a.baseId, cwd: a.cwd, ports: { ...a.ports }, urls: urlsOf(a.ports) })),
    };
    writeLine(ctx.io.stdout, JSON.stringify(json, null, 2));
    return 0;
  }

  const rows = apps.flatMap((a) =>
    Object.entries(a.ports).map(([name, port]) => [
      a.id,
      ctx.style.dim(name),
      port > 0 ? String(port) : ctx.style.yellow("unallocated"),
      port > 0 ? `http://localhost:${port}` : "",
    ]),
  );
  if (rows.length === 0) {
    writeLine(ctx.io.stderr, ctx.style.dim(`no ports are declared for ${targets.length === 0 ? `instance "${scope.instance}"` : targets.join(", ")}`));
    return 0;
  }
  writeLines(ctx.io.stdout, renderTable(rows));
  if (scope.unregistered !== undefined) {
    writeLine(ctx.io.stderr, ctx.style.yellow("these are base's ports — this worktree has no instance yet (`u8 up` creates one)"));
  }
  return 0;
}

/** Exactly one app: `env` and `exec` are about a single process's surroundings. */
function oneApp(ws: NormalizedWorkspace, scope: Scope, target: string | undefined): NormalizedApp {
  const apps = appsFor(ws, scope, target === undefined ? [] : [target]);
  const [only, ...rest] = apps;
  if (only !== undefined && rest.length === 0) return only;
  if (only === undefined) {
    throw new U8Error("UNKNOWN_TARGET", `instance "${scope.instance}" has no apps`, { instance: scope.instance });
  }
  throw new U8Error(
    "UNKNOWN_TARGET",
    `${target === undefined ? `instance "${scope.instance}"` : `"${target}"`} has several apps — name one: ` +
      apps.map((a) => a.baseId).join(", "),
    { target },
  );
}

export function envCommand(ctx: CliContext, target: string | undefined, opts: { json?: boolean }): number {
  const { scope, ws } = loadScoped(ctx);
  const app = oneApp(ws, scope, target);
  if (opts.json === true) {
    writeLine(ctx.io.stdout, JSON.stringify({ id: app.id, cwd: app.cwd, env: app.env }, null, 2));
    return 0;
  }
  for (const key of Object.keys(app.env).sort()) writeLine(ctx.io.stdout, `${key}=${app.env[key] ?? ""}`);
  return 0;
}

/**
 * Runs a command in an app's directory with the app's resolved environment —
 * the same `PORT`, `API_URL` and the rest that its process was started with.
 *
 * This is how a test suite, a migration or a `curl` ends up talking to this
 * instance rather than to whatever happens to be on the port a README mentions.
 */
export async function execCommand(ctx: CliContext, target: string, argv: readonly string[]): Promise<number> {
  const { scope, ws } = loadScoped(ctx);
  requireRegistered(scope, "u8 exec");
  const app = oneApp(ws, scope, target);
  const [command, ...args] = argv;
  if (command === undefined) throw new U8Error("UNKNOWN_COMMAND", "u8 exec needs a command to run after the target");

  // Straight through when this really is the process's own terminal, so the
  // command keeps its colours and its prompt; piped when the streams are
  // somebody else's (a test, an embedder), who must get every byte.
  const direct = ctx.io.stdout === (process.stdout as unknown as OutputStream);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.io.env)) if (value !== undefined) env[key] = value;

  return new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      cwd: app.cwd,
      env: { ...env, ...app.env, U8_INSTANCE: app.instance, U8_TARGET: app.id },
      stdio: direct ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => void ctx.io.stdout.write(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => void ctx.io.stderr.write(chunk.toString("utf8")));

    const onAbort = (): void => void child.kill("SIGTERM");
    ctx.io.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number): void => {
      ctx.io.signal?.removeEventListener("abort", onAbort);
      resolve(code);
    };
    child.once("error", (err: NodeJS.ErrnoException) => {
      writeLine(
        ctx.io.stderr,
        ctx.style.red(err.code === "ENOENT" ? `command not found: ${command}` : `could not run ${command}: ${err.message}`),
      );
      done(err.code === "ENOENT" ? 127 : EXIT_FAILURE);
    });
    child.once("exit", (code, signal) => done(code ?? (signal === null ? EXIT_FAILURE : 128)));
  });
}
