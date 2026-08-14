import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { HookResult } from "../../src/plugin/types.js";
import { cleanupHarnesses, createHarness, resultFor, settled, statesByTarget, type Harness } from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

/** Two independent targets, so "aborts that target only" is observable. */
function twoTargets(command: Record<string, unknown>): Harness {
  return createHarness({
    dirs: ["gateway", "db"],
    config: {
      apps: { gateway: { path: "gateway" }, db: { path: "db" } },
      commands: { probe: command },
    },
  });
}

describe("config hooks", () => {
  it("runs pre and post around the script, once per target", async () => {
    const h = twoTargets({
      script: "echo script >> trace.txt",
      hooks: { pre: "echo pre >> trace.txt", post: "echo post >> trace.txt" },
    });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(result.ok).toBe(true);
    expect(h.read("gateway/trace.txt")).toBe("pre\nscript\npost\n");
    expect(h.read("db/trace.txt")).toBe("pre\nscript\npost\n");
  });

  it("aborts only the target whose pre hook failed, and still runs its post hook", async () => {
    const h = twoTargets({
      script: "echo script >> trace.txt",
      // Hooks run in the target's cwd, so the marker file singles out gateway.
      hooks: { pre: ["test ! -f blocked", "echo pre >> trace.txt"], post: "echo post >> trace.txt" },
    });
    fs.writeFileSync(h.file("gateway/blocked"), "");

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({ gateway: "aborted", db: "ok" });
    expect(resultFor(result, "gateway").error).toMatch(/pre hook exited with code 1: test ! -f blocked/);
    // The script never ran for gateway; the post hook still did.
    expect(h.read("gateway/trace.txt")).toBe("post\n");
    expect(h.read("db/trace.txt")).toBe("pre\nscript\npost\n");
    expect(h.statesOf("gateway")).toEqual(["pending", "running", "aborted"]);
  });

  it("fails the target when a post hook fails, without skipping the rest of them", async () => {
    const seen: string[] = [];
    const h = twoTargets({
      script: "echo script >> trace.txt",
      hooks: { post: ["exit 5", "echo late >> trace.txt"] },
    });
    h.plugins.addHook("audit", "probe", {
      post: (ctx) => {
        seen.push(ctx.target.id);
      },
    });

    const result = await settled(h.engine.runCommand({ command: "probe", targets: ["gateway"] }));

    expect(statesByTarget(result)).toEqual({ gateway: "failed" });
    expect(resultFor(result, "gateway").error).toMatch(/post hook exited with code 5/);
    // Both the later config hook and the plugin hook still ran.
    expect(h.read("gateway/trace.txt")).toBe("script\nlate\n");
    expect(seen).toEqual(["gateway"]);
  });
});

describe("plugin hooks", () => {
  it("runs config hooks before plugin hooks in both phases", async () => {
    const h = twoTargets({
      script: "echo script >> trace.txt",
      hooks: { pre: "echo config-pre >> trace.txt", post: "echo config-post >> trace.txt" },
    });
    const trace = (text: string): void => {
      fs.appendFileSync(h.file("gateway/trace.txt"), `${text}\n`);
    };
    h.plugins.addHook("first", "probe", {
      pre: () => trace("plugin-a-pre"),
      post: () => trace("plugin-a-post"),
    });
    h.plugins.addHook("second", "*", {
      pre: () => trace("plugin-b-pre"),
      post: () => trace("plugin-b-post"),
    });

    const result = await settled(h.engine.runCommand({ command: "probe", targets: ["gateway"] }));

    expect(result.ok).toBe(true);
    expect(h.read("gateway/trace.txt").trim().split("\n")).toEqual([
      "config-pre",
      "plugin-a-pre",
      "plugin-b-pre",
      "script",
      "config-post",
      "plugin-a-post",
      "plugin-b-post",
    ]);
  });

  it("aborts the target when a pre hook throws", async () => {
    const h = twoTargets({ script: "echo script >> trace.txt" });
    h.plugins.addHook("guard", "probe", {
      pre: (ctx) => {
        if (ctx.target.id === "db") throw new Error("working tree is dirty");
      },
    });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(statesByTarget(result)).toEqual({ gateway: "ok", db: "aborted" });
    expect(resultFor(result, "db").error).toMatch(/plugin "guard" aborted this target: working tree is dirty/);
    expect(h.read("db/trace.txt")).toBe("");
  });

  it("hands post hooks the outcome after success, failure and abort", async () => {
    const results = new Map<string, HookResult | undefined>();
    const h = createHarness({
      dirs: ["ok", "bad", "blocked"],
      config: {
        apps: { ok: { path: "ok" }, bad: { path: "bad" }, blocked: { path: "blocked" } },
        commands: {
          probe: {
            script: "true",
            targets: { bad: "exit 4" },
            hooks: { pre: "test ! -f stop" },
          },
        },
      },
    });
    fs.writeFileSync(h.file("blocked/stop"), "");
    h.plugins.addHook("audit", "probe", {
      post: (ctx) => {
        results.set(ctx.target.id, ctx.result);
      },
    });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(statesByTarget(result)).toEqual({ ok: "ok", bad: "failed", blocked: "aborted" });
    expect(results.get("ok")).toMatchObject({ ok: true, exitCode: 0 });
    expect(results.get("bad")).toMatchObject({ ok: false, exitCode: 4 });
    expect(results.get("blocked")).toMatchObject({ ok: false, exitCode: null });
    expect(results.get("blocked")?.error).toMatch(/pre hook/);
    for (const id of ["ok", "bad", "blocked"]) {
      expect(results.get(id)?.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("fails the target when a post hook throws, and still runs the ones after it", async () => {
    const ran: string[] = [];
    const h = twoTargets({ script: "true" });
    h.plugins.addHook("noisy", "probe", {
      post: () => {
        ran.push("noisy");
        throw new Error("reporting backend down");
      },
    });
    h.plugins.addHook("quiet", "probe", {
      post: () => {
        ran.push("quiet");
      },
    });

    const result = await settled(h.engine.runCommand({ command: "probe", targets: ["gateway"] }));

    expect(statesByTarget(result)).toEqual({ gateway: "failed" });
    expect(resultFor(result, "gateway").error).toMatch(/plugin "noisy" failed: reporting backend down/);
    expect(ran).toEqual(["noisy", "quiet"]);
  });

  it("gives hooks the workspace, target and run identity", async () => {
    const h = twoTargets({ script: "true" });
    const seen: Array<Record<string, unknown>> = [];
    h.plugins.addHook("inspect", "probe", {
      pre: (ctx) => {
        ctx.store.set("touched", true);
        seen.push({
          command: ctx.command,
          runId: ctx.runId,
          phase: ctx.phase,
          target: ctx.target.id,
          app: ctx.app.name,
          cwd: ctx.cwd,
          workspace: ctx.workspace.rootDir,
        });
      },
      post: (ctx) => {
        seen.push({ phase: ctx.phase, store: ctx.store.get("touched") });
      },
    });

    const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
    await settled(handle);

    expect(seen[0]).toEqual({
      command: "probe",
      runId: handle.runId,
      phase: "pre",
      target: "gateway",
      app: "gateway",
      cwd: h.file("gateway"),
      workspace: h.dir,
    });
    // The per-plugin store survives between invocations.
    expect(seen[1]).toEqual({ phase: "post", store: true });
  });
});
