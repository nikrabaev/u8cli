/**
 * The four methods the daemon's collaborators call, plus the lifecycle around
 * them: what a plugin contributes, in what order, and with which context.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedWorkspace } from "../../src/config/types.js";
import type { ServiceState } from "../../src/ipc/protocol.js";
import type { IndicatorResult } from "../../src/plugin/types.js";
import { createPluginHost, type LoadablePluginHost, type PluginHostDeps } from "../../src/plugins/index.js";
import { nullLogger } from "../../src/util/logger.js";
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

/** Hosts built over a patched workspace (see {@link hostOver}), disposed with the rest. */
const patchedHosts: LoadablePluginHost[] = [];

afterEach(async () => {
  for (const host of patchedHosts.splice(0)) await host.dispose().catch(() => undefined);
  await cleanupPlugins();
});

/**
 * A host over the fixture's workspace with part of the normalized model
 * replaced — `plugins` with their options, or `builtinOptions`.
 *
 * The host's input is `NormalizedWorkspace`, so these tests state that model
 * directly instead of routing through a config file: how JSONC becomes options
 * is normalization's contract, and pinning it here would test that layer twice
 * and this one not at all.
 */
function hostOver(
  fixture: Fixture,
  patch: Partial<NormalizedWorkspace>,
  deps: Partial<PluginHostDeps> = {},
): LoadablePluginHost {
  const ws: NormalizedWorkspace = { ...fixture.ws, ...patch };
  const host = createPluginHost({ workspace: { current: () => ws }, logger: nullLogger, ...deps });
  patchedHosts.push(host);
  return host;
}

/** A supervisor's answer for `api`, as the `health` built-in consumes it. */
function services(state: ServiceState) {
  return { state: () => state, states: () => [state] };
}

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
 * A plugin that needs configuration exports a *factory* — a function taking its
 * options — instead of a definition object. The host is where the workspace's
 * options meet it.
 */
describe("options and factories", () => {
  it("calls a factory with the options the workspace configured", async () => {
    const fixture = createFixture({
      files: {
        "plugins/greeter.js": `export default (options) => ({
          name: "greeter",
          indicators: { greeting: { value: () => options.greeting + "/" + options.times } },
        });`,
      },
    });

    const host = hostOver(fixture, {
      plugins: [{ spec: "./plugins/greeter.js", options: { greeting: "hi", times: 2 } }],
    });
    await host.load();

    expect(host.list()).toEqual([{ name: "greeter", spec: "./plugins/greeter.js", ok: true }]);
    expect(await host.indicators()[0]?.def.value?.(indicatorContext(fixture))).toBe("hi/2");
  });

  it("calls a factory with an empty object when nothing configured it", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/bare.js"] },
      files: {
        "plugins/bare.js": `export default (options) => ({
          name: "bare",
          indicators: { opts: { value: () => JSON.stringify(options) } },
        });`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(host.list()).toEqual([{ name: "bare", spec: "./plugins/bare.js", ok: true }]);
    expect(await host.indicators()[0]?.def.value?.(indicatorContext(fixture))).toBe("{}");
  });

  it("prefers a named createPlugin export over the instance a module also exports", async () => {
    const fixture = createFixture({
      files: {
        // The `health` shape: importing the module directly still yields a
        // working plugin, but a configured host builds its own.
        "plugins/dual.js": `export const createPlugin = (options) => ({
          name: "dual",
          indicators: { mode: { value: () => String(options.mode ?? "unset") } },
        });
        export default createPlugin({ mode: "instance" });`,
      },
    });

    const host = hostOver(fixture, { plugins: [{ spec: "./plugins/dual.js", options: { mode: "configured" } }] });
    await host.load();

    expect(await host.indicators()[0]?.def.value?.(indicatorContext(fixture))).toBe("configured");
  });

  it("loads a plugin that exports a plain definition object, unchanged", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/plain.js"] },
      files: {
        "plugins/plain.js": `export default {
          name: "plain",
          indicators: { fixed: { value: () => "42" } },
          commands: { go: { run: () => undefined } },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(host.list()).toEqual([{ name: "plain", spec: "./plugins/plain.js", ok: true }]);
    expect(host.commands().map((c) => c.name)).toEqual(["plain:go"]);
    expect(await host.indicators()[0]?.def.value?.(indicatorContext(fixture))).toBe("42");
  });

  /**
   * The failure worth catching: a plugin that cannot read configuration, loaded
   * next to configuration written for it, would show every sign of the setting
   * having taken — it loads, it renders — and none of its effect.
   */
  it("disables a plugin that was given options but exports no factory", async () => {
    const fixture = createFixture({
      files: {
        "plugins/plain.js": `export default {
          name: "plain",
          indicators: { fixed: { value: () => "42" } },
        };`,
      },
    });

    const seen: Array<[string, string]> = [];
    const host = hostOver(
      fixture,
      { plugins: [{ spec: "./plugins/plain.js", options: { packages: ["@myorg/protos"] } }] },
      { onError: (plugin, error) => seen.push([plugin, error]) },
    );
    await host.load();

    const entry = host.list()[0];
    expect(entry).toMatchObject({ name: "plain", spec: "./plugins/plain.js", ok: false });
    expect(entry?.error).toContain("options were configured for it");
    expect(entry?.error).toContain("factory");
    expect(host.indicators()).toEqual([]);
    // Reported under the name the plugin declared, so a banner can name it.
    expect(seen).toEqual([["plain", expect.stringContaining("./plugins/plain.js")]]);
  });

  it("says so when a factory is async instead of letting it look malformed", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/slow.js"] },
      files: { "plugins/slow.js": `export default async (options) => ({ name: "slow" });` },
    });

    const host = fixture.host();
    await host.load();

    expect(host.list()[0]?.error).toContain("returned a promise");
    expect(host.list()[0]?.error).toContain("setup()");
  });

  it("disables a factory that throws and keeps loading the rest", async () => {
    const fixture = createFixture({
      files: {
        "plugins/strict.js": `export default (options) => {
          if (!options.packages?.length) throw new Error("packages must name at least one package");
          return { name: "strict" };
        };`,
        "plugins/fine.js": `export default { name: "fine", commands: { go: { run: () => undefined } } };`,
      },
    });

    const seen: Array<[string, string]> = [];
    const host = hostOver(
      fixture,
      { plugins: [{ spec: "./plugins/strict.js", options: { packages: [] } }, { spec: "./plugins/fine.js" }] },
      { onError: (plugin, error) => seen.push([plugin, error]) },
    );
    await host.load();

    expect(host.list().map((p) => [p.spec, p.ok])).toEqual([
      ["./plugins/strict.js", false],
      ["./plugins/fine.js", true],
    ]);
    expect(host.list()[0]?.error).toContain("packages must name at least one package");
    expect(host.commands().map((c) => c.name)).toEqual(["fine:go"]);
    expect(seen.map(([, error]) => error)).toHaveLength(1);
  });
});

/**
 * A built-in is *constructed* by the host, not merely imported: it takes what
 * the workspace configured for it, plus — for `health` — live lifecycle state,
 * which the plugin SDK (the contract for *third-party* plugins) deliberately has
 * no channel for.
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

  it("builds a built-in from the workspace's builtinOptions", async () => {
    const fixture = healthFixture();
    // The supervisor's word — the process is gone — against a caller still
    // holding a `running` state, which is what a crash looks like from here.
    const stopped = serviceState("api", "stopped");

    const host = hostOver(fixture, { builtinOptions: { health: { services: services(stopped) } } });
    await host.load();

    expect(host.list()).toEqual([{ name: "health", spec: "builtin:health", ok: true }]);
    expect(await host.readiness(targetInfo(fixture), serviceState("api"))).toBe("n/a");
  });

  it("merges the daemon's own state over them", async () => {
    const fixture = healthFixture();
    const stopped = serviceState("api", "stopped");

    const host = hostOver(
      fixture,
      // A workspace could never write a supervisor into its config; if it
      // somehow names the same key, the daemon's live state is the truth.
      { builtinOptions: { health: { services: services(serviceState("api")) } } },
      { builtinState: { health: { services: services(stopped), workspace: fixture.workspace } } },
    );
    await host.load();

    expect(await host.readiness(targetInfo(fixture), serviceState("api"))).toBe("n/a");
  });

  it("still loads a built-in that nothing configured", async () => {
    const fixture = healthFixture();
    const host = fixture.host();
    await host.load();

    // No supervisor to contradict it, so the handed-in state is all it has: the
    // target counts as live and its first probe has not landed yet.
    expect(await host.readiness(targetInfo(fixture), serviceState("api"))).toBe("pending");
  });

  it("never loads a built-in the workspace has not enabled", async () => {
    const fixture = createFixture();
    const host = hostOver(fixture, {
      builtins: { git: false, health: false, protos: false },
      // Options for a built-in that is switched off buy it nothing: the module
      // is never imported, so it costs neither a load nor a record.
      builtinOptions: { protos: { packages: ["@myorg/protos"] } },
    });
    await host.load();

    expect(host.list()).toEqual([]);
    expect(host.indicators()).toEqual([]);
    expect(host.commands()).toEqual([]);
  });
});
