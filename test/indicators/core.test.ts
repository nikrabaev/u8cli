import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndicatorRegistry } from "../../src/daemon/contracts.js";
import {
  STATUS_GLYPH,
  aggregateStatus,
  createIndicatorRegistry,
  formatUptime,
} from "../../src/indicators/index.js";
import type { IndicatorValue, ServiceState, ServiceStatus } from "../../src/ipc/protocol.js";
import {
  FIXTURE_DIRS,
  cleanupRoots,
  delay,
  fakeServices,
  fixtureConfig,
  holderOf,
  makeWorkspace,
  recordingLogger,
  tempRoot,
  waitFor,
  type FakeServices,
  type MutableHolder,
} from "./helpers.js";

let root: string;
let holder: MutableHolder;
let services: FakeServices;
let registry: IndicatorRegistry;

/** Applies a state change the way the daemon does: patch, then nudge the cache. */
async function transition(id: string, patch: Partial<ServiceState>): Promise<void> {
  services.set(id, patch);
  registry.refresh([id]);
  await delay(60);
}

function cell(ns: string, name: string, owner: string): IndicatorValue | undefined {
  return registry.get(ns, name, owner);
}

beforeEach(() => {
  root = tempRoot(FIXTURE_DIRS);
  holder = holderOf(makeWorkspace(root, fixtureConfig()));
  services = fakeServices();
  registry = createIndicatorRegistry({ workspace: holder, logger: recordingLogger(), services });
});

afterEach(async () => {
  await registry.stop();
  cleanupRoots();
});

describe("identity providers", () => {
  it("reports name, dirname and path for both scopes", async () => {
    await registry.start();

    expect(cell("app", "name", "platform.shell")?.value).toBe("shell");
    expect(cell("app", "dirname", "platform.shell")?.value).toBe("shell");
    expect(cell("app", "path", "platform.shell")?.value).toBe(path.join(root, "platform/apps/shell"));

    const appName = registry.values().find((v) => v.scope === "app" && v.name === "name" && v.owner === "platform");
    expect(appName?.value).toBe("platform");
    const appDir = registry.values().find((v) => v.scope === "app" && v.name === "dirname" && v.owner === "platform");
    expect(appDir?.value).toBe("platform");
    const appPath = registry.values().find((v) => v.scope === "app" && v.name === "path" && v.owner === "platform");
    expect(appPath?.value).toBe(path.join(root, "platform"));
  });

  it("names an implicit subapp after its app", async () => {
    await registry.start();
    expect(cell("app", "name", "gateway")?.value).toBe("gateway");
    expect(cell("app", "path", "gateway")?.value).toBe(path.join(root, "gateway"));
  });
});

describe("subapp status", () => {
  const cases: Array<[ServiceStatus, string]> = [
    ["stopped", "muted"],
    ["starting", "info"],
    ["running", "ok"],
    ["crashed", "error"],
    ["stopping", "warn"],
  ];

  it.each(cases)("renders %s as a %s dot", async (status, tone) => {
    await registry.start();
    await transition("platform.shell", { status });

    expect(cell("app", "status", "platform.shell")).toMatchObject({
      value: status,
      display: STATUS_GLYPH,
      tone,
    });
  });

  it("collapses running-but-stale into `stale`", async () => {
    await registry.start();
    await transition("platform.shell", { status: "running", stale: true });

    expect(cell("app", "status", "platform.shell")).toMatchObject({ value: "stale", tone: "warn" });

    // Staleness only masks a *running* process; a stopped one still reads stopped.
    await transition("platform.shell", { status: "stopped", stale: true });
    expect(cell("app", "status", "platform.shell")?.value).toBe("stopped");
  });

  it("updates promptly on refresh instead of waiting for a poll", async () => {
    await registry.start();
    expect(cell("app", "status", "gateway")?.value).toBe("stopped");

    services.set("gateway", { status: "running", pid: 4242, startedAt: Date.now() });
    registry.refresh(["gateway"]);

    await waitFor(() => cell("app", "status", "gateway")?.value === "running", "the status to follow");
    expect(cell("app", "pid", "gateway")?.value).toBe("4242");
  });
});

describe("app status aggregation", () => {
  it("is stopped when nothing runs", async () => {
    await registry.start();
    expect(cell("app", "status", "platform")).toMatchObject({ value: "stopped", tone: "muted" });
  });

  it("is running only when every subapp runs", async () => {
    await registry.start();
    await transition("platform.shell", { status: "running" });
    // Half up is not "running", and nothing is in motion — the app reads stopped.
    expect(cell("app", "status", "platform")?.value).toBe("stopped");

    await transition("platform.auth", { status: "starting" });
    expect(cell("app", "status", "platform")).toMatchObject({ value: "starting", tone: "info" });

    await transition("platform.auth", { status: "running" });
    expect(cell("app", "status", "platform")).toMatchObject({ value: "running", tone: "ok" });
  });

  it("lets one crash colour the whole app", async () => {
    await registry.start();
    await transition("platform.shell", { status: "running" });
    await transition("platform.auth", { status: "crashed", exitCode: 1 });

    expect(cell("app", "status", "platform")).toMatchObject({ value: "crashed", tone: "error" });
    // The sibling row keeps its own truth.
    expect(cell("app", "status", "platform.shell")?.value).toBe("running");
  });

  it("aggregates over pure state, without a supervisor to ask", () => {
    const at = (status: ServiceStatus, stale = false): ServiceState => ({
      targetId: "x",
      status,
      stale,
      restartAttempts: 0,
    });

    expect(aggregateStatus([])).toBe("stopped");
    expect(aggregateStatus([at("running"), at("running")])).toBe("running");
    expect(aggregateStatus([at("running"), at("crashed")])).toBe("crashed");
    expect(aggregateStatus([at("stopping"), at("crashed")])).toBe("crashed");
    expect(aggregateStatus([at("starting"), at("stopped")])).toBe("starting");
    expect(aggregateStatus([at("running"), at("stopping")])).toBe("starting");
    expect(aggregateStatus([at("running"), at("stopped")])).toBe("stopped");
  });
});

describe("pid, exitcode and uptime", () => {
  it("shows a pid only while the process is alive", async () => {
    await registry.start();
    expect(cell("app", "pid", "gateway")?.value).toBe("");

    await transition("gateway", { status: "running", pid: 321 });
    expect(cell("app", "pid", "gateway")?.value).toBe("321");

    await transition("gateway", { status: "crashed", pid: 321, exitCode: 7 });
    expect(cell("app", "pid", "gateway")?.value).toBe("");
  });

  it("shows an exit code only once the process is finished", async () => {
    await registry.start();
    expect(cell("app", "exitcode", "gateway")?.value).toBe("");

    await transition("gateway", { status: "running", pid: 5, exitCode: 0 });
    expect(cell("app", "exitcode", "gateway")?.value).toBe("");

    await transition("gateway", { status: "crashed", exitCode: 137 });
    expect(cell("app", "exitcode", "gateway")?.value).toBe("137");

    // Killed by a signal: there is no code to show.
    await transition("gateway", { status: "stopped", exitCode: null, signal: "SIGTERM" });
    expect(cell("app", "exitcode", "gateway")?.value).toBe("");
  });

  it("humanizes uptime, and blanks it when the service is down", async () => {
    await registry.start();
    expect(cell("app", "uptime", "gateway")?.value).toBe("");

    await transition("gateway", { status: "running", pid: 9, startedAt: Date.now() - 12_000 });
    expect(cell("app", "uptime", "gateway")?.value).toBe("12s");

    await transition("gateway", { status: "crashed", exitCode: 1 });
    expect(cell("app", "uptime", "gateway")?.value).toBe("");
  });

  it("formats every uptime magnitude with at most two units", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(999)).toBe("0s");
    expect(formatUptime(12_400)).toBe("12s");
    expect(formatUptime(59_999)).toBe("59s");
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(4 * 60_000 + 30_000)).toBe("4m");
    expect(formatUptime(3_600_000)).toBe("1h0m");
    expect(formatUptime(3_600_000 + 3 * 60_000)).toBe("1h3m");
    expect(formatUptime(50 * 3_600_000)).toBe("2d2h");
    expect(formatUptime(-5_000)).toBe("0s");
  });
});
