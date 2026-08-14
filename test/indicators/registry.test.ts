import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawWorkspaceConfig } from "../../src/config/index.js";
import type { IndicatorRegistry } from "../../src/daemon/contracts.js";
import { createIndicatorRegistry } from "../../src/indicators/index.js";
import type { IndicatorResult, IndicatorUpdate } from "../../src/plugin/types.js";
import {
  FIXTURE_DIRS,
  changeRecorder,
  cleanupRoots,
  delay,
  fakeServices,
  fixtureConfig,
  holderOf,
  makeWorkspace,
  recordingLogger,
  tempRoot,
  trackRegistryTimers,
  waitFor,
  type FakeServices,
  type MutableHolder,
  type RecordingLogger,
} from "./helpers.js";

const SUBAPPS = ["gateway", "platform.shell", "platform.auth"];

let root: string;
let holder: MutableHolder;
let services: FakeServices;
let logger: RecordingLogger;
let registry: IndicatorRegistry;
const live: IndicatorRegistry[] = [];

function makeRegistry(): IndicatorRegistry {
  const created = createIndicatorRegistry({ workspace: holder, logger, services });
  live.push(created);
  return created;
}

beforeEach(() => {
  root = tempRoot(FIXTURE_DIRS);
  holder = holderOf(makeWorkspace(root, fixtureConfig()));
  services = fakeServices();
  logger = recordingLogger();
  registry = makeRegistry();
});

afterEach(async () => {
  for (const created of live.splice(0)) await created.stop();
  cleanupRoots();
});

describe("update modes", () => {
  it("evaluates a static provider once per owner and never again", async () => {
    const calls: string[] = [];
    registry.register({
      ns: "t",
      name: "stat",
      def: {
        scope: "subapp",
        update: { mode: "static" },
        value: (ctx) => {
          calls.push(ctx.target?.id ?? "?");
          return "constant";
        },
      },
    });

    await registry.start();
    expect([...calls].sort()).toEqual([...SUBAPPS].sort());

    registry.refresh();
    await delay(80);
    expect(calls).toHaveLength(SUBAPPS.length);
    expect(registry.get("t", "stat", "gateway")?.value).toBe("constant");
  });

  it("polls on its interval and skips a tick that is still in flight", async () => {
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    const calls = new Map<string, number>();

    registry.register({
      ns: "t",
      name: "slow",
      def: {
        scope: "subapp",
        update: { mode: "poll", intervalMs: 40 },
        value: async (ctx) => {
          const id = ctx.target?.id ?? "?";
          const now = (inFlight.get(id) ?? 0) + 1;
          inFlight.set(id, now);
          peak.set(id, Math.max(peak.get(id) ?? 0, now));
          calls.set(id, (calls.get(id) ?? 0) + 1);
          await delay(100);
          inFlight.set(id, now - 1);
          return "done";
        },
      },
    });

    await registry.start();
    await delay(320);

    expect([...peak.values()]).toEqual([1, 1, 1]);
    for (const count of calls.values()) {
      // ~3 runs of 100 ms in 320 ms — an overlapping scheduler would have fired 8.
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  it("staggers the first poll of each owner", async () => {
    const firstAt = new Map<string, number>();
    const startedAt = Date.now();
    registry.register({
      ns: "t",
      name: "spread",
      def: {
        scope: "subapp",
        update: { mode: "poll", intervalMs: 500 },
        value: (ctx) => {
          const id = ctx.target?.id ?? "?";
          if (!firstAt.has(id)) firstAt.set(id, Date.now() - startedAt);
          return id;
        },
      },
    });

    await registry.start();
    await waitFor(() => firstAt.size === SUBAPPS.length, "every owner to poll once");

    const offsets = [...firstAt.values()];
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThanOrEqual(30);
  });

  it("subscribes once per owner, applies emitted values and disposes on stop", async () => {
    const subscribed: string[] = [];
    const disposed: string[] = [];
    const emitters = new Map<string, (value: IndicatorResult) => void>();

    registry.register({
      ns: "t",
      name: "push",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        subscribe: (ctx, emit) => {
          const id = ctx.target?.id ?? "?";
          subscribed.push(id);
          emitters.set(id, emit);
          return () => {
            disposed.push(id);
          };
        },
      },
    });

    await registry.start();
    expect([...subscribed].sort()).toEqual([...SUBAPPS].sort());

    emitters.get("gateway")?.({ value: "up", tone: "ok" });
    await delay(40);
    expect(registry.get("t", "push", "gateway")).toMatchObject({ value: "up", tone: "ok" });

    await registry.stop();
    expect([...disposed].sort()).toEqual([...SUBAPPS].sort());

    // An emit that races the disposer must not resurrect a dead cell.
    emitters.get("gateway")?.("late");
    expect(registry.get("t", "push", "gateway")?.value).toBe("up");
  });

  it("subscribes for a subscribe-only provider that declares the wrong mode", async () => {
    const subscribed: string[] = [];
    const disposed: string[] = [];

    registry.register({
      ns: "t",
      name: "mixed",
      def: {
        // Contradictory: nothing to poll, since the def has no value().
        scope: "subapp",
        update: { mode: "poll", intervalMs: 100 },
        subscribe: (ctx, emit) => {
          const id = ctx.target?.id ?? "?";
          subscribed.push(id);
          emit("pushed");
          return () => {
            disposed.push(id);
          };
        },
      },
    });

    await registry.start();

    // Honoured rather than silently inert — and the contradiction is reported.
    expect([...subscribed].sort()).toEqual([...SUBAPPS].sort());
    expect(registry.get("t", "mixed", "gateway")?.value).toBe("pushed");
    expect(logger.warnings.some((w) => w.includes("t@mixed") && w.includes("subscribing anyway"))).toBe(true);

    await registry.stop();
    expect([...disposed].sort()).toEqual([...SUBAPPS].sort());
  });
});

/**
 * SPEC §6 documents `{ poll: 5000 }` / `{ event: true }` / `{ static: true }`,
 * while the implemented union is `{ mode, intervalMs }`. A plugin copied from
 * the spec must work, not freeze on its first value with no diagnostic.
 */
describe("update spellings", () => {
  /** The spec spelling is not in `IndicatorUpdate`; a JS plugin author writes it anyway. */
  const spelled = (update: Record<string, unknown>): IndicatorUpdate => update as unknown as IndicatorUpdate;

  it("polls a provider whose update is spelled { poll: ms }", async () => {
    const calls = new Map<string, number>();
    registry.register({
      ns: "t",
      name: "specpoll",
      def: {
        scope: "subapp",
        update: spelled({ poll: 40 }),
        value: (ctx) => {
          const id = ctx.target?.id ?? "?";
          const seen = (calls.get(id) ?? 0) + 1;
          calls.set(id, seen);
          return String(seen);
        },
      },
    });

    await registry.start();
    await delay(220);

    // ~5 ticks of 40 ms per owner; a provider stuck on its first value shows 1.
    for (const id of SUBAPPS) expect(calls.get(id) ?? 0).toBeGreaterThanOrEqual(3);
    expect(logger.warnings.filter((w) => w.includes("t@specpoll"))).toEqual([]);
  });

  it("treats { event: true } as event mode, subscription and all", async () => {
    const pulled: string[] = [];
    const subscribed: string[] = [];
    registry.register({
      ns: "t",
      name: "specevent",
      def: {
        scope: "subapp",
        update: spelled({ event: true }),
        value: (ctx) => {
          pulled.push(ctx.target?.id ?? "?");
          return "pulled";
        },
        subscribe: (ctx, emit) => {
          subscribed.push(ctx.target?.id ?? "?");
          emit("pushed");
        },
      },
    });

    await registry.start();

    expect([...subscribed].sort()).toEqual([...SUBAPPS].sort());
    expect(pulled).toEqual([]);
    expect(registry.get("t", "specevent", "gateway")?.value).toBe("pushed");
    expect(logger.warnings.filter((w) => w.includes("t@specevent"))).toEqual([]);
  });

  it("treats { static: true } as static mode, so refresh() never re-pulls it", async () => {
    const calls: string[] = [];
    registry.register({
      ns: "t",
      name: "specstatic",
      def: {
        scope: "subapp",
        update: spelled({ static: true }),
        value: (ctx) => {
          calls.push(ctx.target?.id ?? "?");
          return "constant";
        },
      },
    });

    await registry.start();
    expect([...calls].sort()).toEqual([...SUBAPPS].sort());

    registry.refresh();
    await delay(80);
    expect(calls).toHaveLength(SUBAPPS.length);
    expect(logger.warnings.filter((w) => w.includes("t@specstatic"))).toEqual([]);
  });

  it("warns, naming the provider, about an update it cannot recognize", async () => {
    registry.register({
      ns: "t",
      name: "weird",
      def: { scope: "subapp", update: spelled({ tick: 40 }), value: () => "v" },
    });

    await registry.start();

    const warning = logger.warnings.find((w) => w.includes("t@weird"));
    expect(warning).toBeDefined();
    expect(warning).toContain("tick");
    // Loud, but still useful: it falls back to the default poll rather than
    // going inert, so the cell is never a permanently stale value.
    await waitFor(() => registry.get("t", "weird", "gateway")?.value === "v", "t@weird to be pulled");
  });

  it("rejects a poll interval that is not a positive number instead of busy-looping", async () => {
    registry.register({
      ns: "t",
      name: "nointerval",
      def: { scope: "subapp", update: spelled({ mode: "poll" }), value: () => "v" },
    });

    await registry.start();

    // `setInterval(fn, undefined)` fires every millisecond forever; the default
    // interval plus a warning is the only sane reading of a missing one.
    expect(logger.warnings.find((w) => w.includes("t@nointerval"))).toBeDefined();
    await waitFor(() => registry.get("t", "nointerval", "gateway")?.value === "v", "t@nointerval");
  });
});

describe("change emission", () => {
  it("coalesces simultaneous changes into one payload and says nothing when values hold", async () => {
    const answers = new Map<string, string>(SUBAPPS.map((id) => [id, "a"]));
    registry.register({
      ns: "t",
      name: "cell",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: (ctx) => answers.get(ctx.target?.id ?? "") ?? "",
      },
    });

    const recorder = changeRecorder();
    registry.onChange(recorder.listener);
    await registry.start();
    // Let the staggered first polls of the core providers land, then start clean.
    await delay(120);
    recorder.clear();

    for (const id of SUBAPPS) answers.set(id, "b");
    registry.refresh();
    await delay(80);

    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]).toHaveLength(SUBAPPS.length);
    expect(recorder.cells().sort()).toEqual(SUBAPPS.map((id) => `t@cell/${id}=b`).sort());

    recorder.clear();
    registry.refresh();
    await delay(80);
    expect(recorder.batches).toEqual([]);
  });

  it("emits only the cells that changed", async () => {
    const answers = new Map<string, string>(SUBAPPS.map((id) => [id, "a"]));
    registry.register({
      ns: "t",
      name: "cell",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: (ctx) => answers.get(ctx.target?.id ?? "") ?? "",
      },
    });
    const recorder = changeRecorder();
    registry.onChange(recorder.listener);
    await registry.start();
    await delay(120);
    recorder.clear();

    answers.set("platform.auth", "changed");
    registry.refresh();
    await delay(80);

    expect(recorder.cells()).toEqual(["t@cell/platform.auth=changed"]);
  });
});

describe("sanitization", () => {
  it("flattens multi-line, control-laden and over-long provider output", async () => {
    registry.register({
      ns: "t",
      name: "dirty",
      def: {
        scope: "subapp",
        update: { mode: "static" },
        value: () => ({
          value: `first\nsecond\tthird\x00 \x1b[31mred\x1b[0m  spaced ${"x".repeat(300)}`,
          display: "one\r\ntwo",
        }),
      },
    });

    await registry.start();
    const cell = registry.get("t", "dirty", "gateway");

    expect(cell?.value).toHaveLength(200);
    expect(cell?.value.startsWith("first second third red spaced xxx")).toBe(true);
    expect(cell?.value.endsWith("…")).toBe(true);
    expect(/[\x00-\x1f\x7f-\x9f]/.test(cell?.value ?? "")).toBe(false);
    expect(cell?.display).toBe("one two");
  });
});

describe("failure isolation", () => {
  it("empties a throwing provider, warns, and leaves its neighbours alone", async () => {
    let explode = false;
    registry.register({
      ns: "t",
      name: "flaky",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: () => {
          if (explode) throw new Error("boom");
          return "warm";
        },
      },
    });
    registry.register({
      ns: "t",
      name: "steady",
      def: { scope: "subapp", update: { mode: "event" }, value: () => "fine" },
    });

    await registry.start();
    expect(registry.get("t", "flaky", "gateway")?.value).toBe("warm");

    explode = true;
    registry.refresh();
    await delay(80);

    // Empty, not stale: the last known value is no longer true.
    expect(registry.get("t", "flaky", "gateway")?.value).toBe("");
    expect(registry.get("t", "steady", "gateway")?.value).toBe("fine");
    expect(registry.get("app", "name", "gateway")?.value).toBe("gateway");
    expect(logger.warnings.some((w) => w.includes("t@flaky") && w.includes("boom"))).toBe(true);
  });

  it("empties a provider that outruns its deadline", async () => {
    let hang = false;
    registry.register({
      ns: "t",
      name: "stuck",
      def: {
        scope: "subapp",
        // 250 ms interval → a 225 ms deadline, comfortably inside the next tick.
        update: { mode: "poll", intervalMs: 250 },
        value: () => (hang ? new Promise<string>(() => {}) : "warm"),
      },
    });

    await registry.start();
    await waitFor(() => registry.get("t", "stuck", "gateway")?.value === "warm", "the first poll");

    hang = true;
    registry.refresh();
    await waitFor(() => registry.get("t", "stuck", "gateway")?.value === "", "the deadline to fire", 1_500);
    expect(logger.warnings.some((w) => w.includes("t@stuck") && w.includes("timed out"))).toBe(true);
  });
});

describe("scopes", () => {
  it("keeps app- and subapp-scoped providers of the same name apart", async () => {
    registry.register({
      ns: "t",
      name: "who",
      def: { scope: "subapp", update: { mode: "static" }, value: () => "sub" },
    });
    registry.register({
      ns: "t",
      name: "who",
      def: { scope: "app", update: { mode: "static" }, value: () => "app" },
    });

    await registry.start();

    // "gateway" is both an app and its implicit subapp; the subapp value wins.
    expect(registry.get("t", "who", "gateway")?.value).toBe("sub");
    expect(registry.get("t", "who", "platform")?.value).toBe("app");
    const owners = registry
      .values()
      .filter((v) => v.ns === "t")
      .map((v) => `${v.scope}/${v.owner}`);
    expect(owners.sort()).toEqual(
      ["app/gateway", "app/platform", "subapp/gateway", "subapp/platform.auth", "subapp/platform.shell"].sort(),
    );
  });
});

describe("rebind", () => {
  it("preserves surviving values, drops removed owners and evaluates new ones", async () => {
    registry.register({
      ns: "t",
      name: "own",
      def: {
        scope: "subapp",
        update: { mode: "static" },
        value: (ctx) => ctx.target?.id ?? "",
      },
    });
    const recorder = changeRecorder();
    registry.onChange(recorder.listener);

    await registry.start();
    await delay(120);
    recorder.clear();

    const reloaded: RawWorkspaceConfig = {
      name: "fixture",
      apps: {
        gateway: { path: "gateway", scripts: { start: "node server.js" } },
        platform: { path: "platform", subapps: { shell: { path: "apps/shell" } } },
        db: { path: "db" },
      },
    };
    holder.set(makeWorkspace(root, reloaded));
    await registry.rebind();
    await delay(80);

    expect(registry.get("t", "own", "platform.auth")).toBeUndefined();
    expect(registry.values().some((v) => v.owner === "platform.auth")).toBe(false);
    expect(registry.get("t", "own", "gateway")?.value).toBe("gateway");
    expect(registry.get("t", "own", "db")?.value).toBe("db");

    // Surviving cells did not flicker: only the new owner was announced.
    expect(new Set(recorder.flat().map((v) => v.owner))).toEqual(new Set(["db"]));
  });

  it("never announces a change for an owner the rebind removed", async () => {
    const answers = new Map(SUBAPPS.map((id) => [id, "a"]));
    registry.register({
      ns: "t",
      name: "own",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: (ctx) => answers.get(ctx.target?.id ?? "") ?? "",
      },
    });
    const recorder = changeRecorder();
    registry.onChange(recorder.listener);

    await registry.start();
    await delay(120);
    recorder.clear();

    // The change is applied into the batch, and the reload lands before it flushes.
    answers.set("platform.auth", "doomed");
    registry.refresh(["platform.auth"]);
    await delay(7);
    holder.set(
      makeWorkspace(root, {
        name: "fixture",
        apps: {
          gateway: { path: "gateway", scripts: { start: "node server.js" } },
          platform: { path: "platform", subapps: { shell: { path: "apps/shell" } } },
        },
      }),
    );
    await registry.rebind();
    await delay(80);

    // Clients are never told about a cell that no longer exists: removals are not
    // part of the delta protocol, so a ghost cell would live until the next snapshot.
    expect(recorder.flat().filter((v) => v.owner === "platform.auth")).toEqual([]);
  });
});

describe("registration lifecycle", () => {
  it("unregisterNamespace drops a namespace's providers, values and timers", async () => {
    let ticks = 0;
    registry.register({
      ns: "plug",
      name: "tick",
      def: { scope: "subapp", update: { mode: "poll", intervalMs: 30 }, value: () => String(ticks++) },
    });
    registry.register({
      ns: "other",
      name: "keep",
      def: { scope: "subapp", update: { mode: "static" }, value: () => "kept" },
    });

    await registry.start();
    await waitFor(() => ticks > 0, "the first tick");

    registry.unregisterNamespace("plug");
    const frozen = ticks;
    await delay(120);

    expect(ticks).toBe(frozen);
    expect(registry.get("plug", "tick", "gateway")).toBeUndefined();
    expect(registry.values().some((v) => v.ns === "plug")).toBe(false);
    expect(registry.get("other", "keep", "gateway")?.value).toBe("kept");
  });

  it("refresh re-pulls the given targets only, and never a static provider", async () => {
    const counts = { static: 0, event: 0, app: 0 };
    registry.register({
      ns: "t",
      name: "fixed",
      def: {
        scope: "subapp",
        update: { mode: "static" },
        value: () => String(++counts.static),
      },
    });
    registry.register({
      ns: "t",
      name: "live",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: () => String(++counts.event),
      },
    });
    registry.register({
      ns: "t",
      name: "rollup",
      def: { scope: "app", update: { mode: "event" }, value: () => String(++counts.app) },
    });

    await registry.start();
    expect(counts).toEqual({ static: 3, event: 3, app: 2 });

    registry.refresh(["platform.shell"]);
    await delay(80);
    // The subapp itself, plus the app row it rolls up into — nothing else.
    expect(counts).toEqual({ static: 3, event: 4, app: 3 });

    registry.refresh();
    await delay(80);
    expect(counts).toEqual({ static: 3, event: 7, app: 5 });
  });

  it("re-evaluates a cell whose refresh landed while a run was in flight", async () => {
    let answer = "a";
    registry.register({
      ns: "t",
      name: "slow",
      def: {
        scope: "subapp",
        update: { mode: "event" },
        value: async () => {
          // Reads the world *now*; whatever happens during the wait is not in it.
          const seen = answer;
          await delay(120);
          return seen;
        },
      },
    });

    await registry.start();
    await waitFor(() => registry.get("t", "slow", "gateway")?.value === "a", "the first pull");

    registry.refresh(["gateway"]);
    await delay(40);
    // The state changed mid-run: an event-mode cell has no poll to correct it, so
    // this refresh must survive the collision rather than be skipped.
    answer = "b";
    registry.refresh(["gateway"]);

    await waitFor(() => registry.get("t", "slow", "gateway")?.value === "b", "the queued re-evaluation");
  });

  it("stop() leaves no live timer and no live subscription", async () => {
    const tracker = trackRegistryTimers();
    try {
      const disposed: string[] = [];
      let polls = 0;
      const isolated = makeRegistry();
      isolated.register({
        ns: "t",
        name: "tick",
        def: { scope: "subapp", update: { mode: "poll", intervalMs: 30 }, value: () => String(polls++) },
      });
      isolated.register({
        ns: "t",
        name: "push",
        def: {
          scope: "subapp",
          update: { mode: "event" },
          subscribe: (ctx) => () => {
            disposed.push(ctx.target?.id ?? "?");
          },
        },
      });

      await isolated.start();
      await waitFor(() => polls > 2, "a few polls");
      expect(tracker.live()).toBeGreaterThan(0);

      await isolated.stop();

      expect(tracker.live()).toBe(0);
      expect([...disposed].sort()).toEqual([...SUBAPPS].sort());

      const frozen = polls;
      await delay(120);
      expect(polls).toBe(frozen);
    } finally {
      tracker.restore();
    }
  });

  it("stop() abandons a provider that never settles", async () => {
    const tracker = trackRegistryTimers();
    try {
      let entered = 0;
      const isolated = makeRegistry();
      isolated.register({
        ns: "t",
        name: "hung",
        def: {
          scope: "subapp",
          update: { mode: "poll", intervalMs: 5_000 },
          value: () => {
            entered += 1;
            return new Promise<string>(() => {});
          },
        },
      });

      await isolated.start();
      await waitFor(() => entered === SUBAPPS.length, "every owner to be mid-flight");
      await isolated.stop();

      // The deadline that would have fired minutes later is fired now, so neither
      // the timer nor the suspended evaluation outlives the registry.
      expect(tracker.live()).toBe(0);
    } finally {
      tracker.restore();
    }
  });
});
