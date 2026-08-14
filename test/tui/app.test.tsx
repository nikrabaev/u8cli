/**
 * The Ink layer, rendered into a fake terminal.
 *
 * These tests deliberately assert on *frames* rather than on controller state —
 * that is covered elsewhere. What is only true once a renderer is involved is
 * what these check: that a keypress reaches the controller through Ink's input
 * parser, that the list is windowed to the terminal it is given, that a resize
 * moves that window, and that unmounting takes every listener with it.
 */
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { stripAnsi } from "../../src/template/index.js";
import { App } from "../../src/tui/components/App.js";
import { createController, DEFAULT_FRAME_MS, type DashboardController } from "../../src/tui/controller.js";
import { frameRows } from "../../src/tui/present.js";
import type { Snapshot } from "../../src/ipc/protocol.js";
import { createFakeClient, fixtureSnapshot, logLine, settle, testScheduler, type FakeClient, type TestScheduler } from "./helpers.js";

interface Mounted {
  client: FakeClient;
  clock: TestScheduler;
  controller: DashboardController;
  app: ReturnType<typeof render>;
  /** The last frame, without ANSI. */
  frame(): string;
  /** Types into the fake terminal and lets Ink settle. */
  type(input: string): Promise<void>;
  /** Delivers coalesced pushes, then lets React re-render. */
  tick(): Promise<void>;
}

const mounted: Mounted[] = [];

function mount(opts: { snapshot?: Snapshot; client?: FakeClient; color?: boolean } = {}): Mounted {
  const client = opts.client ?? createFakeClient(opts.snapshot ?? fixtureSnapshot());
  const clock = testScheduler();
  const controller = createController({ client, color: opts.color ?? false, scheduler: clock.schedule });
  const app = render(<App controller={controller} />);

  const instance: Mounted = {
    client,
    clock,
    controller,
    app,
    frame: () => stripAnsi(app.lastFrame() ?? ""),
    async type(input: string): Promise<void> {
      app.stdin.write(input);
      await settle();
    },
    async tick(): Promise<void> {
      clock.advance(DEFAULT_FRAME_MS);
      await settle();
    },
  };
  mounted.push(instance);
  return instance;
}

/** Pretends the terminal was resized to `rows` tall. */
function resize(instance: Mounted, rows: number): Promise<void> {
  Object.defineProperty(instance.app.stdout, "rows", { value: rows, configurable: true });
  instance.app.stdout.emit("resize");
  return settle();
}

describe("frame", () => {
  it("fills the terminal and welds the hint bar to the last line", async () => {
    const ui = mount();
    await settle();
    const lines = ui.frame().split("\n");

    // One short of the terminal on purpose: ink appends a newline, so this is a
    // full screen, and staying under stdout.rows keeps it off the clear-the-world
    // render path. The hint bar is the LAST line, not merely the line after the
    // rows — before the frame had a height it floated up under a short list.
    expect(lines).toHaveLength(frameRows(24));
    expect(lines.at(-1)).toContain("q quit");
    // Body top-aligned directly under the header, with the slack below it.
    expect(lines[1]).toContain("SUB api stopped");
    expect(lines.slice(5, -1).every((line) => line.trim() === "")).toBe(true);
  });

  it("keeps the hint bar on the last line when there is nothing to list", async () => {
    const ui = mount({ snapshot: fixtureSnapshot({ profiles: [{ name: "all", isDefault: true, subappIds: [] }] }) });
    await settle();
    const lines = ui.frame().split("\n");

    expect(lines).toHaveLength(frameRows(24));
    expect(ui.frame()).toContain('no targets in profile "all"');
    expect(lines.at(-1)).toContain("q quit");
  });

  it("keeps the hint bar on the last line in every mode", async () => {
    const ui = mount();
    await settle();

    for (const [key, expected] of [["?", "close help"], ["?", "q quit"], [":", "esc close"], ["\u001B", "q quit"], ["P", "esc close"]] as const) {
      await ui.type(key);
      const lines = ui.frame().split("\n");
      expect(lines, `frame height after ${JSON.stringify(key)}`).toHaveLength(frameRows(24));
      expect(lines.at(-1), `hint bar after ${JSON.stringify(key)}`).toContain(expected);
    }
  });
});

afterEach(async () => {
  for (const instance of mounted.splice(0)) {
    instance.app.unmount();
    await instance.controller.dispose();
  }
});

// ---------------------------------------------------------------------------

describe("main screen", () => {
  it("draws the header, the rows and the key hints", async () => {
    const ui = mount();
    await settle();

    const frame = ui.frame();
    expect(frame).toContain("fixture · profile all · 0/3 running · daemon 0.1.0");
    expect(frame).toContain("SUB api stopped");
    expect(frame).toContain("APP platform");
    expect(frame).toContain("SUB web stopped");
    expect(frame).toContain("SUB admin stopped");
    // The bar is truncated to the terminal, so it has to fit one: every binding
    // is on it, none of them behind an ellipsis.
    expect(frame).toContain("↑↓ move  ↵ logs  s/x/r target  S/X/R all  : palette  P profile  ? help  q quit");
  });

  it("marks the selected row and moves the mark with j/k", async () => {
    const ui = mount();
    await settle();
    expect(ui.frame()).toContain("❯ SUB api stopped");

    await ui.type("j");
    expect(ui.frame()).toContain("❯ APP platform");
    expect(ui.frame()).not.toContain("❯ SUB api");

    await ui.type("k");
    expect(ui.frame()).toContain("❯ SUB api stopped");
  });

  it("sends the lifecycle keys to the daemon", async () => {
    const ui = mount();
    await settle();

    await ui.type("j");
    await ui.type("s");

    expect(ui.client.paramsOf("service.start")).toEqual([{ targets: ["platform.web", "platform.admin"] }]);
    expect(ui.frame()).toContain("starting platform.web, platform.admin");
  });

  it("applies live pushes to the rows", async () => {
    const ui = mount();
    await settle();

    ui.client.push("indicator.changed", {
      values: [{ ns: "app", name: "status", scope: "subapp", owner: "api", value: "running", display: "●", tone: "ok" }],
    });
    ui.client.push("service.changed", {
      state: { targetId: "api", status: "running", stale: false, restartAttempts: 0 },
    });
    await ui.tick();

    expect(ui.frame()).toContain("SUB api running");
    expect(ui.frame()).toContain("1/3 running");
  });

  it("shows per-target progress on the rows of a run in flight", async () => {
    const ui = mount();
    await settle();

    ui.client.push("task.progress", {
      progress: { runId: "r1", command: "greet", targetId: "api", state: "running" },
    });
    await ui.tick();
    expect(ui.frame()).toContain("SUB api stopped  … running");

    ui.client.push("task.finished", {
      result: {
        runId: "r1",
        command: "greet",
        ok: false,
        targets: [
          { targetId: "api", state: "failed", durationMs: 20, exitCode: 3 },
          { targetId: "platform.web", state: "ok", durationMs: 10 },
        ],
        startedAt: 0,
        finishedAt: 1_200,
      },
    });
    await ui.tick();
    expect(ui.frame()).toContain("greet: 1 failed, 1 ok in 1.2s");
  });
});

describe("banners", () => {
  it("carries the config error while the daemon runs its last-good config", async () => {
    const ui = mount({ snapshot: fixtureSnapshot({ configError: "apps.api.path: no such directory" }) });
    await settle();

    expect(ui.frame()).toContain("config error — running the last-good config: apps.api.path: no such directory");
  });

  it("names a plugin that failed to load", async () => {
    const ui = mount();
    await settle();

    ui.client.push("plugin.error", { plugin: "deploy", error: "Unexpected token" });
    await ui.tick();

    expect(ui.frame()).toContain('plugin "deploy" disabled: Unexpected token');
  });

  it("shows a reconnecting banner instead of dying with the daemon", async () => {
    const ui = mount();
    await settle();

    ui.client.push("daemon.shutdown", { reason: "u8 daemon stop" });
    await ui.tick();
    expect(ui.frame()).toContain("daemon reconnecting");
    expect(ui.frame()).toContain("daemon unavailable — reconnecting…");
    // The rows are still there: the dashboard is stale, not gone.
    expect(ui.frame()).toContain("SUB api stopped");

    ui.client.reattach(fixtureSnapshot());
    await ui.tick();
    expect(ui.frame()).not.toContain("reconnecting");
  });
});

describe("log view", () => {
  it("backfills on enter, follows, and unsubscribes on esc", async () => {
    const ui = mount();
    ui.client.lines.push(logLine("api", "listening on :3000"));
    await settle();

    await ui.type("\r");
    expect(ui.frame()).toContain("logs api");
    expect(ui.frame()).toContain("listening on :3000");
    expect(ui.frame()).toContain("following");
    expect([...ui.client.subscribed]).toEqual(["api"]);

    ui.client.push("log.line", { line: logLine("api", "GET /healthz 200") });
    await ui.tick();
    expect(ui.frame()).toContain("GET /healthz 200");

    await ui.type("");
    await settle();
    expect(ui.frame()).toContain("SUB api stopped");
    expect(ui.client.unsubscribeCalls).toEqual(["api"]);
    expect(ui.client.subscribed.size).toBe(0);
  });

  it("prefixes lines only when the view merges several targets", async () => {
    const ui = mount();
    ui.client.lines.push(logLine("platform.web", "web up", 1), logLine("platform.admin", "admin up", 2));
    await settle();

    await ui.type("j");
    await ui.type("\r");

    expect(ui.frame()).toContain("platform.web | web up");
    expect(ui.frame()).toContain("platform.admin | admin up");
  });

  it("pauses following when scrolled back and says how to resume", async () => {
    const ui = mount();
    for (let i = 0; i < 40; i++) ui.client.lines.push(logLine("api", `line ${i}`, i));
    await settle();

    await ui.type("\r");
    expect(ui.frame()).toContain("line 39");

    await ui.type("k");
    expect(ui.frame()).toContain("paused — G or End resumes following");

    await ui.type("G");
    expect(ui.frame()).toContain("following");
    expect(ui.frame()).toContain("line 39");
  });
});

describe("command palette", () => {
  it("lists commands, filters them, and switches scope", async () => {
    const ui = mount();
    await settle();

    await ui.type(":");
    expect(ui.frame()).toContain("app:start");
    expect(ui.frame()).toContain("greet");
    expect(ui.frame()).toContain("on api");

    await ui.type("g");
    await ui.type("r");
    expect(ui.frame()).toContain("greet");
    expect(ui.frame()).not.toContain("app:start");

    await ui.type("\t");
    expect(ui.frame()).toContain("on profile all");

    await ui.type("\r");
    expect(ui.client.paramsOf("command.run")).toEqual([{ command: "greet", targets: undefined }]);
    expect(ui.frame()).toContain("running greet on profile all");
  });

  it("closes on esc without running anything", async () => {
    const ui = mount();
    await settle();

    await ui.type("p");
    await ui.type("");
    await settle();

    expect(ui.client.paramsOf("command.run")).toEqual([]);
    expect(ui.frame()).toContain("SUB api stopped");
  });
});

describe("profile switcher", () => {
  it("switches the profile and re-renders the list", async () => {
    const ui = mount();
    await settle();

    await ui.type("P");
    expect(ui.frame()).toContain("profiles");
    expect(ui.frame()).toContain("frontend");

    await ui.type("j");
    await ui.type("\r");
    await settle();

    expect(ui.client.paramsOf("profile.use")).toEqual([{ name: "frontend" }]);
    expect(ui.frame()).toContain("profile frontend");
    expect(ui.frame()).toContain("SUB web stopped");
    expect(ui.frame()).not.toContain("SUB api");
  });
});

describe("help", () => {
  it("toggles an overlay explaining what quitting costs", async () => {
    const ui = mount();
    await settle();

    await ui.type("?");
    expect(ui.frame()).toContain("quit the dashboard; the daemon and its services keep running");
    expect(ui.frame()).not.toContain("SUB api stopped");

    await ui.type("?");
    expect(ui.frame()).toContain("SUB api stopped");
  });
});

describe("terminal", () => {
  it("windows the list to the terminal and follows a resize", async () => {
    const ui = mount();
    await settle();
    expect(ui.frame()).toContain("SUB admin stopped");

    // 5 rows: header + footer + the line held back from Ink's full-screen path.
    await resize(ui, 5);
    expect(ui.frame()).toContain("rows 1-2/4");
    expect(ui.frame()).not.toContain("SUB admin stopped");

    // The cursor stays visible as it walks off the bottom of the window.
    await ui.type("G");
    expect(ui.frame()).toContain("❯ SUB admin stopped");
    expect(ui.frame()).not.toContain("SUB api stopped");

    await resize(ui, 24);
    expect(ui.frame()).toContain("SUB api stopped");
    expect(ui.frame()).not.toContain("rows 1-");
  });

  it("keeps its ANSI when colour is on", async () => {
    const ui = mount({ color: true });
    await settle();

    expect(ui.app.lastFrame()).toContain("[");
    expect(ui.app.lastFrame()).toContain("●");
  });
});

describe("teardown", () => {
  it("stops rendering on q and leaves nothing behind", async () => {
    const ui = mount();
    await settle();

    await ui.type("q");
    expect(ui.controller.getState().exited).toBe(true);

    const last = ui.frame();
    ui.client.push("indicator.changed", {
      values: [{ ns: "app", name: "status", scope: "subapp", owner: "api", value: "running", display: "●", tone: "ok" }],
    });
    await ui.tick();
    // Unmounted: the change lands in the controller but nothing draws it.
    expect(ui.frame()).toBe(last);

    expect(ui.app.stdout.listenerCount("resize")).toBe(0);
    await ui.controller.dispose();
    expect(ui.client.listenerCount()).toBe(0);
    expect(ui.clock.pending).toBe(0);
  });
});
