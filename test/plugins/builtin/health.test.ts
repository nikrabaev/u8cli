import fs from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadWorkspace, normalizeWorkspace, type RawHealth, type RawWorkspaceConfig } from "../../../src/config/index.js";
import { findApp, type NormalizedWorkspace } from "../../../src/config/types.js";
import type { WorkspaceHolder } from "../../../src/daemon/contracts.js";
import type { ServiceStateAccess } from "../../../src/indicators/index.js";
import type { IndicatorTone, ServiceState } from "../../../src/ipc/protocol.js";
import type {
  HookContext,
  IndicatorContext,
  IndicatorResult,
  PluginBaseContext,
  PluginDefinition,
  ReadinessContext,
  ReadinessVerdict,
  TargetInfo,
} from "../../../src/plugin/types.js";
import healthPlugin, {
  createHealthPlugin,
  PLUGIN_NAME,
  probeHttp,
  STATUS_INDICATOR,
  statusResult,
  type HealthPluginOptions,
} from "../../../src/plugins/builtin/health.js";
import { exec } from "../../../src/process/index.js";
import type { ExecOptions } from "../../../src/process/types.js";
import { nullLogger } from "../../../src/util/logger.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function tempRoot(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-health-")));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface TestServer {
  readonly url: string;
  /** Requests the handler was entered for. */
  readonly requests: number;
  readonly openSockets: number;
  readonly closedSockets: number;
  close(): Promise<void>;
}

/** A real HTTP server on an ephemeral port, tracking requests and socket churn. */
async function startServer(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, nth: number) => void,
): Promise<TestServer> {
  const sockets = new Set<Socket>();
  let requests = 0;
  let open = 0;
  let closed = 0;

  const server = http.createServer((req, res) => {
    requests += 1;
    // A probe that walks away mid-response is normal here; it must not surface
    // as an unhandled 'error' and fail the run.
    res.on("error", () => {});
    handle(req, res, requests);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    open += 1;
    socket.on("close", () => {
      sockets.delete(socket);
      open -= 1;
      closed += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const api: TestServer = {
    url: `http://127.0.0.1:${port}/healthz`,
    get requests() {
      return requests;
    },
    get openSockets() {
      return open;
    },
    get closedSockets() {
      return closed;
    },
    close: async () => {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(() => api.close());
  return api;
}

/** A port nothing listens on, for the connection-refused path. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface FakeServices extends ServiceStateAccess {
  set(patch: Partial<ServiceState>): void;
}

/** Stands in for the supervisor: one target, whose state the test drives. */
function fakeServices(id = "api", initial: Partial<ServiceState> = {}): FakeServices {
  let state: ServiceState = { targetId: id, status: "stopped", stale: false, restartAttempts: 0, ...initial };
  return {
    state: () => ({ ...state }),
    states: () => [{ ...state }],
    set: (patch) => {
      state = { ...state, ...patch };
    },
  };
}

function runningState(id = "api"): ServiceState {
  return { targetId: id, status: "running", stale: false, restartAttempts: 0, pid: 4242, startedAt: Date.now() };
}

function stoppedState(id = "api"): ServiceState {
  return { targetId: id, status: "stopped", stale: false, restartAttempts: 0 };
}

interface Fixture {
  root: string;
  configPath: string;
  ws: NormalizedWorkspace;
  holder: WorkspaceHolder;
  target: TargetInfo;
}

interface FixtureOptions {
  root?: string;
  health?: RawHealth;
  env?: Record<string, string>;
  /** Writes `u8.jsonc` to disk, for the path that reads health defs from the file. */
  onDisk?: boolean;
}

/** One repo with an implicit app (`api`) rooted at a real temp directory. */
function makeFixture(opts: FixtureOptions = {}): Fixture {
  const root = opts.root ?? tempRoot();
  const configPath = path.join(root, "u8.jsonc");
  const raw: RawWorkspaceConfig = {
    name: "fixture",
    repos: {
      api: {
        path: ".",
        scripts: { start: "sleep 30" },
        ...(opts.health ? { health: opts.health } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      },
    },
  };
  if (opts.onDisk) fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf8");
  const ws = opts.onDisk ? loadWorkspace(root) : normalizeWorkspace(raw, configPath);
  return { root, configPath, ws, holder: { current: () => ws }, target: targetOf(ws, "api") };
}

function targetOf(ws: NormalizedWorkspace, id: string): TargetInfo {
  const app = findApp(ws, id);
  if (!app) throw new Error(`no app "${id}"`);
  return {
    id: app.id,
    baseId: app.baseId,
    instance: app.instance,
    repoName: app.repoName,
    name: app.name,
    implicit: app.implicit,
    cwd: app.cwd,
    scripts: { ...app.scripts },
    env: { ...app.env },
    ports: { ...app.ports },
    dependsOn: [...app.dependsOn],
    hasHealth: app.health !== undefined,
  };
}

function baseCtx(fx: Fixture): PluginBaseContext {
  return {
    workspace: { id: "fixture-id", name: "fixture", rootDir: fx.root, configPath: fx.configPath },
    logger: nullLogger,
    store: new Map<string, unknown>(),
    exec: (cmd: string, execOpts: ExecOptions = {}) =>
      exec(cmd, { cwd: fx.target.cwd, env: fx.target.env, ...execOpts }),
  };
}

function indicatorCtx(fx: Fixture, service?: ServiceState): IndicatorContext {
  return {
    ...baseCtx(fx),
    scope: "app",
    repo: { name: "api", baseName: "api", instance: "base", path: fx.root },
    target: fx.target,
    cwd: fx.target.cwd,
    service,
  };
}

function readinessCtx(fx: Fixture, service: ServiceState): ReadinessContext {
  return { ...baseCtx(fx), target: fx.target, service };
}

function hookCtx(fx: Fixture, command: string, ok = true): HookContext {
  return {
    ...baseCtx(fx),
    command,
    phase: "post",
    runId: "run-1",
    repo: { name: "api", baseName: "api", instance: "base", path: fx.root },
    target: fx.target,
    cwd: fx.target.cwd,
    result: { ok, exitCode: ok ? 0 : 1, durationMs: 1 },
  };
}

function plugin(fx: Fixture, opts: HealthPluginOptions = {}): PluginDefinition {
  return createHealthPlugin({ workspace: fx.holder, ...opts });
}

function valueOf(result: IndicatorResult): string {
  if (result === null || result === undefined) return "";
  return typeof result === "object" ? result.value : result;
}

function toneOf(result: IndicatorResult | undefined): IndicatorTone | undefined {
  return result !== null && typeof result === "object" ? result.tone : undefined;
}

interface Subscription {
  readonly values: string[];
  readonly results: IndicatorResult[];
  last(): string | undefined;
  dispose(): void;
}

/** Subscribes `health@status` the way the indicator registry does. */
async function subscribeStatus(def: PluginDefinition, ctx: IndicatorContext): Promise<Subscription> {
  const indicator = def.indicators?.[STATUS_INDICATOR];
  if (!indicator?.subscribe) throw new Error("health@status must define subscribe()");
  const results: IndicatorResult[] = [];
  const values: string[] = [];
  const disposer = await indicator.subscribe(ctx, (result) => {
    results.push(result);
    values.push(valueOf(result));
  });
  const dispose = (): void => {
    if (typeof disposer === "function") disposer();
  };
  cleanups.push(dispose);
  return { values, results, last: () => values.at(-1), dispose };
}

async function runHook(def: PluginDefinition, command: string, ctx: HookContext): Promise<void> {
  await def.hooks?.[command]?.post?.(ctx);
}

async function readiness(def: PluginDefinition, ctx: ReadinessContext): Promise<ReadinessVerdict> {
  if (!def.readiness) throw new Error("health must define readiness()");
  return await def.readiness(ctx);
}

function countLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0).length;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("health plugin definition", () => {
  it("is an app-scoped, event-mode plugin named health", () => {
    expect(healthPlugin.name).toBe(PLUGIN_NAME);
    const status = healthPlugin.indicators?.[STATUS_INDICATOR];
    expect(status).toBeDefined();
    expect(status?.scope).toBe("app");
    expect(status?.update).toEqual({ mode: "event" });
    expect(typeof status?.subscribe).toBe("function");
    expect(typeof healthPlugin.readiness).toBe("function");
  });

  it("renders each status with its tone", () => {
    expect(statusResult("healthy")).toEqual({ value: "healthy", tone: "ok" });
    expect(statusResult("unhealthy")).toEqual({ value: "unhealthy", tone: "error" });
    expect(statusResult("starting")).toEqual({ value: "starting", tone: "info" });
    expect(statusResult("n/a")).toEqual({ value: "n/a", tone: "muted" });
  });
});

// ---------------------------------------------------------------------------
// HTTP probes
// ---------------------------------------------------------------------------

describe("http probes", () => {
  it("goes starting → healthy once a 2xx answers", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 25, timeout: 500, threshold: 2 } });
    const services = fakeServices("api", runningState());
    const sub = await subscribeStatus(plugin(fx, { services }), indicatorCtx(fx));

    expect(sub.values[0]).toBe("starting");
    await waitFor(() => sub.last() === "healthy", "the first probe to succeed");
    expect(toneOf(sub.results.at(-1))).toBe("ok");
    expect(server.requests).toBeGreaterThanOrEqual(1);
  });

  it("treats a 3xx as healthy and a 4xx/5xx as a failure", async () => {
    const redirect = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/elsewhere");
      res.end();
    });
    const fxOk = makeFixture({ health: { http: redirect.url, interval: 25, timeout: 500, threshold: 1 } });
    const okSub = await subscribeStatus(
      plugin(fxOk, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fxOk),
    );
    await waitFor(() => okSub.last() === "healthy", "a 302 to count as healthy");

    const failing = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const fxBad = makeFixture({ health: { http: failing.url, interval: 25, timeout: 500, threshold: 1 } });
    const badSub = await subscribeStatus(
      plugin(fxBad, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fxBad),
    );
    await waitFor(() => badSub.last() === "unhealthy", "a 503 to count as a failure");
    expect(toneOf(badSub.results.at(-1))).toBe("error");
  });

  it("counts a refused connection as a failure", async () => {
    const port = await closedPort();
    const fx = makeFixture({
      health: { http: `http://127.0.0.1:${port}/healthz`, interval: 25, timeout: 500, threshold: 2 },
    });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "unhealthy", "two refused connections");
    expect(sub.values).toEqual(["starting", "unhealthy"]);
  });

  it("flips only on the Nth consecutive failure", async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const fx = makeFixture({ health: { http: server.url, interval: 60, timeout: 500, threshold: 3 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => server.requests >= 2, "two failed probes");
    expect(sub.last()).toBe("starting");

    await waitFor(() => sub.last() === "unhealthy", "the third failure to flip the row");
    expect(server.requests).toBe(3);
  });

  it("resets the failure count on one success", async () => {
    // fail, fail, succeed, then fail three times: the reset means the last run
    // needs all three to flip, and the two before it must not.
    const script = [500, 500, 200, 500, 500, 500];
    const server = await startServer((_req, res) => {
      res.statusCode = script[server.requests - 1] ?? 500;
      res.end();
    });
    const fx = makeFixture({ health: { http: server.url, interval: 40, timeout: 500, threshold: 3 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "healthy", "the success after two failures");
    expect(server.requests).toBe(3);

    await waitFor(() => server.requests >= 5, "two failures after the success");
    expect(sub.last()).toBe("healthy");

    await waitFor(() => sub.last() === "unhealthy", "three consecutive failures");
    expect(server.requests).toBe(6);
  });

  it("gives up at timeoutMs and destroys the socket", async () => {
    const server = await startServer(() => {
      // Never answers: the probe must be the one to end this.
    });
    const fx = makeFixture({ health: { http: server.url, interval: 400, timeout: 100, threshold: 1 } });
    const startedAt = Date.now();
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "unhealthy", "the probe to time out");
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(350);

    await waitFor(() => server.closedSockets >= 1, "the timed-out socket to be destroyed");
    expect(server.openSockets).toBe(0);
  });

  it("leaves no socket behind across a run of successful probes", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => server.requests >= 6, "six probes");
    await delay(120);

    // One socket per probe, every one of them closed. A probe that landed in a
    // keep-alive pool would leave `requests` ahead of `closedSockets` — a file
    // descriptor per target held for the daemon's whole uptime.
    expect(sub.last()).toBe("healthy");
    expect(server.closedSockets).toBe(server.requests);
    expect(server.openSockets).toBe(0);
  });

  it("never runs two probes for one target at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const server = await startServer((_req, res) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.end("ok");
      }, 120);
    });
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 2_000, threshold: 2 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "healthy", "the first slow probe to land");
    await delay(300);
    expect(peak).toBe(1);
    // A probe every 20 ms would be ~20 requests; one at a time caps it far lower.
    expect(server.requests).toBeLessThanOrEqual(5);
  });
});

describe("http probe edge cases", () => {
  it("fails a malformed URL and an unsupported protocol without throwing", async () => {
    await expect(probeHttp("not a url", 100)).resolves.toMatchObject({ ok: false });
    const outcome = await probeHttp("ftp://127.0.0.1/healthz", 100);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("protocol");
  });

  it("fails an https URL nothing answers", async () => {
    const port = await closedPort();
    const outcome = await probeHttp(`https://127.0.0.1:${port}/healthz`, 500);
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmd probes
// ---------------------------------------------------------------------------

describe("cmd probes", () => {
  it("runs in the app cwd with its merged env and treats exit 0 as healthy", async () => {
    const root = tempRoot();
    const fx = makeFixture({
      root,
      env: { HEALTH_MARK: "ok" },
      health: {
        cmd: `test "$(pwd)" = ${JSON.stringify(root)} && test "$HEALTH_MARK" = ok`,
        interval: 30,
        timeout: 2_000,
        threshold: 1,
      },
    });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "healthy", "the cmd probe to pass");
  });

  it("flips to unhealthy after `threshold` non-zero exits", async () => {
    const root = tempRoot();
    const log = path.join(root, "probes.log");
    const fx = makeFixture({
      root,
      health: {
        cmd: `echo tick >> ${JSON.stringify(log)}; exit 3`,
        interval: 50,
        timeout: 2_000,
        threshold: 2,
      },
    });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "unhealthy", "two failing cmd probes");
    expect(countLines(log)).toBe(2);
  });

  it("kills a hung probe at timeoutMs instead of waiting it out", async () => {
    const fx = makeFixture({ health: { cmd: "sleep 30", interval: 300, timeout: 120, threshold: 1 } });
    const startedAt = Date.now();
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => sub.last() === "unhealthy", "the hung cmd probe to be killed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("reports n/a and never probes while the service is stopped", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices() }),
      indicatorCtx(fx, stoppedState()),
    );

    expect(sub.values).toEqual(["n/a"]);
    await delay(120);
    expect(server.requests).toBe(0);
    expect(sub.last()).toBe("n/a");
  });

  it("reports n/a for an app that declares no health check", async () => {
    const fx = makeFixture();
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await delay(60);
    expect(sub.values).toEqual(["n/a"]);
  });

  it("starts probing when the service comes up and stops when it goes away", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const services = fakeServices();
    const sub = await subscribeStatus(plugin(fx, { services }), indicatorCtx(fx));

    expect(sub.last()).toBe("n/a");
    services.set(runningState());
    await waitFor(() => sub.last() === "healthy", "health to go green after the spawn");
    expect(sub.values).toEqual(["n/a", "starting", "healthy"]);

    services.set({ status: "stopped", pid: undefined, startedAt: undefined });
    await waitFor(() => sub.last() === "n/a", "health to go n/a after the stop");
    const settled = server.requests;
    await delay(120);
    expect(server.requests).toBe(settled);
  });

  it("starts over at `starting` when the process is replaced", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const services = fakeServices("api", runningState());
    const sub = await subscribeStatus(plugin(fx, { services }), indicatorCtx(fx));

    await waitFor(() => sub.last() === "healthy", "the first run to go green");
    services.set({ startedAt: Date.now() + 1, pid: 5151 });
    await waitFor(() => sub.values.slice(2).includes("starting"), "the new run to reset the verdict");
    await waitFor(() => sub.last() === "healthy", "the new run to go green");
  });

  it("takes lifecycle edges from the app:start / app:stop hooks when no service accessor is wired", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 25, timeout: 500, threshold: 1 } });
    // No `services`: this is the default export's world.
    const def = plugin(fx);
    const sub = await subscribeStatus(def, indicatorCtx(fx, stoppedState()));

    expect(sub.last()).toBe("n/a");
    await delay(60);
    expect(server.requests).toBe(0);

    await runHook(def, "app:start", hookCtx(fx, "app:start"));
    await waitFor(() => sub.last() === "healthy", "probing to start after app:start");

    await runHook(def, "app:stop", hookCtx(fx, "app:stop"));
    await waitFor(() => sub.last() === "n/a", "probing to stop after app:stop");
    const settled = server.requests;
    await delay(90);
    expect(server.requests).toBe(settled);
  });

  it("falls back to n/a when a reload drops the target's health check", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const root = tempRoot();
    const before = makeFixture({ root, health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const after = makeFixture({ root });
    let live = before.ws;
    const def = createHealthPlugin({
      workspace: { current: () => live },
      services: fakeServices("api", runningState()),
    });

    const green = await subscribeStatus(def, indicatorCtx(before));
    await waitFor(() => green.last() === "healthy", "the check to go green");
    green.dispose();

    // The reload re-binds every provider, so the target comes back without a
    // check. Its monitor is the same one: it has to forget the old verdict.
    live = after.ws;
    const reloaded = await subscribeStatus(def, indicatorCtx(after));
    expect(reloaded.values).toEqual(["n/a"]);

    const settled = server.requests;
    await delay(100);
    expect(server.requests).toBe(settled);
  });

  it("does not arm on a failed start", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const def = plugin(fx);
    const sub = await subscribeStatus(def, indicatorCtx(fx, stoppedState()));

    await runHook(def, "app:start", hookCtx(fx, "app:start", false));
    await delay(80);
    expect(server.requests).toBe(0);
    expect(sub.last()).toBe("n/a");
  });
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe("disposal", () => {
  it("stops the loop and aborts an in-flight probe", async () => {
    const server = await startServer(() => {
      // Hangs, so a probe is guaranteed to be in flight at dispose time.
    });
    const fx = makeFixture({ health: { http: server.url, interval: 30, timeout: 5_000, threshold: 1 } });
    const sub = await subscribeStatus(
      plugin(fx, { services: fakeServices("api", runningState()) }),
      indicatorCtx(fx),
    );

    await waitFor(() => server.openSockets === 1, "a probe to be in flight");
    const emitted = sub.values.length;
    sub.dispose();

    await waitFor(() => server.closedSockets >= 1, "the in-flight probe to be aborted");
    await delay(150);
    expect(server.requests).toBe(1);
    expect(sub.values.length).toBe(emitted);
  });

  it("teardown aborts what every monitor still has in flight", async () => {
    const server = await startServer(() => {
      // Hangs.
    });
    const fx = makeFixture({ health: { http: server.url, interval: 30, timeout: 5_000, threshold: 1 } });
    const def = plugin(fx, { services: fakeServices("api", runningState()) });
    await subscribeStatus(def, indicatorCtx(fx));

    await waitFor(() => server.openSockets === 1, "a probe to be in flight");
    await def.teardown?.();
    await waitFor(() => server.closedSockets >= 1, "teardown to abort the probe");
  });
});

// ---------------------------------------------------------------------------
// Readiness (dependsOn gating)
// ---------------------------------------------------------------------------

describe("readiness", () => {
  it("is n/a for a target with no health check, so dependents fall back to `running`", async () => {
    const fx = makeFixture();
    const def = plugin(fx);

    expect(await readiness(def, readinessCtx(fx, runningState()))).toBe("n/a");
    expect(await readiness(def, readinessCtx(fx, stoppedState()))).toBe("n/a");
  });

  it("is n/a while the service is not running, and probes nothing", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const def = plugin(fx);

    expect(await readiness(def, readinessCtx(fx, stoppedState()))).toBe("n/a");
    expect(await readiness(def, readinessCtx(fx, { ...stoppedState(), status: "crashed" }))).toBe("n/a");
    await delay(50);
    expect(server.requests).toBe(0);
  });

  it("is pending until the first probe succeeds, then ready — driving the probes itself", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const def = plugin(fx);
    const state = runningState();

    // No subscription at all: gating is the only thing running probes here.
    expect(await readiness(def, readinessCtx(fx, state))).toBe("pending");

    let verdict: ReadinessVerdict = "pending";
    const deadline = Date.now() + 3_000;
    while (verdict !== "ready" && Date.now() < deadline) {
      await delay(10);
      verdict = await readiness(def, readinessCtx(fx, state));
    }
    expect(verdict).toBe("ready");
    expect(server.requests).toBeGreaterThanOrEqual(1);
  });

  it("stays pending while the target is unhealthy", async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const fx = makeFixture({ health: { http: server.url, interval: 20, timeout: 500, threshold: 1 } });
    const services = fakeServices("api", runningState());
    const def = plugin(fx, { services });
    const sub = await subscribeStatus(def, indicatorCtx(fx));

    await waitFor(() => sub.last() === "unhealthy", "the target to go red");
    expect(await readiness(def, readinessCtx(fx, services.state("api")))).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Health defs read from the workspace config
// ---------------------------------------------------------------------------

describe("health definitions", () => {
  it("reads the check from the workspace config when no live workspace is wired", async () => {
    const server = await startServer((_req, res) => res.end("ok"));
    const root = tempRoot();
    const fx = makeFixture({
      root,
      onDisk: true,
      health: { http: server.url, interval: 25, timeout: 500, threshold: 1 },
    });
    // Only `services`: the check itself has to come off disk.
    const def = createHealthPlugin({ services: fakeServices("api", runningState()) });
    const sub = await subscribeStatus(def, indicatorCtx(fx));

    await waitFor(() => sub.last() === "healthy", "the config-file check to drive a probe");
    expect(fx.target.hasHealth).toBe(true);
  });
});
