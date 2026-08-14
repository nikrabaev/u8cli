import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/plugin/types.js";
import { cleanupHarnesses, createHarness, resultFor, settled, statesByTarget, waitFor, type Harness } from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

/** gateway (implicit) plus a two-subapp monorepo — what `groupBy: "app"` is for. */
function monorepo(): Harness {
  return createHarness({
    dirs: ["gateway", "platform/shell", "platform/auth"],
    config: {
      env: { GREETING: "hello" },
      apps: {
        gateway: { path: "gateway" },
        platform: { path: "platform", subapps: { shell: { path: "shell" }, auth: { path: "auth" } } },
      },
    },
  });
}

describe("plugin commands", () => {
  it("runs once per target with a context bound to that target", async () => {
    const h = monorepo();
    // Dispatch order is deterministic (the pool pulls targets in resolution
    // order); *completion* order is not, since both targets shell out in
    // parallel — so the two are recorded separately.
    const dispatched: string[] = [];
    const seen = new Map<string, { cwd: string; command: string; runId: string; pwd: string; env: string }>();
    h.plugins.addCommand("demo", "demo:touch", {
      async run(ctx: CommandContext) {
        dispatched.push(ctx.target.id);
        const pwd = await ctx.exec("pwd");
        const env = await ctx.exec('printf "%s" "$GREETING"');
        ctx.log(`touched ${ctx.target.id}`);
        seen.set(ctx.target.id, {
          cwd: ctx.cwd,
          command: ctx.command,
          runId: ctx.runId,
          pwd: pwd.stdout.trim(),
          env: env.stdout,
        });
      },
    });

    const handle = h.engine.runCommand({ command: "demo:touch", targets: ["platform"] });
    const result = await settled(handle);

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ "platform.shell": "ok", "platform.auth": "ok" });
    expect(dispatched).toEqual(["platform.shell", "platform.auth"]);
    expect(seen.get("platform.shell")).toEqual({
      cwd: h.file("platform/shell"),
      command: "demo:touch",
      runId: handle.runId,
      pwd: h.file("platform/shell"),
      env: "hello",
    });
    expect(seen.get("platform.auth")).toMatchObject({
      cwd: h.file("platform/auth"),
      pwd: h.file("platform/auth"),
    });
    // ctx.log lands in the run log and on the live stream.
    expect(h.logs.map((l) => l.text)).toContain("touched platform.shell");
    expect(resultFor(result, "platform.shell").logPath).toBeDefined();
  });

  it("runs once per app for groupBy: \"app\", from the app root", async () => {
    const h = monorepo();
    const cwds: string[] = [];
    h.plugins.addCommand("git", "git:pull", {
      groupBy: "app",
      run(ctx) {
        cwds.push(ctx.cwd);
      },
    });

    const result = await settled(h.engine.runCommand({ command: "git:pull" }));

    // platform.shell represents the app; platform.auth is reported, not dropped.
    expect(statesByTarget(result)).toEqual({
      gateway: "ok",
      "platform.shell": "ok",
      "platform.auth": "skipped",
    });
    expect(resultFor(result, "platform.auth").error).toMatch(/covered by "platform.shell"/);
    expect(cwds).toEqual([h.file("gateway"), h.file("platform")]);
  });

  it("skips targets rejected by appliesTo", async () => {
    const h = monorepo();
    const ran: string[] = [];
    h.plugins.addCommand("git", "git:fetch", {
      appliesTo: (target) => target.appName === "platform",
      run(ctx) {
        ran.push(ctx.target.id);
      },
    });

    const result = await settled(h.engine.runCommand({ command: "git:fetch" }));

    expect(statesByTarget(result)).toEqual({
      gateway: "skipped",
      "platform.shell": "ok",
      "platform.auth": "ok",
    });
    expect(resultFor(result, "gateway").error).toMatch(/does not apply/);
    expect(ran).toEqual(["platform.shell", "platform.auth"]);
  });

  it("fails the target when run throws or returns a non-zero code", async () => {
    const h = monorepo();
    h.plugins.addCommand("demo", "demo:flaky", {
      run(ctx) {
        if (ctx.target.id === "gateway") throw new Error("no remote configured");
        if (ctx.target.id === "platform.shell") return 2;
        return undefined;
      },
    });

    const result = await settled(h.engine.runCommand({ command: "demo:flaky" }));

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({
      gateway: "failed",
      "platform.shell": "failed",
      "platform.auth": "ok",
    });
    expect(resultFor(result, "gateway").error).toBe("no remote configured");
    expect(resultFor(result, "platform.shell").exitCode).toBe(2);
  });

  it("aborts an in-flight plugin command through ctx.signal", async () => {
    const h = monorepo();
    let started = false;
    h.plugins.addCommand("demo", "demo:wait", {
      run(ctx) {
        started = true;
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    const handle = h.engine.runCommand({ command: "demo:wait", targets: ["gateway"] });
    await waitFor(() => started, "the plugin command to start");
    h.engine.cancelAll("stopping");

    const result = await settled(handle);
    expect(statesByTarget(result)).toEqual({ gateway: "aborted" });
    expect(resultFor(result, "gateway").error).toBe("stopping");
  });

  it("wraps plugin commands in the same hook pipeline as config commands", async () => {
    const h = monorepo();
    const trace: string[] = [];
    h.plugins.addCommand("demo", "demo:work", {
      run: () => {
        trace.push("run");
      },
    });
    h.plugins.addHook("audit", "demo:work", {
      pre: () => {
        trace.push("pre");
      },
      post: (ctx) => {
        trace.push(`post:${String(ctx.result?.ok)}`);
      },
    });

    await settled(h.engine.runCommand({ command: "demo:work", targets: ["gateway"] }));

    expect(trace).toEqual(["pre", "run", "post:true"]);
  });
});
