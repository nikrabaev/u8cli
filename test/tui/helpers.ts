/**
 * Harness for the dashboard tests.
 *
 * The controller only ever sees a {@link DashboardClient}, so the whole daemon —
 * socket, attach handshake, push streams — is replaced here by an object that
 * records what was asked of it and lets a test push notifications in. That is
 * the point of the seam: "a service crashed while a task was running and the
 * daemon went away mid-scroll" is three lines of setup instead of a fixture
 * workspace.
 *
 * The scheduler is fake for the same reason. Frame coalescing and the notice
 * timeout are behaviour worth asserting, and asserting them against real timers
 * means sleeping in a test — so time is advanced by hand and a leaked timer is
 * visible as a non-zero {@link TestScheduler.pending}.
 */
import { qualify, splitQualified, type TargetId } from "../../src/config/types.js";
import { PROTOCOL_VERSION } from "../../src/ipc/protocol.js";
import type {
  IndicatorTone,
  IndicatorValue,
  LogLine,
  RpcMethod,
  RpcNotification,
  RpcNotificationPayload,
  RpcParams,
  RpcResult,
  ServiceState,
  ServiceStatus,
  Snapshot,
  SnapshotApp,
  SnapshotInstance,
  SnapshotRepo,
  TaskResult,
  TaskTargetResult,
} from "../../src/ipc/protocol.js";
import type { Scheduler } from "../../src/tui/controller.js";
import type { DashboardClient, RpcRequestOptions, Unsubscribe } from "../../src/tui/types.js";

// ---------------------------------------------------------------------------
// Snapshot fixtures
// ---------------------------------------------------------------------------

/** The workspace the CLI tests use: one merged-row repo, one two-app repo. */
export function fixtureSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const api = app("api");
  const web = app("platform", "web");
  const admin = app("platform", "admin");
  const ids = [api.id, web.id, admin.id];

  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.1.0",
    workspace: { id: "wsid", name: "fixture", rootDir: "/ws", configPath: "/ws/u8.jsonc" },
    templates: { repo: "REPO {repo@name}", app: "APP {app@name} {app@status}" },
    repos: [
      { name: "api", baseName: "api", instance: "base", path: "/ws/api", apps: [api] },
      { name: "platform", baseName: "platform", instance: "base", path: "/ws/platform", apps: [web, admin] },
    ],
    instances: [{ name: "base", isBase: true, createdAt: 0, appIds: ids, checkouts: {}, initialized: true }],
    profiles: [
      { name: "all", isDefault: true, appIds: ids },
      { name: "frontend", isDefault: false, appIds: [web.id] },
    ],
    activeProfile: "all",
    commands: [
      { name: "app:start", kind: "service", source: "core", appliesTo: ids },
      { name: "greet", kind: "task", source: "config", description: "say hello", appliesTo: ids },
      { name: "git:pull", kind: "task", source: "plugin", appliesTo: [api.id] },
    ],
    services: ids.map((id) => serviceState(id, "stopped")),
    indicators: [
      ...ids.flatMap((id) => [
        indicator({ ns: "app", name: "name", scope: "app", owner: id, value: id.split(".").at(-1) ?? id }),
        statusIndicator(id, "stopped"),
      ]),
      indicator({ ns: "repo", name: "name", scope: "repo", owner: "api", value: "api" }),
      indicator({ ns: "repo", name: "name", scope: "repo", owner: "platform", value: "platform" }),
    ],
    plugins: [{ name: "git", spec: "git", ok: true }],
    ...overrides,
  };
}

export function app(repoName: string, name?: string): SnapshotApp {
  const implicit = name === undefined;
  const id = implicit ? repoName : `${repoName}.${name}`;
  return {
    id,
    baseId: id,
    instance: "base",
    repoName,
    name: name ?? repoName,
    implicit,
    cwd: `/ws/${repoName}${implicit ? "" : `/${name}`}`,
    ports: {},
    hasHealth: false,
    dependsOn: [],
    scripts: ["start"],
  };
}

export function serviceState(targetId: TargetId, status: ServiceStatus, stale = false): ServiceState {
  return { targetId, status, stale, restartAttempts: 0 };
}

/** `base`'s app, as `instance` has it: the same definition under a qualified id. */
export function copyOf(base: SnapshotApp, instance: string, extra: Partial<SnapshotApp> = {}): SnapshotApp {
  return {
    ...base,
    id: qualify(base.id, instance),
    baseId: base.id,
    instance,
    repoName: qualify(base.repoName, instance),
    cwd: `/wt/${instance}${base.cwd.slice("/ws".length)}`,
    ...extra,
  };
}

/** One instance's part of a snapshot: its repos, its record, and cells and states for its apps. */
export interface InstancePart {
  instance: SnapshotInstance;
  repos: SnapshotRepo[];
  services: ServiceState[];
  indicators: IndicatorValue[];
}

export function instancePart(
  name: string,
  apps: readonly SnapshotApp[],
  opts: {
    checkouts?: SnapshotInstance["checkouts"];
    initialized?: boolean;
    createdAt?: number;
    status?: Record<TargetId, ServiceStatus>;
    stale?: readonly TargetId[];
  } = {},
): InstancePart {
  const byRepo = new Map<string, SnapshotApp[]>();
  for (const one of apps) byRepo.set(one.repoName, [...(byRepo.get(one.repoName) ?? []), one]);
  const stateOf = (id: TargetId): ServiceStatus => opts.status?.[id] ?? "stopped";
  return {
    instance: {
      name,
      isBase: false,
      createdAt: opts.createdAt ?? 1,
      appIds: apps.map((one) => one.id),
      checkouts: opts.checkouts ?? {},
      initialized: opts.initialized ?? true,
    },
    repos: [...byRepo].map(([repoName, own]) => ({
      name: repoName,
      baseName: own[0]?.baseId.split(".")[0] ?? repoName,
      instance: name,
      path: `/wt/${name}/${own[0]?.baseId.split(".")[0] ?? repoName}`,
      apps: own,
    })),
    services: apps.map((one) => serviceState(one.id, stateOf(one.id), opts.stale?.includes(one.id) ?? false)),
    indicators: [
      ...apps.flatMap((one) => [
        indicator({ ns: "app", name: "name", scope: "app", owner: one.id, value: one.name }),
        statusIndicator(one.id, stateOf(one.id)),
      ]),
      ...[...byRepo.keys()].map((repoName) =>
        indicator({ ns: "repo", name: "name", scope: "repo", owner: repoName, value: splitQualified(repoName).name }),
      ),
    ],
  };
}

/** A snapshot with these instances beside base. */
export function withInstances(base: Snapshot, ...parts: InstancePart[]): Snapshot {
  return {
    ...base,
    repos: [...base.repos, ...parts.flatMap((part) => part.repos)],
    instances: [...base.instances, ...parts.map((part) => part.instance)],
    services: [...base.services, ...parts.flatMap((part) => part.services)],
    indicators: [...base.indicators, ...parts.flatMap((part) => part.indicators)],
  };
}

/**
 * `feat-x`, the instance most instance tests are about. It runs its own `api`
 * and `platform.web`; `web` depends on `platform.admin`, which it has no copy
 * of, so it leans on base's. Its three checkouts are the three kinds there
 * are: a worktree u8 created, a worktree somebody else made, and one an
 * earlier remove left behind with no apps — whose repo is therefore absent
 * from `repos`, exactly as the daemon reports it.
 */
export function featX(
  opts: { status?: Record<TargetId, ServiceStatus>; stale?: readonly TargetId[]; initialized?: boolean } = {},
): InstancePart {
  const api = copyOf(app("api"), "feat-x", { ports: { http: 20001 } });
  const web = copyOf(app("platform", "web"), "feat-x", { ports: { http: 20002 }, dependsOn: ["platform.admin"] });
  return instancePart("feat-x", [api, web], {
    ...opts,
    createdAt: 1_000,
    checkouts: {
      "api@feat-x": { path: "/wt/feat-x/api", owned: true, branch: "feat-x", worktree: "/wt/feat-x/api", createdBranch: true },
      "platform@feat-x": { path: "/agents/wt-3/platform", owned: false },
      "infra@feat-x": { path: "/wt/feat-x/infra", owned: true, branch: "feat-x", worktree: "/wt/feat-x/infra" },
    },
  });
}

/** A second, smaller instance: something for the cursor to move to, and to land on. */
export function agent2(): InstancePart {
  const api = copyOf(app("api"), "agent-2", { ports: { http: 20010 } });
  return instancePart("agent-2", [api], {
    createdAt: 2_000,
    checkouts: { "api@agent-2": { path: "/wt/agent-2/api", owned: true, branch: "agent-2", worktree: "/wt/agent-2/api" } },
  });
}

/** Base, `feat-x` and `agent-2`: three sections, which is what navigation needs. */
export function instancesSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...withInstances(fixtureSnapshot(), featX(), agent2()), ...overrides };
}

/** A finished run, with every target in the same state unless said otherwise. */
export function taskResult(
  runId: string,
  command: string,
  targets: Array<TargetId | TaskTargetResult>,
  ok = true,
): TaskResult {
  return {
    runId,
    command,
    ok,
    targets: targets.map((target) =>
      typeof target === "string" ? { targetId: target, state: ok ? "ok" : "failed", durationMs: 5 } : target,
    ),
    startedAt: 1_000,
    finishedAt: 1_500,
  };
}

export function indicator(value: {
  ns: string;
  name: string;
  scope: "repo" | "app";
  owner: string;
  value: string;
  display?: string;
  tone?: IndicatorTone;
}): IndicatorValue {
  return value;
}

/** `app@status` as the daemon publishes it: a glyph whose meaning is its tone. */
export function statusIndicator(owner: TargetId, status: string): IndicatorValue {
  const tone: IndicatorTone = status === "running" ? "ok" : status === "crashed" ? "error" : "muted";
  return { ns: "app", name: "status", scope: "app", owner, value: status, display: "●", tone };
}

export function logLine(targetId: TargetId, text: string, ts = 0): LogLine {
  return { targetId, stream: "stdout", ts, text };
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

type Answer = (params: unknown) => unknown;

export interface FakeClient extends DashboardClient {
  /** Every RPC the controller made, in order. */
  readonly calls: Array<{ method: RpcMethod; params: unknown; opts?: RpcRequestOptions }>;
  /** Log targets currently subscribed — must be empty once a view closes. */
  readonly subscribed: Set<TargetId>;
  readonly subscribeCalls: TargetId[];
  readonly unsubscribeCalls: TargetId[];
  /** Notification + connection listeners still registered, for leak checks. */
  listenerCount(): number;
  /** Lines `logs.read` backfills with. */
  readonly lines: LogLine[];
  paramsOf(method: RpcMethod): unknown[];
  /** The options each call to `method` was sent with. */
  optsOf(method: RpcMethod): Array<RpcRequestOptions | undefined>;
  /** Run ids handed out and not finished yet, oldest first. */
  readonly running: string[];
  /**
   * Ends a run the way the daemon does: `task.finished` is pushed, and
   * whoever awaits it gets the result. Until then `run.await` stays pending,
   * which is what a run in flight looks like from the dashboard.
   */
  finish(result: TaskResult): void;
  push<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void;
  setSnapshot(next: Snapshot): void;
  disconnect(): void;
  reattach(next?: Snapshot): void;
  lose(err?: Error): void;
  /** Replaces the canned answer for one method. */
  answer<M extends RpcMethod>(method: M, fn: (params: RpcParams<M>) => RpcResult<M>): void;
  /** Makes every subsequent call to `method` reject. */
  fail(method: RpcMethod, err: Error): void;
  /** Makes the next call to `method` reject, and the ones after it answer again. */
  failOnce(method: RpcMethod, err: Error): void;
}

export function createFakeClient(initial: Snapshot = fixtureSnapshot()): FakeClient {
  let snapshot = initial;
  let runs = 0;
  const calls: Array<{ method: RpcMethod; params: unknown; opts?: RpcRequestOptions }> = [];
  const running: string[] = [];
  const finished = new Map<string, TaskResult>();
  const awaiting = new Map<string, Array<(result: TaskResult) => void>>();
  const nextRun = (): string => {
    const runId = `run-${++runs}`;
    running.push(runId);
    return runId;
  };
  const instanceOf = (name: string): SnapshotInstance =>
    snapshot.instances.find((i) => i.name === name) ?? {
      name,
      isBase: false,
      createdAt: 0,
      appIds: [],
      checkouts: {},
      initialized: false,
    };
  const subscribed = new Set<TargetId>();
  const subscribeCalls: TargetId[] = [];
  const unsubscribeCalls: TargetId[] = [];
  const lines: LogLine[] = [];
  const answers = new Map<RpcMethod, Answer>();
  const failures = new Map<RpcMethod, Error>();
  const failuresOnce = new Map<RpcMethod, Error>();
  const listeners = new Map<string, Set<(params: never) => void>>();
  const disconnects = new Set<() => void>();
  const reattaches = new Set<(s: Snapshot) => void>();
  const losses = new Set<(err: Error) => void>();

  const on = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  const canned = (method: RpcMethod, params: unknown): unknown => {
    switch (method) {
      case "logs.read": {
        const { targetId } = params as { targetId: TargetId };
        return { lines: lines.filter((line) => line.targetId === targetId) };
      }
      case "service.start":
      case "service.stop":
      case "service.restart":
      case "command.run":
      case "instance.init":
      case "instance.destroy":
        return { runId: nextRun() };
      // What the daemon answers once it has taken the request. The snapshot is
      // the test's to move: nothing here pretends to be the instance manager.
      case "instance.create": {
        const { name } = params as { name: string };
        return { instance: instanceOf(name), runId: nextRun() };
      }
      case "instance.add": {
        const { name, targets } = params as { name: string; targets: string[] };
        return { instance: instanceOf(name), added: targets.map((id) => qualify(id, name)), runId: nextRun() };
      }
      case "instance.remove": {
        const { name, targets } = params as { name: string; targets: string[] };
        const own = new Set(instanceOf(name).appIds);
        return { removed: targets.map((id) => qualify(id, name)).filter((id) => own.has(id)), runId: nextRun() };
      }
      case "run.await": {
        const { runId } = params as { runId: string };
        const done = finished.get(runId);
        if (done !== undefined) return done;
        return new Promise<TaskResult>((resolve) => {
          awaiting.set(runId, [...(awaiting.get(runId) ?? []), resolve]);
        });
      }
      case "workspace.snapshot":
        return snapshot;
      case "profile.use": {
        const { name } = params as { name: string };
        snapshot = { ...snapshot, activeProfile: name };
        return { ok: true, activeProfile: name };
      }
      default:
        throw new Error(`fake client has no answer for ${method}`);
    }
  };

  const client: FakeClient = {
    calls,
    subscribed,
    subscribeCalls,
    unsubscribeCalls,
    lines,
    snapshot: () => snapshot,
    listenerCount() {
      let total = disconnects.size + reattaches.size + losses.size;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    paramsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    optsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.opts),
    running,
    finish(result) {
      const at = running.indexOf(result.runId);
      if (at >= 0) running.splice(at, 1);
      finished.set(result.runId, result);
      client.push("task.finished", { result });
      for (const resolve of awaiting.get(result.runId) ?? []) resolve(result);
      awaiting.delete(result.runId);
    },

    request<M extends RpcMethod>(method: M, params: RpcParams<M>, opts?: RpcRequestOptions): Promise<RpcResult<M>> {
      calls.push({ method, params, opts });
      const once = failuresOnce.get(method);
      if (once !== undefined) {
        failuresOnce.delete(method);
        return Promise.reject(once);
      }
      const failure = failures.get(method);
      if (failure !== undefined) return Promise.reject(failure);
      const answer = answers.get(method);
      const result = answer === undefined ? canned(method, params) : answer(params);
      return Promise.resolve(result as RpcResult<M>);
    },

    on<N extends RpcNotification>(name: N, cb: (params: RpcNotificationPayload<N>) => void): Unsubscribe {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      return on(set as Set<(params: RpcNotificationPayload<N>) => void>, cb);
    },

    async subscribe(targetId: TargetId): Promise<void> {
      subscribeCalls.push(targetId);
      subscribed.add(targetId);
    },
    async unsubscribe(targetId: TargetId): Promise<void> {
      unsubscribeCalls.push(targetId);
      subscribed.delete(targetId);
    },

    onDisconnect: (cb) => on(disconnects, cb),
    onReattach: (cb) => on(reattaches, cb),
    onLost: (cb) => on(losses, cb),

    push(name, params) {
      for (const cb of [...(listeners.get(name) ?? [])]) (cb as (p: typeof params) => void)(params);
    },
    setSnapshot(next) {
      snapshot = next;
    },
    disconnect() {
      for (const cb of [...disconnects]) cb();
    },
    reattach(next) {
      if (next !== undefined) snapshot = next;
      for (const cb of [...reattaches]) cb(snapshot);
    },
    lose(err = new Error("daemon unreachable")) {
      for (const cb of [...losses]) cb(err);
    },
    answer(method, fn) {
      answers.set(method, fn as Answer);
    },
    fail(method, err) {
      failures.set(method, err);
    },
    failOnce(method, err) {
      failuresOnce.set(method, err);
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export interface TestScheduler {
  schedule: Scheduler;
  /** Outstanding timers. Non-zero after `dispose()` is a leak. */
  readonly pending: number;
  /** Runs everything due within `ms` of now. */
  advance(ms: number): void;
}

export function testScheduler(): TestScheduler {
  const timers = new Map<number, { fn: () => void; due: number }>();
  let seq = 0;
  let now = 0;

  const schedule: Scheduler = (fn, ms) => {
    const id = seq++;
    timers.set(id, { fn, due: now + ms });
    return () => {
      timers.delete(id);
    };
  };

  return {
    schedule,
    get pending(): number {
      return timers.size;
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

/** Lets pending microtasks (and Ink's re-render) settle. */
export async function settle(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
