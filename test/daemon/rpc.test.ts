/**
 * The RPC surface: snapshots, commands, profiles, reload and param validation,
 * all driven over a real socket against a real daemon.
 */
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskProgress } from "../../src/ipc/protocol.js";
import { isU8Error } from "../../src/util/errors.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonPid,
  markerService,
  record,
  SERVICE_SCRIPT,
  twoServiceConfig,
  waitFor,
  waitForPidGone,
} from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

afterAll(() => {
  cleanupStateHome();
});

/** Ignores SIGTERM, so stopping it takes the whole stop timeout. */
const STUBBORN_SERVICE = "trap '' TERM; printf 'ready\\n'; while true; do sleep 0.1; done";

/** A workspace with a scriptless app, so `appliesTo` has something to exclude. */
function mixedConfig(): Record<string, unknown> {
  return twoServiceConfig({
    apps: {
      api: { path: "api", scripts: { start: SERVICE_SCRIPT } },
      web: { path: "web", scripts: { start: SERVICE_SCRIPT }, dependsOn: ["api"] },
      docs: { path: "docs" },
    },
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe("snapshot", () => {
  it("client.attach returns a coherent view of the workspace", async () => {
    const ws = createWorkspace(mixedConfig(), ["api", "web", "docs"]);
    const client = await connect(ws);

    const snapshot = await client.request("client.attach", { clientVersion: "test", interactive: true });

    expect(snapshot.protocolVersion).toBe(1);
    expect(snapshot.workspace.configPath).toBe(ws.configPath);
    expect(snapshot.workspace.id).toBe(ws.paths.id);
    expect(snapshot.apps.map((a) => a.name)).toEqual(["api", "web", "docs"]);
    // Every app here is subapp-less, so each renders as one implicit subapp.
    expect(snapshot.apps.every((a) => a.subapps.length === 1 && a.subapps[0]?.implicit)).toBe(true);
    expect(snapshot.apps.find((a) => a.name === "web")?.subapps[0]?.dependsOn).toEqual(["api"]);

    expect(snapshot.activeProfile).toBe("all");
    expect(snapshot.profiles.find((p) => p.name === "all")?.subappIds).toEqual(["api", "web"]);
    expect(snapshot.services.map((s) => s.targetId)).toEqual(["api", "web", "docs"]);
    expect(snapshot.services.every((s) => s.status === "stopped")).toBe(true);
    // The git and health built-ins are enabled unless config disables them.
    expect(snapshot.plugins.map((p) => p.name).sort()).toEqual(["git", "health"]);
    expect(snapshot.plugins.every((p) => p.ok)).toBe(true);
    expect(snapshot.configError).toBeUndefined();
    expect(snapshot.templates.subapp).toContain("{app@status");

    const commands = new Map(snapshot.commands.map((c) => [c.name, c]));
    // `docs` has no start script, so starting does not apply to it — but the
    // core stop falls back to signalling the group and applies everywhere.
    expect(commands.get("app:start")?.appliesTo).toEqual(["api", "web"]);
    expect(commands.get("app:restart")?.appliesTo).toEqual(["api", "web"]);
    expect(commands.get("app:stop")?.appliesTo).toEqual(["api", "web", "docs"]);
    expect(commands.get("app:start")?.source).toBe("core");
    expect(commands.get("hello")?.appliesTo).toEqual(["api", "web", "docs"]);
    expect(commands.get("hello")?.kind).toBe("task");

    // Core indicators are live before anything is started.
    const names = new Set(snapshot.indicators.map((i) => `${i.ns}@${i.name}`));
    expect(names.has("app@name")).toBe(true);
    expect(names.has("app@status")).toBe(true);
  });

  it("workspace.snapshot answers without subscribing the connection", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const observer = await connect(ws);
    const driver = await connect(ws);

    // The observer only ever asks for a snapshot; it never attaches.
    const seen = await observer.request("workspace.snapshot", {});
    expect(seen.activeProfile).toBe("all");
    const changes = record(observer, "service.changed");

    await driver.request("client.attach", { clientVersion: "test" });
    const attachedChanges = record(driver, "service.changed");
    const run = await driver.request("service.start", { targets: ["api"] });
    await driver.request("run.await", { runId: run.runId });

    await waitFor(() => attachedChanges.length > 0, "the attached client to see a transition");
    expect(changes).toEqual([]);
  });
});

describe("commands", () => {
  it("runs a command across targets, streaming progress and a result", async () => {
    const ws = createWorkspace(mixedConfig(), ["api", "web", "docs"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const events: TaskProgress[] = [];
    client.on("task.progress", (p) => events.push(p.progress));
    const finished = record(client, "task.finished");

    const run = await client.request("command.run", {
      command: "hello",
      targets: ["api", "web", "docs"],
    });
    const result = await client.request("run.await", { runId: run.runId });

    expect(result.runId).toBe(run.runId);
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["api", "web", "docs"]);
    expect(result.targets.every((t) => t.state === "ok" && t.exitCode === 0)).toBe(true);
    expect(result.targets.every((t) => (t.logPath ?? "").length > 0)).toBe(true);

    for (const id of ["api", "web", "docs"]) {
      const states = events.filter((e) => e.targetId === id).map((e) => e.state);
      expect(states, `progress for ${id}`).toEqual(["pending", "running", "ok"]);
    }
    await waitFor(() => finished.length === 1, "the task.finished notification");
    expect(finished[0]?.result.runId).toBe(run.runId);

    // The per-(run, target) log is readable through the same method as service logs.
    const log = await client.request("logs.read", { targetId: "web", runId: run.runId, lines: 50 });
    expect(log.lines.map((l) => l.text).join("\n")).toContain("hello from web");
    expect(log.lines.every((l) => l.runId === run.runId)).toBe(true);
  });

  it("answers with a run id before the run finishes", async () => {
    const ws = createWorkspace(
      twoServiceConfig({
        commands: { slow: { script: "sleep 0.4; printf 'done\\n'" } },
      }),
      ["api", "web"],
    );
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const startedAt = Date.now();
    const run = await client.request("command.run", { command: "slow", targets: ["api"] });
    const replied = Date.now() - startedAt;

    expect(run.runId).toMatch(/\w/);
    expect(replied).toBeLessThan(300);

    const result = await client.request("run.await", { runId: run.runId });
    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    // Retained: awaiting a second time answers from the same record.
    expect((await client.request("run.await", { runId: run.runId })).runId).toBe(run.runId);
  });

  it("rejects unknown commands, targets and profiles with precise codes", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);

    const unknownCommand = await failure(client.request("command.run", { command: "nope" }));
    expect(isU8Error(unknownCommand) && unknownCommand.code).toBe("UNKNOWN_COMMAND");

    const unknownTarget = await failure(client.request("logs.read", { targetId: "ghost" }));
    expect(isU8Error(unknownTarget) && unknownTarget.code).toBe("UNKNOWN_TARGET");

    const badTargets = await failure(
      client.request("service.start", { targets: [7] as unknown as string[] }),
    );
    expect(isU8Error(badTargets) && badTargets.code).toBe("UNKNOWN_TARGET");

    const unknownProfile = await failure(client.request("profile.use", { name: "ghost" }));
    expect(isU8Error(unknownProfile) && unknownProfile.code).toBe("UNKNOWN_PROFILE");

    const unknownRun = await failure(client.request("run.await", { runId: "nope" }));
    expect(isU8Error(unknownRun)).toBe(true);

    // The daemon is unharmed by all of that.
    expect((await client.request("daemon.ping", {})).pong).toBe(true);
  });
});

describe("profiles", () => {
  it("persists the active profile across a daemon restart", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);

    expect((await client.request("workspace.snapshot", {})).activeProfile).toBe("all");
    const used = await client.request("profile.use", { name: "api-only" });
    expect(used).toEqual({ ok: true, activeProfile: "api-only" });
    expect((await client.request("workspace.snapshot", {})).activeProfile).toBe("api-only");

    const pid = daemonPid(ws);
    await client.request("daemon.stop", {});
    expect(await waitForPidGone(pid ?? 0, 5_000)).toBe(true);
    await client.close();

    const revived = await connect(ws);
    const snapshot = await revived.request("workspace.snapshot", {});
    expect(snapshot.activeProfile).toBe("api-only");
    expect(daemonPid(ws)).not.toBe(pid);

    // And it is the profile an untargeted run resolves against.
    const run = await revived.request("service.start", {});
    const result = await revived.request("run.await", { runId: run.runId });
    expect(result.targets.map((t) => t.targetId)).toEqual(["api"]);
  });
});

describe("profile persistence failures", () => {
  it("does not switch profile when the state file cannot be written", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    // A directory where the state file goes: the atomic rename cannot land.
    fs.mkdirSync(ws.paths.stateFile, { recursive: true });

    const client = await connect(ws);
    const rejected = await failure(client.request("profile.use", { name: "api-only" }));
    expect(rejected).toBeInstanceOf(Error);

    // The daemon must not be left running a profile it could not remember —
    // the next untargeted start would silently act on the wrong target set.
    expect((await client.request("workspace.snapshot", {})).activeProfile).toBe("all");

    const run = await client.request("service.start", {});
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.targets.map((t) => t.targetId)).toEqual(["api", "web"]);
  });
});

describe("shutting down", () => {
  /**
   * A service started inside the shutdown window is a process no daemon will
   * ever own again: this one is torn down, the next one reports the target
   * `stopped`, and the following `u8 start` runs a second copy of it.
   */
  it("refuses to start anything once shutdown has begun", async () => {
    const ws = createWorkspace(
      (dir) => ({
        // Long enough that the RPCs below land while the first daemon.stop is
        // still waiting out the service it cannot terminate politely.
        limits: { stopTimeout: 2_000 },
        apps: {
          api: { path: "api", scripts: { start: STUBBORN_SERVICE } },
          late: { path: "late", scripts: { start: markerService(`${dir}/late.pid`) } },
        },
        profiles: { all: { default: true, targets: ["api", "late"] } },
        commands: { hello: { script: "printf 'hello\\n'" } },
      }),
      ["api", "late"],
    );
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const started = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: started.runId });
    const pid = daemonPid(ws);
    expect(pid).toBeDefined();

    await client.request("daemon.stop", {});

    for (const attempt of [
      client.request("service.start", { targets: ["late"] }),
      client.request("service.restart", { targets: ["late"] }),
      client.request("command.run", { command: "hello", targets: ["late"] }),
    ]) {
      const rejected = await failure(attempt);
      expect(isU8Error(rejected) && rejected.code).toBe("RPC_ERROR");
      expect((rejected as Error).message).toContain("shutting down");
    }

    // Reads still answer, and stopping is exactly what a shutting-down daemon
    // should still accept.
    expect((await client.request("daemon.ping", {})).pong).toBe(true);
    expect((await client.request("service.stop", { targets: ["api"] })).runId).toMatch(/\w/);

    expect(await waitForPidGone(pid ?? 0, 10_000)).toBe(true);
    // Nothing was spawned, so there is nothing left behind.
    expect(fs.existsSync(ws.file("late.pid"))).toBe(false);
  });
});

describe("reload", () => {
  it("picks up an edited config and marks a running service stale", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const reloads = record(client, "config.reloaded");
    const changes = record(client, "service.changed");

    const run = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: run.runId });
    await waitFor(
      () => changes.some((c) => c.state.targetId === "api" && c.state.status === "running"),
      "api to be running",
    );

    ws.rewrite(
      twoServiceConfig({
        apps: {
          api: { path: "api", scripts: { start: `printf 'v2\\n'; ${SERVICE_SCRIPT}` } },
          web: { path: "web", scripts: { start: SERVICE_SCRIPT }, dependsOn: ["api"] },
        },
      }),
    );

    const reloaded = await client.request("workspace.reload", {});
    expect(reloaded).toEqual({ ok: true });

    await waitFor(() => reloads.length === 1, "the config.reloaded notification");
    expect(reloads[0]?.ok).toBe(true);
    expect(reloads[0]?.stale).toEqual(["api"]);
    // The snapshot rides along so a client re-renders from one payload.
    expect(reloads[0]?.snapshot?.apps.find((a) => a.name === "api")).toBeDefined();

    const snapshot = await client.request("workspace.snapshot", {});
    const api = snapshot.services.find((s) => s.targetId === "api");
    expect(api?.stale).toBe(true);
    expect(api?.status).toBe("running"); // untouched: it keeps its spawn-time definition

    // Restarting adopts the new definition and clears the flag.
    const restart = await client.request("service.restart", { targets: ["api"] });
    await client.request("run.await", { runId: restart.runId });
    await waitFor(
      () => changes.filter((c) => c.state.targetId === "api").at(-1)?.state.stale === false,
      "the stale flag to clear",
    );
  });

  it("keeps serving a target the config dropped while it was running", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const changes = record(client, "service.changed");

    const run = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: run.runId });
    await waitFor(
      () => changes.filter((c) => c.state.targetId === "api").at(-1)?.state.status === "running",
      "api to be running",
    );

    ws.rewrite({
      apps: { web: { path: "web", scripts: { start: SERVICE_SCRIPT } } },
      profiles: { all: { default: true, targets: ["web"] } },
    });
    expect(await client.request("workspace.reload", {})).toEqual({ ok: true });

    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.apps.map((a) => a.name)).toEqual(["web"]);
    // The process outlived its definition: it is still owned, still reported,
    // and now stale — its logs have to stay reachable.
    const api = snapshot.services.find((s) => s.targetId === "api");
    expect(api?.status).toBe("running");
    expect(api?.stale).toBe(true);
    expect((await client.request("logs.read", { targetId: "api", lines: 20 })).lines.length).toBeGreaterThan(0);

    // Indicators were re-bound to the new workspace: the owner is gone, so its
    // cells are gone with it, and nothing renders a row for a vanished app.
    const owners = new Set(snapshot.indicators.map((i) => i.owner));
    expect(owners.has("web")).toBe(true);
    expect(owners.has("api")).toBe(false);

    // Stop resolution unions the configured targets with whatever the
    // supervisor still owns, so the orphan stays addressable by id rather than
    // surviving until daemon shutdown.
    const runId = (await client.request("service.stop", { targets: ["api"] })).runId;
    expect((await client.request("run.await", { runId })).ok).toBe(true);
    await waitFor(
      () => changes.filter((c) => c.state.targetId === "api").at(-1)?.state.status === "stopped",
      "the orphaned api to stop",
    );
    expect((await client.request("daemon.status", {})).runningServices).toBe(0);
  });

  it("falls back to the default profile when the active one is deleted", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("profile.use", { name: "api-only" });

    const stripped = twoServiceConfig();
    delete (stripped["profiles"] as Record<string, unknown>)["api-only"];
    ws.rewrite(stripped);

    expect(await client.request("workspace.reload", {})).toEqual({ ok: true });
    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.profiles.map((p) => p.name)).toEqual(["all"]);
    expect(snapshot.activeProfile).toBe("all");

    // The fallback drives resolution too, rather than throwing on every run.
    const run = await client.request("service.start", {});
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.targets.map((t) => t.targetId)).toEqual(["api", "web"]);
  });

  it("keeps the last-good config when the edit is broken", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const reloads = record(client, "config.reloaded");

    const run = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: run.runId });

    ws.rewrite({ apps: { api: {} } }); // `path` is required

    const reloaded = await client.request("workspace.reload", {});
    expect(reloaded.ok).toBe(false);
    expect(reloaded.error).toContain("path");

    await waitFor(() => reloads.length === 1, "the failed config.reloaded notification");
    expect(reloads[0]?.ok).toBe(false);

    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.configError).toContain("path");
    // Last-good config is still serving, and the service is still supervised.
    expect(snapshot.apps.map((a) => a.name)).toEqual(["api", "web"]);
    expect(snapshot.services.find((s) => s.targetId === "api")?.status).not.toBe("stopped");

    // A repaired file recovers without a restart.
    ws.rewrite(twoServiceConfig());
    expect(await client.request("workspace.reload", {})).toEqual({ ok: true });
    expect((await client.request("workspace.snapshot", {})).configError).toBeUndefined();
  });
});
