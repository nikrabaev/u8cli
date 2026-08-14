/**
 * The four methods the daemon's collaborators call, plus the lifecycle around
 * them: what a plugin contributes, in what order, and with which context.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { IndicatorResult } from "../../src/plugin/types.js";
import type { PluginHostDeps } from "../../src/plugins/index.js";
import {
  cleanupPlugins,
  commandContext,
  createFixture,
  hookContext,
  indicatorContext,
  serviceState,
  targetInfo,
  type Fixture,
} from "./helpers.js";

afterEach(async () => {
  await cleanupPlugins();
});

/**
 * Polls until `read` returns something, so a test can assert that a child was
 * reaped *promptly* — a fixed sleep would pass just as well against a plugin
 * whose command was left to run to completion.
 */
async function until<T>(read: () => T | undefined, what: string, timeoutMs = 1_500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== "") return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Two plugins, loaded in this order, contributing to all four surfaces. */
function twoPlugins(): Fixture {
  return createFixture({
    config: { plugins: ["./plugins/one.js", "./plugins/two.js"] },
    files: {
      "plugins/one.js": `export default {
        name: "one",
        indicators: {
          alpha: { scope: "app", update: { mode: "poll", intervalMs: 1000 }, value: () => "a" },
          beta: { update: { mode: "event" }, subscribe: (ctx, emit) => { emit("b"); return () => {}; } },
        },
        commands: { pull: { kind: "task", groupBy: "app", run: () => undefined } },
        hooks: {
          "app:start": { pre: (ctx) => { ctx.logger.debug("one/app:start"); } },
          "*": { post: () => undefined },
        },
      };`,
      "plugins/two.js": `export default {
        name: "two",
        indicators: { gamma: { value: () => "c" } },
        commands: { push: { run: () => undefined } },
        hooks: { "app:start": { pre: () => undefined, post: () => undefined } },
      };`,
    },
  });
}

describe("contributions", () => {
  it("namespaces indicators by plugin name and preserves their definitions", async () => {
    const host = twoPlugins().host();
    await host.load();

    const regs = host.indicators();
    expect(regs.map((r) => `${r.ns}@${r.name}`)).toEqual(["one@alpha", "one@beta", "two@gamma"]);

    const alpha = regs[0];
    expect(alpha?.def.scope).toBe("app");
    expect(alpha?.def.update).toEqual({ mode: "poll", intervalMs: 1000 });
    // A subscribe-only provider must not grow a `value`, or the registry would
    // poll it instead of subscribing.
    const beta = regs[1];
    expect(typeof beta?.def.subscribe).toBe("function");
    expect(beta?.def.value).toBeUndefined();
    expect(regs[2]?.def.subscribe).toBeUndefined();
  });

  it("gives commands their canonical namespaced names", async () => {
    const host = twoPlugins().host();
    await host.load();

    expect(host.commands().map((c) => [c.plugin, c.name, c.def.kind, c.def.groupBy])).toEqual([
      ["one", "one:pull", "task", "app"],
      ["two", "two:push", undefined, undefined],
    ]);
  });

  it("returns exact and wildcard hooks per plugin, in load order", async () => {
    const host = twoPlugins().host();
    await host.load();

    const bound = host.hooksFor("app:start");
    expect(bound.map((h) => h.plugin)).toEqual(["one", "one", "two"]);
    // one's exact binding is the pre, its wildcard is the post.
    expect(bound[0]?.def.pre).toBeDefined();
    expect(bound[1]?.def.post).toBeDefined();
    expect(bound[1]?.def.pre).toBeUndefined();

    // An unrelated command still gets the wildcard.
    expect(host.hooksFor("test").map((h) => h.plugin)).toEqual(["one"]);
    // And `"*"` itself is not bound twice.
    expect(host.hooksFor("*").map((h) => h.plugin)).toEqual(["one"]);
  });

  it("contributes nothing before load()", async () => {
    const host = twoPlugins().host();

    expect(host.indicators()).toEqual([]);
    expect(host.commands()).toEqual([]);
    expect(host.list()).toEqual([]);

    await host.load();
    expect(host.commands()).toHaveLength(2);
  });
});

describe("setup context", () => {
  it("hands over the workspace, its targets and apps, and an exec at the root", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/probe.js"] },
      dirs: ["web"],
      files: {
        "plugins/probe.js": `export default {
          name: "probe",
          async setup(ctx) {
            const pwd = await ctx.exec("pwd");
            ctx.store.set("seen", {
              workspace: ctx.workspace.rootDir,
              targets: ctx.targets.map((t) => t.id),
              apps: ctx.apps.map((a) => a.name),
              cwd: pwd.stdout.trim(),
            });
          },
          indicators: { seen: { value: (ctx) => JSON.stringify(ctx.store.get("seen")) } },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    const reg = host.indicators()[0];
    const value = await reg?.def.value?.(indicatorContext(fixture));
    const seen = JSON.parse(String(value)) as Record<string, unknown>;
    expect(seen["workspace"]).toBe(fixture.dir);
    expect(seen["cwd"]).toBe(fixture.dir);
    expect(seen["targets"]).toEqual(["api"]);
    expect(seen["apps"]).toEqual(["api"]);
  });
});

describe("the per-plugin store", () => {
  /** One counter, written from setup and read from every other callsite. */
  const counter = (): Fixture =>
    createFixture({
      config: { plugins: ["./plugins/counter.js"] },
      files: {
        "plugins/counter.js": `const bump = (ctx, key) => {
          const next = (ctx.store.get(key) ?? 0) + 1;
          ctx.store.set(key, next);
          return String(next);
        };
        export default {
          name: "counter",
          setup: (ctx) => { ctx.store.set("origin", "setup"); },
          indicators: { calls: { value: (ctx) => bump(ctx, "calls") } },
          commands: { run: { run: (ctx) => { bump(ctx, "calls"); ctx.log(String(ctx.store.get("origin"))); } } },
          hooks: { "*": { pre: (ctx) => { bump(ctx, "calls"); } } },
        };`,
      },
    });

  it("survives across invocations, whatever the callsite hands in", async () => {
    const fixture = counter();
    const host = fixture.host();
    await host.load();

    const indicator = host.indicators()[0]?.def;
    const command = host.commands()[0]?.def;
    const hook = host.hooksFor("test")[0]?.def;

    // Each callsite passes its own store — the registry and the engine keep
    // separate ones — and the host must substitute the plugin's on the way in.
    const first = await indicator?.value?.(indicatorContext(fixture));
    const second = await indicator?.value?.(indicatorContext(fixture));
    expect([first, second]).toEqual(["1", "2"]);

    const logged: string[] = [];
    await command?.run(commandContext(fixture, { log: (text: string) => logged.push(text) }));
    await hook?.pre?.(hookContext(fixture, "pre"));

    const fourth = await indicator?.value?.(indicatorContext(fixture));
    expect(fourth).toBe("5");
    // setup() wrote into the same map the command reads from.
    expect(logged).toEqual(["setup"]);
  });
});

describe("readiness", () => {
  const verdicts = (impl: Record<string, string>): Fixture => {
    const files: Record<string, string> = {};
    for (const [name, body] of Object.entries(impl)) {
      files[`plugins/${name}.js`] = `export default { name: ${JSON.stringify(name)}, readiness: ${body} };`;
    }
    return createFixture({
      config: { plugins: Object.keys(impl).map((n) => `./plugins/${n}.js`) },
      files,
    });
  };

  const ask = async (fixture: Fixture, opts: Partial<PluginHostDeps> = {}) => {
    const host = fixture.host(opts);
    await host.load();
    return host.readiness(targetInfo(fixture), serviceState("api"));
  };

  it('answers "n/a" when nothing has an opinion', async () => {
    expect(await ask(verdicts({ quiet: `() => "n/a"` }))).toBe("n/a");
  });

  it('answers "n/a" when no plugin declares readiness at all', async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/none.js"] },
      files: { "plugins/none.js": `export default { name: "none" };` },
    });
    expect(await ask(fixture)).toBe("n/a");
  });

  it("takes the first verdict in load order", async () => {
    expect(await ask(verdicts({ a: `() => "n/a"`, b: `() => "pending"`, c: `() => "ready"` }))).toBe("pending");
  });

  it("passes the target and its service state", async () => {
    const fixture = verdicts({
      strict: `(ctx) => (ctx.target.id === "api" && ctx.service.status === "running" ? "ready" : "pending")`,
    });
    expect(await ask(fixture)).toBe("ready");
  });

  it("skips a plugin that throws", async () => {
    expect(
      await ask(verdicts({ a: `() => { throw new Error("nope"); }`, b: `() => "ready"` })),
    ).toBe("ready");
  });

  it("skips a plugin that never answers, without wedging the gate", async () => {
    const fixture = verdicts({ a: `() => new Promise(() => {})`, b: `() => "ready"` });
    const started = Date.now();
    expect(await ask(fixture, { readinessTimeoutMs: 60 })).toBe("ready");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  /**
   * The engine re-asks every 100 ms for as long as the gate is shut, so a probe
   * that outlives its own verdict is a child process per poll for the whole
   * readiness window — with nothing left holding a handle to any of them.
   */
  it("kills the command a timed-out readiness left running", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/prober.js"] },
      files: {
        "plugins/prober.js": `export default {
          name: "prober",
          indicators: { probe: { value: (ctx) => String(ctx.store.get("probe") ?? "") } },
          async readiness(ctx) {
            const res = await ctx.exec("sleep 3");
            ctx.store.set("probe", "signal=" + res.signal);
            return "ready";
          },
        };`,
      },
    });

    const host = fixture.host({ readinessTimeoutMs: 40 });
    await host.load();
    expect(await host.readiness(targetInfo(fixture), serviceState("api"))).toBe("n/a");

    const reg = host.indicators()[0];
    const outcome = await until(
      () => reg?.def.value?.(indicatorContext(fixture)) as string | undefined,
      "the abandoned probe to report how it ended",
    );
    expect(outcome).toBe("signal=SIGTERM");
  });
});

describe("dispose", () => {
  /** Appends its own name to a marker beside the workspace root, from teardown. */
  const recorder = (name: string, marker: string): string =>
    `import { appendFileSync } from "node:fs";
     import { join } from "node:path";
     export default {
       name: ${JSON.stringify(name)},
       teardown() { appendFileSync(join(import.meta.dirname, "..", ${JSON.stringify(marker)}), ${JSON.stringify(name + "\n")}); },
     };`;

  it("tears every plugin down in reverse load order, tolerating a thrower", async () => {
    const marker = "teardowns.txt";
    const fixture = createFixture({
      config: { plugins: ["./plugins/a.js", "./plugins/boom.js", "./plugins/c.js"] },
      files: {
        "plugins/a.js": recorder("a", marker),
        "plugins/boom.js": `export default { name: "boom", teardown() { throw new Error("teardown exploded"); } };`,
        "plugins/c.js": recorder("c", marker),
      },
    });

    const host = fixture.host();
    await host.load();
    await host.dispose();

    expect(fixture.read(marker).trim().split("\n")).toEqual(["c", "a"]);
    // The host stays answerable; nothing it loaded contributes any more.
    expect(host.commands()).toEqual([]);
    expect(host.indicators()).toEqual([]);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("waits for a load still in flight, so nothing is set up after the teardown", async () => {
    const marker = "late.txt";
    const fixture = createFixture({
      config: { plugins: ["./plugins/slow.js"] },
      files: {
        "plugins/slow.js": `import { appendFileSync } from "node:fs";
        import { join } from "node:path";
        export default {
          name: "slow",
          setup: () => new Promise((resolve) => setTimeout(resolve, 50)),
          teardown() { appendFileSync(join(import.meta.dirname, "..", ${JSON.stringify(marker)}), "torn\\n"); },
        };`,
      },
    });

    const host = fixture.host();
    const loading = host.load();
    await host.dispose();
    await loading;

    expect(fixture.read(marker).trim()).toBe("torn");
  });

  it("does not hang on a teardown that never returns", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/hang.js"] },
      files: { "plugins/hang.js": `export default { name: "hang", teardown: () => new Promise(() => {}) };` },
    });

    const host = fixture.host({ loadTimeoutMs: 60 });
    await host.load();
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  /**
   * `teardown()` takes no context, so the only thing that can reach a command a
   * plugin started from `setup()` is the signal the host put in that context.
   */
  it("kills a command a plugin left running when it is disposed", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/bg.js"] },
      files: {
        "plugins/bg.js": `import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        export default {
          name: "bg",
          setup(ctx) {
            const marker = join(ctx.workspace.rootDir, "bg.txt");
            void ctx.exec("sleep 3").then((res) => { writeFileSync(marker, "signal=" + res.signal); });
          },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();
    await host.dispose();

    const outcome = await until(
      () => (fixture.exists("bg.txt") ? fixture.read("bg.txt") : undefined),
      "the background command to be reaped",
    );
    expect(outcome).toBe("signal=SIGTERM");
  });

  it("kills a command a setup that outstayed its deadline left running", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/slow.js"] },
      files: {
        "plugins/slow.js": `import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        export default {
          name: "slow",
          async setup(ctx) {
            const res = await ctx.exec("sleep 3");
            writeFileSync(join(ctx.workspace.rootDir, "slow.txt"), "signal=" + res.signal);
          },
        };`,
      },
    });

    const host = fixture.host({ loadTimeoutMs: 40 });
    await host.load();
    expect(host.list()[0]?.ok).toBe(false);

    const outcome = await until(
      () => (fixture.exists("slow.txt") ? fixture.read("slow.txt") : undefined),
      "the abandoned setup command to be reaped",
    );
    expect(outcome).toBe("signal=SIGTERM");
  });

  /**
   * The plugin is already recorded as failed, so nothing tracks it — but its
   * setup still lands, and whatever it started (timers, watchers, servers) would
   * otherwise outlive the daemon's own shutdown with no owner at all.
   */
  it("tears down a plugin that finished setting up after its deadline", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/late.js"] },
      files: {
        "plugins/late.js": `import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        const marker = join(import.meta.dirname, "..", "late.txt");
        export default {
          name: "late",
          setup: () => new Promise((resolve) => setTimeout(resolve, 80)),
          teardown() { writeFileSync(marker, "torn"); },
        };`,
      },
    });

    const host = fixture.host({ loadTimeoutMs: 20 });
    await host.load();
    expect(host.list()).toEqual([
      { name: "late", spec: "./plugins/late.js", ok: false, error: expect.stringContaining("timed out") },
    ]);

    expect(await until(() => (fixture.exists("late.txt") ? "torn" : undefined), "the late plugin to be torn down")).toBe(
      "torn",
    );
  });

  it("skips teardown for a plugin that never finished loading", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/half.js"] },
      files: {
        "plugins/half.js": `export default {
          name: "half",
          setup() { throw new Error("no"); },
          teardown() { throw new Error("teardown must not run"); },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();
    await expect(host.dispose()).resolves.toBeUndefined();
  });
});

describe("indicator results", () => {
  it("passes a rich result through untouched", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/rich.js"] },
      files: {
        "plugins/rich.js": `export default {
          name: "rich",
          indicators: { status: { value: () => ({ value: "up", display: "●", tone: "ok" }) } },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    const result = (await host.indicators()[0]?.def.value?.(indicatorContext(fixture))) as IndicatorResult;
    expect(result).toEqual({ value: "up", display: "●", tone: "ok" });
  });
});

/**
 * A built-in is *constructed* by the host, not merely imported: `health` needs
 * live lifecycle state, and the plugin SDK — the contract for third-party
 * plugins — deliberately has no channel for it.
 */
describe("built-in options", () => {
  function healthFixture(): Fixture {
    return createFixture({
      config: {
        builtins: { git: false, health: true },
        apps: {
          api: {
            path: "api",
            scripts: { start: "sleep 30" },
            health: { cmd: "true", interval: 200, timeout: 500, threshold: 1 },
          },
        },
      },
    });
  }

  it("hands a built-in the daemon's state through its factory export", async () => {
    const fixture = healthFixture();
    const target = targetInfo(fixture);
    const stopped = serviceState("api", "stopped");
    // The supervisor's word — the process is gone — against a caller still
    // holding a `running` state, which is what a crash looks like from here.
    const services = { state: () => stopped, states: () => [stopped] };

    const wired = fixture.host({ builtinOptions: { health: { services, workspace: fixture.workspace } } });
    await wired.load();
    expect(wired.list()).toEqual([{ name: "health", spec: "builtin:health", ok: true }]);
    expect(await wired.readiness(target, serviceState("api"))).toBe("n/a");
  });

  it("still loads a built-in that gets no options, from its default export", async () => {
    const fixture = healthFixture();
    const host = fixture.host();
    await host.load();

    // No supervisor to contradict it, so the handed-in state is all it has: the
    // target counts as live and its first probe has not landed yet.
    expect(await host.readiness(targetInfo(fixture), serviceState("api"))).toBe("pending");
  });
});
