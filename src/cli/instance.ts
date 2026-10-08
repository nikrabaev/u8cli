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
import type { InstanceCreateParams, Snapshot, TaskResult } from "../ipc/protocol.js";
import { U8Error } from "../util/errors.js";
import { requireRegistered, scopeOf, withAttached, type CliContext, type Scope } from "./context.js";
import { EXIT_FAILURE } from "./errors.js";
import { renderTable } from "./format.js";
import { writeLine, writeLines, type OutputStream } from "./io.js";
import { followRun, warnAboutBase } from "./tasks.js";

/** Lines of a failing target's log shown without being asked. */
const FAILURE_TAIL_LINES = 30;

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
    const rows = instances.map((instance) => [
      instance.name === scope.instance ? ctx.style.green("*") : " ",
      instance.name,
      `${instance.running}/${instance.apps.length} running`,
      instance.initialized ? "" : ctx.style.yellow("not initialised"),
      ctx.style.dim(
        instance.isBase
          ? "the config's own checkouts"
          : Object.values(instance.checkouts)
              .map((c) => `${c.path}${c.owned ? "" : " (adopted)"}`)
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

/**
 * A name for a worktree nobody named: its directory, made to fit. Suffixed
 * when that is taken, because two tools can both call their worktree `fix`.
 */
export function nameForWorktree(dir: string, snapshot: Snapshot): string {
  const cleaned = path
    .basename(dir)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  const stem = cleaned.length === 0 || cleaned === BASE_INSTANCE ? "worktree" : cleaned;
  const taken = new Set(snapshot.instances.map((i) => i.name));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/**
 * The end of each failed target's output.
 *
 * A start that fails leaves its reason in the service log, an init step in the
 * run log; which one is asked for is decided by the command, the same way the
 * `u8 logs` hint is. Both are tried for a service run, since a target can fail
 * before its process ever existed.
 */
async function printFailureTails(ctx: CliContext, attached: AttachedClient, result: TaskResult): Promise<void> {
  const service = result.command.startsWith("app:");
  for (const target of result.targets) {
    if (target.state !== "failed" && target.state !== "aborted") continue;
    const read = async (runId: string | undefined): Promise<string[]> => {
      try {
        const { lines } = await attached.client.request("logs.read", {
          targetId: target.targetId,
          lines: FAILURE_TAIL_LINES,
          runId,
        });
        return lines.map((l) => l.text);
      } catch {
        return [];
      }
    };
    let lines = await read(service ? undefined : result.runId);
    if (lines.length === 0 && service) lines = await read(result.runId);
    if (lines.length === 0) continue;
    writeLine(ctx.io.stderr);
    writeLine(ctx.io.stderr, ctx.style.dim(`── ${target.targetId}: last ${lines.length} line${lines.length === 1 ? "" : "s"} ──`));
    for (const line of lines) writeLine(ctx.io.stderr, line);
  }
}

// ---------------------------------------------------------------------------
// ports / env / exec — answered from the config, no daemon needed
// ---------------------------------------------------------------------------

function urlsOf(ports: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ports)
      .filter(([, port]) => port > 0)
      .map(([name, port]) => [name, `http://localhost:${port}`]),
  );
}

function printAddresses(ctx: CliContext, snapshot: Snapshot, instanceName: string): void {
  const instance = snapshot.instances.find((i) => i.name === instanceName);
  if (!instance) return;
  const own = new Set(instance.appIds);
  const rows = snapshot.repos
    .flatMap((r) => r.apps)
    .filter((a) => own.has(a.id))
    .flatMap((a) => Object.entries(urlsOf(a.ports)).map(([name, url]) => [a.id, ctx.style.dim(name), url]));
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
