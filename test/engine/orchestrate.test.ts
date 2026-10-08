import { afterEach, describe, expect, it } from "vitest";
import { cleanupHarnesses, createHarness, resultFor, settled, statesByTarget, waitFor, type Harness } from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

/** A three-link chain: db ← gateway ← web. */
function chain(overrides: Record<string, unknown> = {}): Harness {
  return createHarness({
    dirs: ["db", "gateway", "web"],
    config: {
      repos: {
        db: { path: "db", scripts: { start: "sleep 30" }, ...overrides },
        gateway: { path: "gateway", scripts: { start: "sleep 30" }, dependsOn: ["db"] },
        web: { path: "web", scripts: { start: "sleep 30" }, dependsOn: ["gateway"] },
      },
    },
  });
}

describe("startTargets", () => {
  it("starts in dependency order", async () => {
    const h = chain();

    const result = await settled(h.engine.startTargets());

    expect(result.ok).toBe(true);
    expect(result.command).toBe("app:start");
    expect(h.supervisor.startOrder).toEqual(["db", "gateway", "web"]);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "ok", web: "ok" });
    expect(h.statesOf("web")).toEqual(["pending", "running", "ok"]);
  });

  it("starts independent targets of one wave in parallel", async () => {
    const h = createHarness({
      dirs: ["a", "b", "c"],
      config: {
        repos: {
          a: { path: "a", scripts: { start: "sleep 30" } },
          b: { path: "b", scripts: { start: "sleep 30" } },
          c: { path: "c", scripts: { start: "sleep 30" }, dependsOn: ["a", "b"] },
        },
      },
    });
    h.supervisor.startDelayMs = 60;

    await settled(h.engine.startTargets());

    const [first, second, third] = h.supervisor.events;
    expect(h.supervisor.startOrder).toEqual(["a", "b", "c"]);
    // a and b overlap; c waits for both to be ready.
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(60);
    expect((third?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(60);
  });

  it("waits for a plugin readiness verdict before starting a dependent", async () => {
    const h = chain();
    h.plugins.verdicts.set("db", "pending");

    const handle = h.engine.startTargets(["db", "gateway"]);
    await waitFor(() => h.supervisor.startOrder.includes("db"), "db to start");
    await new Promise((r) => setTimeout(r, 80));

    // db is running, but the plugin says it is not ready yet.
    expect(h.supervisor.isRunning("db")).toBe(true);
    expect(h.supervisor.startOrder).toEqual(["db"]);

    h.plugins.verdicts.set("db", "ready");
    const result = await settled(handle);

    expect(result.ok).toBe(true);
    expect(h.supervisor.startOrder).toEqual(["db", "gateway"]);
  });

  it("falls back to the supervisor when every plugin answers n/a or throws", async () => {
    const h = chain();
    h.plugins.readinessThrows = true;

    const result = await settled(h.engine.startTargets(["db", "gateway"]));

    expect(result.ok).toBe(true);
    expect(h.supervisor.startOrder).toEqual(["db", "gateway"]);
  });

  it("fails the dependent on readiness timeout and reports its transitive dependents", async () => {
    const h = chain({ readyTimeout: 150 });
    h.plugins.verdicts.set("db", "pending");

    const result = await settled(h.engine.startTargets());

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "failed", web: "skipped" });
    expect(resultFor(result, "gateway").error).toBe('dependency "db" did not become ready within 150ms');
    expect(resultFor(result, "web").error).toMatch(/dependency "gateway" never became ready/);
    expect(h.supervisor.startOrder).toEqual(["db"]);
  });

  it("does not treat a dependency still inside its start grace as ready", async () => {
    const h = chain({ readyTimeout: 150 });
    h.supervisor.stuckStarting.add("db");

    const result = await settled(h.engine.startTargets(["db", "gateway"]));

    // SPEC §5.4: with no healthcheck, ready means *running*. The supervisor
    // counts "starting" as up for its own bookkeeping, which would make the
    // readiness timeout unreachable for every dependency without a healthcheck.
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "failed" });
    expect(resultFor(result, "gateway").error).toBe('dependency "db" did not become ready within 150ms');
    expect(h.supervisor.startOrder).toEqual(["db"]);
  });

  it("skips a dependent as soon as its dependency crashes, without waiting out the timeout", async () => {
    const h = chain({ readyTimeout: 30_000 });
    h.plugins.verdicts.set("db", "pending");

    const handle = h.engine.startTargets(["db", "gateway"]);
    await waitFor(() => h.supervisor.startOrder.includes("db"), "db to start");
    h.supervisor.crash("db");

    const result = await settled(handle, 3_000);

    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "skipped" });
    expect(resultFor(result, "gateway").error).toMatch(/dependency "db" crashed/);
    expect(h.supervisor.startOrder).toEqual(["db"]);
  });

  it("keeps waiting on a crashed dependency that the restart ladder will bring back", async () => {
    const h = chain({ restart: "on-crash", readyTimeout: 200 });
    h.plugins.verdicts.set("db", "pending");

    const handle = h.engine.startTargets(["db", "gateway"]);
    await waitFor(() => h.supervisor.startOrder.includes("db"), "db to start");
    h.supervisor.crash("db");

    const result = await settled(handle, 3_000);

    // `restart: "on-crash"` means the crash is not final, so the dependent has
    // to wait for its own readiness timeout rather than give up on the spot.
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "failed" });
    expect(resultFor(result, "gateway").error).toBe('dependency "db" did not become ready within 200ms');
  });

  it("skips a target with no start script, and everything downstream of it", async () => {
    const h = createHarness({
      dirs: ["db", "gateway"],
      config: {
        repos: {
          db: { path: "db" },
          gateway: { path: "gateway", scripts: { start: "sleep 30" }, dependsOn: ["db"] },
        },
      },
    });

    const result = await settled(h.engine.startTargets());

    expect(statesByTarget(result)).toEqual({ db: "skipped", gateway: "skipped" });
    expect(resultFor(result, "db").error).toMatch(/no "start" script/);
    expect(resultFor(result, "gateway").error).toMatch(/dependency "db" has no start script/);
    expect(h.supervisor.startOrder).toEqual([]);
  });

  it("fails a target the supervisor could not start, and skips its dependents", async () => {
    const h = chain();
    h.supervisor.failStart.add("db");

    const result = await settled(h.engine.startTargets());

    expect(statesByTarget(result)).toEqual({ db: "failed", gateway: "skipped", web: "skipped" });
    expect(resultFor(result, "db").error).toMatch(/cannot start db/);
  });

  it("fails a target that came back crashed", async () => {
    const h = chain();
    h.supervisor.crashOnStart.add("db");

    const result = await settled(h.engine.startTargets(["db"]));

    expect(statesByTarget(result)).toEqual({ db: "failed" });
    expect(resultFor(result, "db")).toMatchObject({ exitCode: 7, error: "exited immediately" });
  });

  it("ignores dependencies outside the selection", async () => {
    const h = chain();

    // gateway depends on db, which the user did not select: starting it must not
    // block on a target nobody asked for.
    const result = await settled(h.engine.startTargets(["gateway"]));

    expect(result.ok).toBe(true);
    expect(h.supervisor.startOrder).toEqual(["gateway"]);
  });

  it("runs the hook pipeline around app:start", async () => {
    const h = chain();
    const trace: string[] = [];
    h.plugins.addHook("audit", "app:start", {
      pre: (ctx) => {
        trace.push(`pre:${ctx.target.id}`);
      },
      post: (ctx) => {
        trace.push(`post:${ctx.target.id}:${String(ctx.result?.ok)}`);
      },
    });

    await settled(h.engine.startTargets(["db"]));

    expect(trace).toEqual(["pre:db", "post:db:true"]);
    expect(h.supervisor.startOrder).toEqual(["db"]);
  });

  it("does not start a target whose app:start pre hook aborted", async () => {
    const h = chain();
    h.plugins.addHook("guard", "app:start", {
      pre: (ctx) => {
        if (ctx.target.id === "db") throw new Error("disk is full");
      },
    });

    const result = await settled(h.engine.startTargets());

    expect(statesByTarget(result)).toEqual({ db: "aborted", gateway: "skipped", web: "skipped" });
    expect(h.supervisor.startOrder).toEqual([]);
  });
});

describe("runCommand routing", () => {
  it("dispatches the core app:* commands to the ordered service flows", async () => {
    const h = chain();

    const started = await settled(h.engine.runCommand({ command: "app:start", targets: ["db", "gateway"] }));
    expect(started.command).toBe("app:start");
    expect(h.supervisor.startOrder).toEqual(["db", "gateway"]);

    // --serial applies to the core commands too: one wave member at a time.
    const stopped = await settled(h.engine.runCommand({ command: "app:stop", serial: true }));
    expect(stopped.command).toBe("app:stop");
    expect(h.supervisor.stopOrder).toEqual(["web", "gateway", "db"]);

    const restarted = await settled(h.engine.runCommand({ command: "app:restart", targets: ["db"] }));
    expect(restarted.command).toBe("app:restart");
    expect(restarted.targets.map((t) => t.targetId)).toEqual(["db"]);
  });
});

describe("stopTargets", () => {
  it("stops in reverse dependency order", async () => {
    const h = chain();
    await settled(h.engine.startTargets());

    const result = await settled(h.engine.stopTargets());

    expect(result.command).toBe("app:stop");
    expect(result.ok).toBe(true);
    expect(h.supervisor.stopOrder).toEqual(["web", "gateway", "db"]);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "ok", web: "ok" });
  });

  it("fails only the target the supervisor could not stop", async () => {
    const h = chain();
    h.supervisor.failStop.add("gateway");

    const result = await settled(h.engine.stopTargets());

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "failed", web: "ok" });
    expect(resultFor(result, "gateway").error).toMatch(/cannot stop gateway/);
  });
});

describe("restartTargets", () => {
  it("stops everything in reverse order, then starts it in dependency order, as one run", async () => {
    const h = chain();
    await settled(h.engine.startTargets());
    h.supervisor.events.length = 0;
    h.progress.length = 0;
    h.finished.length = 0;

    const result = await settled(h.engine.restartTargets());

    expect(result.command).toBe("app:restart");
    expect(result.ok).toBe(true);
    expect(h.supervisor.events.map((e) => `${e.kind}:${e.id}`)).toEqual([
      "stop:web",
      "stop:gateway",
      "stop:db",
      "start:db",
      "start:gateway",
      "start:web",
    ]);
    expect(statesByTarget(result)).toEqual({ db: "ok", gateway: "ok", web: "ok" });
    // One run, so each target reports exactly one lifecycle.
    expect(h.statesOf("db")).toEqual(["pending", "running", "ok"]);
    expect(h.finished).toHaveLength(1);
  });

  it("runs the hooks bound to app:restart, not the ones bound to app:start", async () => {
    const h = chain();
    const trace: string[] = [];
    h.plugins.addHook("restart", "app:restart", {
      pre: (ctx) => {
        trace.push(`restart-pre:${ctx.command}`);
      },
      post: (ctx) => {
        trace.push(`restart-post:${ctx.command}:${String(ctx.result?.ok)}`);
      },
    });
    h.plugins.addHook("start", "app:start", {
      pre: () => {
        trace.push("start-pre");
      },
    });
    h.plugins.addHook("every", "*", {
      pre: () => {
        trace.push("star-pre");
      },
    });

    await settled(h.engine.restartTargets(["db"]));

    // A hook picked by name must see that same name in its context: binding to
    // `app:start` and firing on an `app:restart` run is what §2.6 forbids.
    expect(trace).toEqual(["restart-pre:app:restart", "star-pre", "restart-post:app:restart:true"]);
  });

  it("does not restart a target that failed to stop", async () => {
    const h = chain();
    h.supervisor.failStop.add("db");

    const result = await settled(h.engine.restartTargets());

    expect(statesByTarget(result)).toEqual({ db: "failed", gateway: "skipped", web: "skipped" });
    expect(h.supervisor.startOrder).toEqual([]);
  });
});
