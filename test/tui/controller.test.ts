/**
 * The dashboard, tested without a terminal.
 *
 * Everything the TUI actually *does* — apply a push, keep a selection across a
 * rebuild, batch a log flood, unsubscribe on the way out, survive a daemon that
 * disappears — lives in the controller, so this is where those are pinned down.
 * The components only draw what these tests already prove.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createController,
  DEFAULT_FRAME_MS,
  type ControllerOptions,
  type DashboardController,
} from "../../src/tui/controller.js";
import { logWindow } from "../../src/tui/logs.js";
import type { DashboardState } from "../../src/tui/types.js";
import {
  createFakeClient,
  fixtureSnapshot,
  logLine,
  serviceState,
  settle,
  statusIndicator,
  testScheduler,
  type FakeClient,
  type TestScheduler,
} from "./helpers.js";

interface Harness {
  client: FakeClient;
  clock: TestScheduler;
  controller: DashboardController;
  /** Runs one frame's worth of coalesced pushes. */
  frame(): void;
  state(): DashboardState;
}

const live: DashboardController[] = [];

function setup(opts: Partial<ControllerOptions> & { client?: FakeClient } = {}): Harness {
  const client = opts.client ?? createFakeClient();
  const clock = testScheduler();
  const controller = createController({
    client,
    color: false,
    scheduler: clock.schedule,
    scrollback: opts.scrollback,
    backfill: opts.backfill,
  });
  live.push(controller);
  return {
    client,
    clock,
    controller,
    frame: () => clock.advance(DEFAULT_FRAME_MS),
    state: () => controller.getState(),
  };
}

afterEach(async () => {
  for (const controller of live.splice(0)) await controller.dispose();
});

// ---------------------------------------------------------------------------

describe("rows", () => {
  it("lays the profile out the way `u8 status` does", () => {
    const { state } = setup();

    expect(state().rows.map((row) => [row.kind, row.id, row.text])).toEqual([
      // A single-subapp app is one merged row rendered with the subapp template.
      ["merged", "api", "SUB api stopped"],
      ["app", "platform", "APP platform"],
      ["subapp", "platform.web", "SUB web stopped"],
      ["subapp", "platform.admin", "SUB admin stopped"],
    ]);
    expect(state().running).toBe(0);
    expect(state().total).toBe(3);
  });

  it("acts on every selected subapp from an app header row", () => {
    const { state } = setup();

    expect(state().rows[0]?.targets).toEqual(["api"]);
    expect(state().rows[1]?.targets).toEqual(["platform.web", "platform.admin"]);
  });

  it("renders ANSI when colour is on and the raw value when it is off", () => {
    const client = createFakeClient();
    const clock = testScheduler();
    const coloured = createController({ client, color: true, scheduler: clock.schedule });
    live.push(coloured);

    expect(coloured.getState().rows[0]?.text).toContain("[");
    expect(coloured.getState().rows[0]?.text).toContain("●");
  });

  it("applies indicator and service pushes to the rows", () => {
    const { client, frame, state } = setup();

    client.push("indicator.changed", { values: [statusIndicator("api", "running")] });
    client.push("service.changed", { state: serviceState("api", "running") });
    frame();

    expect(state().rows[0]?.text).toBe("SUB api running");
    expect(state().running).toBe(1);
  });
});

describe("cursor", () => {
  it("moves, clamps, and follows the row it was on across a rebuild", () => {
    const { client, controller, frame, state } = setup();

    controller.moveCursor(2);
    expect(state().cursor).toBe(2);
    expect(state().rows[state().cursor]?.id).toBe("platform.web");

    controller.moveCursor(50);
    expect(state().cursor).toBe(3);

    controller.setCursor(2);
    client.push("indicator.changed", { values: [statusIndicator("api", "running")] });
    frame();
    expect(state().rows[state().cursor]?.id).toBe("platform.web");
  });

  it("scrolls the window to keep the cursor visible", () => {
    const { controller, state } = setup();

    controller.setViewport(2);
    controller.setCursor(3);
    expect(state().windowTop).toBe(2);

    controller.setCursor(0);
    expect(state().windowTop).toBe(0);

    // A taller terminal shows everything and needs no window at all.
    controller.setViewport(10);
    controller.setCursor(3);
    expect(state().windowTop).toBe(0);
  });
});

describe("frames", () => {
  it("coalesces a burst of pushes into a single publish", () => {
    const { client, controller, clock, frame } = setup();
    const seen: DashboardState[] = [];
    controller.subscribe((state) => seen.push(state));

    for (let i = 0; i < 50; i++) {
      client.push("indicator.changed", { values: [statusIndicator("api", i % 2 === 0 ? "running" : "stopped")] });
    }
    expect(seen).toHaveLength(0);
    expect(clock.pending).toBe(1);

    frame();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows[0]?.text).toBe("SUB api stopped");
  });

  it("publishes immediately for anything the user pressed", () => {
    const { controller } = setup();
    const seen: DashboardState[] = [];
    controller.subscribe((state) => seen.push(state));

    controller.handleKey("j", {});

    expect(seen).toHaveLength(1);
    expect(seen[0]?.cursor).toBe(1);
  });
});

describe("lifecycle keys", () => {
  it("starts the selection and the whole profile", async () => {
    const { client, controller } = setup();

    await controller.start("selection");
    controller.setCursor(1);
    await controller.stop("selection");
    await controller.restart("profile");

    expect(client.paramsOf("service.start")).toEqual([{ targets: ["api"] }]);
    // An app header row acts on every subapp beneath it.
    expect(client.paramsOf("service.stop")).toEqual([{ targets: ["platform.web", "platform.admin"] }]);
    // No targets means "the active profile" on the wire.
    expect(client.paramsOf("service.restart")).toEqual([{ targets: undefined }]);
  });

  it("turns a failed request into a notice instead of a rejection", async () => {
    const { client, controller, state } = setup();
    client.fail("service.start", new Error("daemon said no"));

    await expect(controller.start("selection")).resolves.toBeUndefined();

    expect(state().notice).toEqual({ text: "daemon said no", tone: "error" });
  });

  it("shows per-target progress while a run is in flight, then a summary", () => {
    const { client, frame, state } = setup();

    client.push("task.progress", {
      progress: { runId: "r1", command: "greet", targetId: "platform.web", state: "running" },
    });
    frame();
    expect(state().progress).toEqual({ "platform.web": "running" });
    expect(state().activeRuns).toBe(1);

    client.push("task.finished", {
      result: {
        runId: "r1",
        command: "greet",
        ok: true,
        targets: [{ targetId: "platform.web", state: "ok", durationMs: 12 }],
        startedAt: 1_000,
        finishedAt: 1_500,
      },
    });
    frame();
    expect(state().progress).toEqual({});
    expect(state().summary).toEqual({
      runId: "r1",
      command: "greet",
      ok: true,
      counts: [{ state: "ok", count: 1 }],
      durationMs: 500,
    });
  });
});

describe("log view", () => {
  it("backfills, follows, and unsubscribes on the way out", async () => {
    const { client, controller, frame, state } = setup();
    client.lines.push(logLine("api", "old line"));

    await controller.openLogs();

    expect(state().mode).toBe("logs");
    expect(state().logs?.loading).toBe(false);
    expect(state().logs?.lines.map((l) => l.text)).toEqual(["old line"]);
    expect([...client.subscribed]).toEqual(["api"]);
    expect(client.paramsOf("logs.read")).toEqual([{ targetId: "api", lines: 500 }]);

    client.push("log.line", { line: logLine("api", "live line") });
    frame();
    expect(state().logs?.lines.map((l) => l.text)).toEqual(["old line", "live line"]);

    await controller.closeLogs();
    expect(state().mode).toBe("list");
    expect(state().logs).toBeUndefined();
    expect(client.unsubscribeCalls).toEqual(["api"]);
    expect(client.subscribed.size).toBe(0);
  });

  it("merges an app's subapps and prefixes their lines", async () => {
    const { client, controller, state } = setup();
    client.lines.push(logLine("platform.admin", "admin says hi", 2), logLine("platform.web", "web says hi", 1));

    controller.setCursor(1);
    await controller.openLogs();

    expect(state().logs?.prefix).toBe(true);
    expect([...client.subscribed]).toEqual(["platform.web", "platform.admin"]);
    // Two streams read separately still read in the order things happened.
    expect(state().logs?.lines.map((l) => l.text)).toEqual(["web says hi", "admin says hi"]);
  });

  it("releases the previous view when a second one opens", async () => {
    const { client, controller } = setup();

    await controller.openLogs();
    controller.setCursor(2);
    await controller.openLogs();

    expect(client.unsubscribeCalls).toEqual(["api"]);
    expect([...client.subscribed]).toEqual(["platform.web"]);
  });

  it("ignores lines from targets the view does not cover", async () => {
    const { client, controller, frame, state } = setup();

    await controller.openLogs();
    client.push("log.line", { line: logLine("platform.web", "not mine") });
    frame();

    expect(state().logs?.lines).toHaveLength(0);
  });

  it("keeps scrollback bounded and counts what it dropped", async () => {
    const { client, controller, frame, state } = setup({ scrollback: 5 });

    await controller.openLogs();
    for (let i = 0; i < 20; i++) client.push("log.line", { line: logLine("api", `line ${i}`) });
    frame();

    const view = state().logs;
    expect(view?.lines).toHaveLength(5);
    expect(view?.lines.map((l) => l.text)).toEqual(["line 15", "line 16", "line 17", "line 18", "line 19"]);
    expect(view?.dropped).toBe(15);
  });

  it("pauses following when scrolled back and resumes at the bottom", async () => {
    const { client, controller, frame, state } = setup();

    await controller.openLogs();
    controller.setLogViewport(2);
    for (let i = 0; i < 10; i++) client.push("log.line", { line: logLine("api", `line ${i}`) });
    frame();
    expect(state().logs?.follow).toBe(true);

    controller.scrollLogs(-4);
    expect(state().logs?.follow).toBe(false);
    expect(logWindow(state().logs!, 2).lines.map((l) => l.text)).toEqual(["line 4", "line 5"]);

    // New output must not drag a paused view along.
    client.push("log.line", { line: logLine("api", "line 10") });
    frame();
    expect(logWindow(state().logs!, 2).lines.map((l) => l.text)).toEqual(["line 4", "line 5"]);

    controller.logsBottom();
    expect(state().logs?.follow).toBe(true);
    expect(logWindow(state().logs!, 2).lines.map((l) => l.text)).toEqual(["line 9", "line 10"]);

    controller.logsTop();
    expect(state().logs?.follow).toBe(false);
    expect(logWindow(state().logs!, 2).lines.map((l) => l.text)).toEqual(["line 0", "line 1"]);
  });

  it("says nothing is selected rather than opening an empty view", async () => {
    const client = createFakeClient(fixtureSnapshot({ apps: [], profiles: [{ name: "all", isDefault: true, subappIds: [] }] }));
    const { controller, state } = setup({ client });

    await controller.openLogs();

    expect(state().mode).toBe("list");
    expect(state().notice?.tone).toBe("warn");
  });
});

describe("palette", () => {
  it("lists every command with the targets it covers in scope", () => {
    const { controller, state } = setup();

    controller.openPalette();

    const palette = state().palette;
    expect(state().mode).toBe("palette");
    expect(palette?.scope).toBe("selection");
    expect(palette?.scopeLabel).toBe("api");
    expect(palette?.items.map((item) => [item.name, item.source, item.matched.length])).toEqual([
      ["app:start", "core", 1],
      ["greet", "config", 1],
      ["git:pull", "plugin", 1],
    ]);
  });

  it("filters by name and description as the user types", () => {
    const { controller, state } = setup();

    controller.openPalette();
    controller.paletteType("hel");
    expect(state().palette?.items.map((i) => i.name)).toEqual(["greet"]);

    controller.paletteBackspace();
    controller.paletteBackspace();
    controller.paletteBackspace();
    controller.paletteType("git");
    expect(state().palette?.items.map((i) => i.name)).toEqual(["git:pull"]);
  });

  it("ranks a name match above a description match", () => {
    const client = createFakeClient(
      fixtureSnapshot({
        commands: [
          { name: "deploy", kind: "task", source: "config", description: "run the tests first", appliesTo: ["api"] },
          { name: "test", kind: "task", source: "config", appliesTo: ["api"] },
        ],
      }),
    );
    const { controller, state } = setup({ client });

    controller.openPalette();
    controller.paletteType("test");

    expect(state().palette?.items.map((item) => item.name)).toEqual(["test", "deploy"]);
  });

  it("switches between the selection and the whole profile", async () => {
    const { client, controller, state } = setup();

    controller.setCursor(2);
    controller.openPalette();
    expect(state().palette?.scopeLabel).toBe("platform.web");

    controller.paletteToggleScope();
    expect(state().palette?.scope).toBe("profile");
    expect(state().palette?.scopeLabel).toBe("profile all");
    // Scoped to the profile, a command matches every target it applies to.
    expect(state().palette?.items[1]?.matched).toEqual(["api", "platform.web", "platform.admin"]);

    controller.paletteMove(1);
    await controller.paletteRun();

    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: undefined }]);
    expect(state().mode).toBe("list");
  });

  it("runs against the selection when that is the scope", async () => {
    const { client, controller } = setup();

    controller.setCursor(3);
    controller.openPalette();
    controller.paletteType("greet");
    await controller.paletteRun();

    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: ["platform.admin"] }]);
  });
});

describe("profiles", () => {
  it("switches the active profile and re-renders the list", async () => {
    const { client, controller, state } = setup();

    controller.openProfiles();
    expect(state().profileMenu?.index).toBe(0);

    controller.profilesMove(1);
    await controller.profilesSelect();

    expect(client.paramsOf("profile.use")).toEqual([{ name: "frontend" }]);
    expect(state().profile).toBe("frontend");
    expect(state().rows.map((row) => row.id)).toEqual(["platform", "platform.web"]);
    expect(state().cursor).toBe(0);
  });

  it("does nothing when the active profile is chosen again", async () => {
    const { client, controller, state } = setup();

    controller.openProfiles();
    await controller.profilesSelect();

    expect(client.paramsOf("profile.use")).toEqual([]);
    expect(state().mode).toBe("list");
  });
});

describe("daemon health", () => {
  it("shows a config error banner and clears it on a good reload", () => {
    const { client, frame, state } = setup();

    client.push("config.reloaded", { ok: false, error: "apps.api.path: no such directory", stale: [] });
    frame();
    expect(state().configError).toBe("apps.api.path: no such directory");
    expect(state().notice?.tone).toBe("error");

    client.push("config.reloaded", { ok: true, stale: [], snapshot: fixtureSnapshot() });
    frame();
    expect(state().configError).toBeUndefined();
  });

  it("surfaces a plugin that failed to load", () => {
    const { client, frame, state } = setup();

    client.push("plugin.error", { plugin: "deploy", error: "boom" });
    frame();

    expect(state().pluginErrors).toEqual([{ plugin: "deploy", error: "boom" }]);
  });

  it("carries plugin failures that were already in the snapshot", () => {
    const client = createFakeClient(
      fixtureSnapshot({ plugins: [{ name: "deploy", spec: "./deploy.ts", ok: false, error: "syntax error" }] }),
    );
    const { state } = setup({ client });

    expect(state().pluginErrors).toEqual([{ plugin: "deploy", error: "syntax error" }]);
  });

  it("reconnects rather than crashing when the daemon goes away", () => {
    const { client, frame, state } = setup();

    client.push("daemon.shutdown", { reason: "idle" });
    frame();
    expect(state().connection).toBe("reconnecting");

    client.disconnect();
    frame();
    expect(state().connection).toBe("reconnecting");

    client.reattach(fixtureSnapshot({ activeProfile: "frontend" }));
    frame();
    expect(state().connection).toBe("connected");
    expect(state().profile).toBe("frontend");
    expect(state().rows.map((row) => row.id)).toEqual(["platform", "platform.web"]);
  });

  it("drops the progress of a run the reconnected daemon has forgotten", () => {
    const { client, frame, state } = setup();

    client.push("task.progress", {
      progress: { runId: "r1", command: "greet", targetId: "api", state: "running" },
    });
    frame();
    expect(state().progress).toEqual({ api: "running" });

    // The daemon died mid-run; whatever comes back has no memory of it, so a
    // `task.finished` for that run is never coming and the rows would otherwise
    // claim it is still running for the rest of the session.
    client.disconnect();
    client.reattach(fixtureSnapshot());
    frame();

    expect(state().progress).toEqual({});
    expect(state().activeRuns).toBe(0);
  });

  it("says so when re-attaching gives up", () => {
    const { client, frame, state } = setup();

    client.lose(new Error("could not re-attach after 6 attempts"));
    frame();

    expect(state().connection).toBe("lost");
    expect(state().notice?.text).toContain("could not re-attach");
  });
});

describe("notices", () => {
  it("expires on its own", async () => {
    const { clock, controller, frame, state } = setup();

    await controller.start("profile");
    expect(state().notice?.text).toContain("starting profile all");

    // Expiring is not something the user pressed, so it lands on the next frame.
    clock.advance(6_000);
    frame();
    expect(state().notice).toBeUndefined();
  });

  it("can be dismissed before it expires", async () => {
    const { clock, controller, state } = setup();

    await controller.start("profile");
    controller.dismissNotice();

    expect(state().notice).toBeUndefined();
    expect(clock.pending).toBe(0);
  });
});

describe("teardown", () => {
  it("leaves no subscription, timer or listener behind", async () => {
    const { client, clock, controller, state } = setup();

    await controller.openLogs();
    await controller.start("selection");
    expect(client.listenerCount()).toBeGreaterThan(0);

    await controller.dispose();

    expect(client.listenerCount()).toBe(0);
    expect(client.subscribed.size).toBe(0);
    expect(clock.pending).toBe(0);
    // A push after disposal must not reach a listener, or resurrect a frame.
    client.push("indicator.changed", { values: [statusIndicator("api", "running")] });
    expect(clock.pending).toBe(0);
    expect(state().rows[0]?.text).toBe("SUB api stopped");
  });

  it("issues no subscription for a log view that was still opening", async () => {
    const { client, controller } = setup();
    const passthrough = client.subscribe.bind(client);
    const gates: Array<() => void> = [];
    let first = true;
    client.subscribe = async (targetId): Promise<void> => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      await passthrough(targetId);
    };

    controller.setCursor(1); // an app header row: two targets, two subscriptions
    const opening = controller.openLogs();
    await settle();
    await controller.dispose();

    gates[0]?.();
    await opening;
    await settle();

    // The one already in flight is the daemon's problem (the unsubscribe behind
    // it is ordered after it on the same connection); the second must never be
    // sent, because nothing is left to take it back off.
    expect(client.subscribeCalls).toEqual(["platform.web"]);
  });

  it("arms no notice timer for a request that fails after disposal", async () => {
    const { client, clock, controller } = setup();
    const passthrough = client.request.bind(client);
    let reject: (err: Error) => void = () => undefined;
    client.request = ((method: string, params: unknown) =>
      method === "service.start"
        ? new Promise((_resolve, rej) => {
            reject = rej;
          })
        : passthrough(method as never, params as never)) as FakeClient["request"];

    const pending = controller.start("selection");
    await settle();
    await controller.dispose();
    expect(clock.pending).toBe(0);

    // The socket closed under the request; the notice has nowhere to go now.
    reject(new Error("connection closed before service.start completed"));
    await pending;
    await settle();

    expect(clock.pending).toBe(0);
  });

  it("is safe to dispose twice", async () => {
    const { controller } = setup();

    await controller.dispose();
    await expect(controller.dispose()).resolves.toBeUndefined();
  });
});
