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
import type { TargetId } from "../../src/config/types.js";
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
  SnapshotSubapp,
} from "../../src/ipc/protocol.js";
import type { Scheduler } from "../../src/tui/controller.js";
import type { DashboardClient, Unsubscribe } from "../../src/tui/types.js";

// ---------------------------------------------------------------------------
// Snapshot fixtures
// ---------------------------------------------------------------------------

/** The workspace the CLI tests use: one merged-row app, one two-subapp app. */
export function fixtureSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const api = subapp("api");
  const web = subapp("platform", "web");
  const admin = subapp("platform", "admin");
  const ids = [api.id, web.id, admin.id];

  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.1.0",
    workspace: { id: "wsid", name: "fixture", rootDir: "/ws", configPath: "/ws/u8.jsonc" },
    templates: { app: "APP {app@name}", subapp: "SUB {app@name} {app@status}" },
    apps: [
      { name: "api", path: "/ws/api", subapps: [api] },
      { name: "platform", path: "/ws/platform", subapps: [web, admin] },
    ],
    profiles: [
      { name: "all", isDefault: true, subappIds: ids },
      { name: "frontend", isDefault: false, subappIds: [web.id] },
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
        indicator({ ns: "app", name: "name", scope: "subapp", owner: id, value: id.split(".").at(-1) ?? id }),
        statusIndicator(id, "stopped"),
      ]),
      indicator({ ns: "app", name: "name", scope: "app", owner: "api", value: "api" }),
      indicator({ ns: "app", name: "name", scope: "app", owner: "platform", value: "platform" }),
    ],
    plugins: [{ name: "git", spec: "git", ok: true }],
    ...overrides,
  };
}

export function subapp(appName: string, name?: string): SnapshotSubapp {
  const implicit = name === undefined;
  return {
    id: implicit ? appName : `${appName}.${name}`,
    appName,
    name: name ?? appName,
    implicit,
    cwd: `/ws/${appName}${implicit ? "" : `/${name}`}`,
    hasHealth: false,
    dependsOn: [],
    scripts: ["start"],
  };
}

export function serviceState(targetId: TargetId, status: ServiceStatus): ServiceState {
  return { targetId, status, stale: false, restartAttempts: 0 };
}

export function indicator(value: {
  ns: string;
  name: string;
  scope: "app" | "subapp";
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
  return { ns: "app", name: "status", scope: "subapp", owner, value: status, display: "●", tone };
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
  readonly calls: Array<{ method: RpcMethod; params: unknown }>;
  /** Log targets currently subscribed — must be empty once a view closes. */
  readonly subscribed: Set<TargetId>;
  readonly subscribeCalls: TargetId[];
  readonly unsubscribeCalls: TargetId[];
  /** Notification + connection listeners still registered, for leak checks. */
  listenerCount(): number;
  /** Lines `logs.read` backfills with. */
  readonly lines: LogLine[];
  paramsOf(method: RpcMethod): unknown[];
  push<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void;
  setSnapshot(next: Snapshot): void;
  disconnect(): void;
  reattach(next?: Snapshot): void;
  lose(err?: Error): void;
  /** Replaces the canned answer for one method. */
  answer<M extends RpcMethod>(method: M, fn: (params: RpcParams<M>) => RpcResult<M>): void;
  /** Makes every subsequent call to `method` reject. */
  fail(method: RpcMethod, err: Error): void;
}

export function createFakeClient(initial: Snapshot = fixtureSnapshot()): FakeClient {
  let snapshot = initial;
  let runs = 0;
  const calls: Array<{ method: RpcMethod; params: unknown }> = [];
  const subscribed = new Set<TargetId>();
  const subscribeCalls: TargetId[] = [];
  const unsubscribeCalls: TargetId[] = [];
  const lines: LogLine[] = [];
  const answers = new Map<RpcMethod, Answer>();
  const failures = new Map<RpcMethod, Error>();
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
        return { runId: `run-${++runs}` };
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

    request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      calls.push({ method, params });
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
