/**
 * Services end to end: real child processes driven over the socket, with the
 * notifications a client would actually render from.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { LogLine, ServiceState, TaskProgress } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  record,
  SERVICE_SCRIPT,
  twoServiceConfig,
  waitFor,
} from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

afterAll(() => {
  cleanupStateHome();
});

/** The last state pushed for a target, which is what a dashboard row shows. */
function latest(states: Array<{ state: ServiceState }>, targetId: string): ServiceState | undefined {
  return states.filter((s) => s.state.targetId === targetId).at(-1)?.state;
}

function order(progress: TaskProgress[], targetId: string, state: string): number {
  return progress.findIndex((p) => p.targetId === targetId && p.state === state);
}

function textOf(lines: LogLine[], targetId: string): string {
  return lines
    .filter((l) => l.targetId === targetId)
    .map((l) => l.text)
    .join("\n");
}

describe("service lifecycle", () => {
  it("start pushes service.changed until the target is running", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const changes = record(client, "service.changed");

    const run = await client.request("service.start", { targets: ["api"] });
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.ok).toBe(true);

    await waitFor(() => latest(changes, "api")?.status === "running", "api to report running");

    const state = latest(changes, "api");
    expect(state?.pid).toBeGreaterThan(0);
    expect(state?.stale).toBe(false);
    expect(changes.map((c) => c.state.status)).toContain("starting");

    const snapshot = await client.request("workspace.snapshot", {});
    const api = snapshot.services.find((s) => s.targetId === "api");
    expect(api?.status).toBe("running");
    expect(api?.pid).toBe(state?.pid);

    const status = await client.request("daemon.status", {});
    expect(status.runningServices).toBe(1);
  });

  it("reports a crashed service with its exit code", async () => {
    const ws = createWorkspace(
      {
        repos: { boom: { path: "boom", scripts: { start: "printf 'dying\\n'; exit 7" } } },
        profiles: { all: { default: true, targets: ["boom"] } },
      },
      ["boom"],
    );
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const changes = record(client, "service.changed");

    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    await waitFor(() => latest(changes, "boom")?.status === "crashed", "boom to crash");

    const state = latest(changes, "boom");
    expect(state?.exitCode).toBe(7);
    expect(state?.lastError).toContain("7");
    // Default policy is no auto-restart (SPEC §5.3).
    expect(state?.restartAttempts).toBe(0);

    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.services.find((s) => s.targetId === "boom")?.status).toBe("crashed");
  });

  it("starts dependencies before dependents", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const events: TaskProgress[] = [];
    client.on("task.progress", (p) => events.push(p.progress));
    const changes = record(client, "service.changed");

    const run = await client.request("service.start", {});
    const result = await client.request("run.await", { runId: run.runId });

    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["api", "web"]);

    await waitFor(() => order(events, "web", "ok") >= 0, "web to finish starting");
    // `web` dependsOn `api`: it may not even begin before api has settled.
    expect(order(events, "web", "running")).toBeGreaterThan(order(events, "api", "ok"));

    // A start resolves at spawn; `running` follows once the grace period passes.
    await waitFor(
      () => latest(changes, "api")?.status === "running" && latest(changes, "web")?.status === "running",
      "both services to survive their start grace",
    );
    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.services.filter((s) => s.status === "running").map((s) => s.targetId)).toEqual([
      "api",
      "web",
    ]);
  });

  it("stops a service tree in reverse dependency order", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const started = await client.request("service.start", {});
    await client.request("run.await", { runId: started.runId });

    const events: TaskProgress[] = [];
    client.on("task.progress", (p) => events.push(p.progress));
    const stopped = await client.request("service.stop", {});
    const result = await client.request("run.await", { runId: stopped.runId });

    expect(result.ok).toBe(true);
    expect(order(events, "api", "running")).toBeGreaterThan(order(events, "web", "ok"));

    const status = await client.request("daemon.status", {});
    expect(status.runningServices).toBe(0);
  });
});

describe("logs", () => {
  it("streams subscribed targets live and backfills them from disk", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const lines: LogLine[] = [];
    client.on("log.line", (p) => lines.push(p.line));
    await client.request("logs.subscribe", { targetId: "api" });

    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    await waitFor(() => textOf(lines, "api").includes("ready"), "the live stdout line");
    await waitFor(() => textOf(lines, "api").includes("booting"), "the live stderr line");
    expect(lines.some((l) => l.stream === "stderr" && l.text.includes("booting"))).toBe(true);
    // Subscription is per target: `web` is running and chatty, and never arrives.
    expect(lines.filter((l) => l.targetId === "web")).toEqual([]);

    const restarted = await client.request("service.restart", { targets: ["api"] });
    await client.request("run.await", { runId: restarted.runId });
    await waitFor(
      () => textOf(lines, "api").split("ready").length > 2,
      "the second run's live output",
    );

    const backfill = await client.request("logs.read", { targetId: "api", lines: 200 });
    const text = backfill.lines.map((l) => l.text).join("\n");
    // Both runs survive the restart, with the lifecycle breadcrumbs between them.
    expect(text.split("ready").length).toBeGreaterThan(2);
    expect(text).toContain("spawned pid=");
    expect(text).toContain("exited");
    expect(backfill.lines.every((l) => l.targetId === "api")).toBe(true);
  });

  it("streams to a client that subscribed without attaching", async () => {
    // `u8 logs -f` never attaches: the subscription set is the whole opt-in.
    const ws = createWorkspace(
      { repos: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } } },
      ["api"],
    );
    const driver = await connect(ws);
    const watcher = await connect(ws);

    const lines: LogLine[] = [];
    watcher.on("log.line", (p) => lines.push(p.line));
    await watcher.request("logs.subscribe", { targetId: "api" });

    const run = await driver.request("service.start", { targets: ["api"] });
    await driver.request("run.await", { runId: run.runId });

    await waitFor(() => lines.some((l) => l.text.includes("ready")), "a line on the unattached client");
  });

  it("stops streaming after logs.unsubscribe", async () => {
    const ws = createWorkspace(
      { repos: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } } },
      ["api"],
    );
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const lines: LogLine[] = [];
    client.on("log.line", (p) => lines.push(p.line));

    await client.request("logs.subscribe", { targetId: "api" });
    const run = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: run.runId });
    await waitFor(() => lines.length > 0, "the first line");

    await client.request("logs.unsubscribe", { targetId: "api" });
    const seen = lines.length;

    const stopped = await client.request("service.stop", { targets: ["api"] });
    await client.request("run.await", { runId: stopped.runId });
    // The stop writes `u8` notices to the same stream; none may reach us now.
    expect(lines.length).toBe(seen);
  });
});
