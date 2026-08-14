/**
 * A config command declared `kind: "service"` (SPEC §2.5): its script must be
 * handed to the supervisor — with the same dependency ordering, readiness gating
 * and hook pipeline `app:start` gets — instead of being run to completion as a
 * task.
 *
 * The scripts here are harmless no-ops rather than long sleeps: the fake
 * supervisor only records them, and a regression that runs them as a task must
 * fail the assertions rather than hang the suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHarnesses,
  createHarness,
  resultFor,
  settled,
  statesByTarget,
  waitFor,
  type Harness,
} from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

const SHARED = "true # shared-debug";
const OVERRIDE = "true # gateway-debug";

/** db ← gateway ← web, plus a `kind: "service"` command over the first two. */
function debugStack(command: Record<string, unknown> = {}): Harness {
  return createHarness({
    dirs: ["db", "gateway", "web"],
    config: {
      apps: {
        db: { path: "db", scripts: { start: "true # db-start" } },
        gateway: { path: "gateway", scripts: { start: "true # gw-start" }, dependsOn: ["db"] },
        web: { path: "web", scripts: { start: "true # web-start" }, dependsOn: ["gateway"] },
      },
      commands: {
        "start.debug": {
          kind: "service",
          script: SHARED,
          targets: { gateway: OVERRIDE, web: null },
          ...command,
        },
      },
    },
  });
}

describe("config service commands", () => {
  it("supervises the per-target script instead of running it as a task", async () => {
    const h = debugStack();

    const result = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(result.ok).toBe(true);
    expect(result.command).toBe("start.debug");
    expect(h.supervisor.events.map((e) => [e.kind, e.id, e.script, e.via])).toEqual([
      ["start", "db", SHARED, "start.debug"],
      ["start", "gateway", OVERRIDE, "start.debug"],
    ]);
    expect(h.supervisor.isRunning("db")).toBe(true);
    expect(h.supervisor.isRunning("gateway")).toBe(true);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "ok", web: "skipped" });
  });

  it("keeps the skip semantics of a config command", async () => {
    const h = createHarness({
      dirs: ["db", "gateway"],
      config: {
        apps: {
          db: { path: "db", scripts: { start: "true # db-start" } },
          gateway: { path: "gateway", scripts: { start: "true # gw-start" } },
        },
        commands: {
          // No shared script: a target that is neither listed nor `null` is a
          // skip too, exactly as it is for a task command.
          "start.debug": { kind: "service", targets: { db: SHARED } },
        },
      },
    });

    const result = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "skipped" });
    expect(resultFor(result, "gateway").error).toMatch(/no script/);
    expect(h.supervisor.startOrder).toEqual(["db"]);
    // A skip must not fall back to the target's own start script.
    expect(h.supervisor.isRunning("gateway")).toBe(false);
  });

  it("starts in dependency order and waits for readiness", async () => {
    const h = debugStack();
    h.plugins.verdicts.set("db", "pending");

    const handle = h.engine.runCommand({ command: "start.debug" });
    await waitFor(() => h.supervisor.startOrder.includes("db"), "db to start");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.supervisor.startOrder).toEqual(["db"]);

    h.plugins.verdicts.set("db", "ready");
    const result = await settled(handle);

    expect(result.ok).toBe(true);
    expect(h.supervisor.startOrder).toEqual(["db", "gateway"]);
  });

  it("runs the config and plugin hooks bound to the command", async () => {
    const trace: string[] = [];
    const h = debugStack({ hooks: { pre: "true", post: "true" } });
    h.plugins.addHook("audit", "start.debug", {
      pre: (ctx) => {
        trace.push(`pre:${ctx.command}:${ctx.target.id}`);
      },
      post: (ctx) => {
        trace.push(`post:${ctx.target.id}:${String(ctx.result?.ok)}`);
      },
    });

    await settled(h.engine.runCommand({ command: "start.debug", targets: ["db"] }));

    expect(trace).toEqual(["pre:start.debug:db", "post:db:true"]);
  });

  it("does not start a target whose pre hook aborted", async () => {
    const h = debugStack();
    h.plugins.addHook("guard", "start.debug", {
      pre: (ctx) => {
        if (ctx.target.id === "db") throw new Error("disk is full");
      },
    });

    const result = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(statesByTarget(result)).toEqual({ db: "aborted", gateway: "skipped", web: "skipped" });
    expect(h.supervisor.startOrder).toEqual([]);
  });

  it("fails the target when the supervisor could not start the script", async () => {
    const h = debugStack();
    h.supervisor.failStart.add("db");

    const result = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({ db: "failed", gateway: "skipped", web: "skipped" });
    expect(resultFor(result, "db").error).toMatch(/cannot start db/);
  });

  it("leaves the process stoppable through the ordinary stop flow", async () => {
    const h = debugStack();
    await settled(h.engine.runCommand({ command: "start.debug" }));

    const stopped = await settled(h.engine.stopTargets());

    expect(stopped.ok).toBe(true);
    expect(h.supervisor.stopOrder).toEqual(["web", "gateway", "db"]);
    expect(h.supervisor.runningCount()).toBe(0);
  });
});
