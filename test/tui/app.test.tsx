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
import { U8Error } from "../../src/util/errors.js";
import {
  createFakeClient,
  featX,
  fixtureSnapshot,
  instancesSnapshot,
  logLine,
  serviceState,
  settle,
  taskResult,
  testScheduler,
  withInstances,
  type FakeClient,
  type TestScheduler,
} from "./helpers.js";

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

function mount(opts: { snapshot?: Snapshot; client?: FakeClient; color?: boolean; worktree?: string } = {}): Mounted {
  const client = opts.client ?? createFakeClient(opts.snapshot ?? fixtureSnapshot());
  const clock = testScheduler();
  const controller = createController({
    client,
    color: opts.color ?? false,
    scheduler: clock.schedule,
    worktree: opts.worktree,
    now: () => 5_000,
  });
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
    expect(lines[1]).toContain("APP api stopped");
    expect(lines.slice(5, -1).every((line) => line.trim() === "")).toBe(true);
  });

  it("keeps the hint bar on the last line when there is nothing to list", async () => {
    const ui = mount({ snapshot: fixtureSnapshot({ profiles: [{ name: "all", isDefault: true, appIds: [] }] }) });
    await settle();
    const lines = ui.frame().split("\n");

    expect(lines).toHaveLength(frameRows(24));
    expect(ui.frame()).toContain('no targets in profile "all"');
    expect(lines.at(-1)).toContain("q quit");
  });

  it("keeps the hint bar on the last line in every mode", async () => {
    const ui = mount();
    await settle();

    for (const [key, expected] of [
      ["?", "close help"],
      ["?", "q quit"],
      [":", "esc close"],
      ["\u001B", "q quit"],
      ["P", "esc close"],
      ["\u001B", "q quit"],
      // The instance menu, then each surface it leads to.
      ["i", "its letter runs it"],
      ["v", "i actions  esc back"],
      ["i", "its letter runs it"],
      ["n", "esc cancel"],
    ] as const) {
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
    expect(frame).toContain("APP api stopped");
    expect(frame).toContain("REPO platform");
    expect(frame).toContain("APP web stopped");
    expect(frame).toContain("APP admin stopped");
    // The bar is truncated to the terminal, so it has to fit one: every binding
    // is on it, none of them behind an ellipsis.
    expect(frame).toContain("↵ logs  s/x/r row  S/X/R all  i instance  : palette  P profile  ? help  q quit");
  });

  it("marks the selected row and moves the mark with j/k", async () => {
    const ui = mount();
    await settle();
    expect(ui.frame()).toContain("❯ APP api stopped");

    await ui.type("j");
    expect(ui.frame()).toContain("❯ REPO platform");
    expect(ui.frame()).not.toContain("❯ APP api");

    await ui.type("k");
    expect(ui.frame()).toContain("❯ APP api stopped");
  });

  it("sends the lifecycle keys to the daemon", async () => {
    const ui = mount();
    await settle();

    await ui.type("j");
    await ui.type("s");

    expect(ui.client.paramsOf("service.start")).toEqual([{ targets: ["platform.web", "platform.admin"], instance: "base" }]);
    expect(ui.frame()).toContain("starting platform.web, platform.admin");
  });

  it("applies live pushes to the rows", async () => {
    const ui = mount();
    await settle();

    ui.client.push("indicator.changed", {
      values: [{ ns: "app", name: "status", scope: "app", owner: "api", value: "running", display: "●", tone: "ok" }],
    });
    ui.client.push("service.changed", {
      state: { targetId: "api", status: "running", stale: false, restartAttempts: 0 },
    });
    await ui.tick();

    expect(ui.frame()).toContain("APP api running");
    expect(ui.frame()).toContain("1/3 running");
  });

  it("shows per-target progress on the rows of a run in flight", async () => {
    const ui = mount();
    await settle();

    ui.client.push("task.progress", {
      progress: { runId: "r1", command: "greet", targetId: "api", state: "running" },
    });
    await ui.tick();
    expect(ui.frame()).toContain("APP api stopped  … running");

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

describe("instances", () => {
  /** The frame with every run of spaces and every line break folded to one space. */
  const flat = (ui: Mounted): string => ui.frame().replace(/\s+/g, " ");

  it("draws a heading per instance, with what is wrong on it", async () => {
    const ui = mount({
      snapshot: withInstances(fixtureSnapshot(), featX({ status: { "api@feat-x": "running" }, stale: ["api@feat-x"], initialized: false })),
    });
    await settle();
    const frame = ui.frame();

    expect(frame).toContain("fixture · profile all · 2 instances · 1/5 running");
    expect(frame).toContain("❯ ▾ base · profile all  0/3 running");
    expect(frame).toContain("  ▾ feat-x  1/2 running · not initialised · 1 stale · platform.admin@base is down");
    expect(frame).toContain("APP api running");
  });

  it("folds a section with ← and narrows to one with f", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();

    await ui.type("\t");
    await ui.type("\u001B[D");
    expect(ui.frame()).toContain("❯ ▸ feat-x  0/2 running");
    // agent-2's api is the only instance copy still drawn.
    expect(ui.frame().match(/APP api stopped/g)).toHaveLength(2);

    await ui.type("\u001B[C");
    await ui.type("f");
    expect(ui.frame()).toContain("focus feat-x · 0/2 running");
    expect(ui.frame()).not.toContain("agent-2  0/1");
    expect(ui.frame()).not.toContain("base · profile all");
    expect(ui.frame()).toContain("showing feat-x only — f shows every instance again");
  });

  it("opens the menu of the instance under the cursor, with a letter per entry", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();

    await ui.type("\t");
    await ui.type("i");
    const frame = ui.frame();

    expect(frame).toContain("instance feat-x · 0/2 running · platform.admin@base is down");
    expect(frame).toContain("❯ v  details");
    expect(frame).toContain("  a  add apps…                 platform.admin");
    expect(frame).toContain("  c  give up a kept checkout…  infra");
    expect(frame).toContain("  D  destroy…");
    expect(frame.split("\n").at(-1)).toContain("↵ or its letter runs it");
  });

  it("shows what an instance is made of", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();

    await ui.type("\t");
    await ui.type("i");
    await ui.type("v");
    const frame = ui.frame();

    expect(frame).toContain("instance feat-x · 0/2 running · initialised · created 4.0s ago");
    expect(frame).toContain("  platform  adopted — u8 never removes it");
    expect(frame).toContain("            /agents/wt-3/platform");
    expect(frame).toContain("  infra     branch feat-x · created by u8 · no apps (kept)");
    expect(frame).toContain("  api           stopped  http 20001  http://localhost:20001");
    expect(frame).toContain("platform.admin@base  stopped — not running  (needed by platform.web)");
  });

  it("draws the create form, and a refusal under it without losing what was typed", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();
    ui.client.failOnce("instance.create", new U8Error("INSTANCE_EXISTS", 'instance "feat-x" already exists'));

    await ui.type("i");
    await ui.type("n");
    expect(ui.frame()).toContain("new instance");
    expect(ui.frame()).toContain("❯ name    ▌");
    expect(ui.frame()).toContain("  branch  the instance's name");
    expect(ui.frame()).toContain("  [x] platform.admin");

    await ui.type("feat-x");
    expect(ui.frame()).toContain("❯ name    feat-x▌");
    await ui.type("\r");
    await settle();

    expect(ui.frame()).toContain('✗ instance "feat-x" already exists');
    expect(ui.frame()).toContain("❯ name    feat-x▌");
    expect(ui.frame().split("\n").at(-1)).toContain("esc cancel");
  });

  it("draws every line of a refusal that is several, without growing the frame", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();
    const git =
      "could not create a worktree for \"api\": Preparing worktree (checking out 'main')\nfatal: 'main' is already checked out at '/ws/api'";
    ui.client.failOnce("instance.create", new U8Error("WORKTREE_FAILED", git));

    await ui.type("i");
    await ui.type("n");
    await ui.type("dup");
    await ui.type("\r");
    await settle();

    const lines = ui.frame().split("\n");
    expect(lines).toHaveLength(frameRows(24));
    expect(ui.frame()).toContain("✗ could not create a worktree for \"api\": Preparing worktree (checking out 'main')");
    expect(ui.frame()).toContain("fatal: 'main' is already checked out at '/ws/api'");
    // The field the cursor is on, and the key bar, are still where they were.
    expect(ui.frame()).toContain("❯ name    dup▌");
    expect(lines.at(-1)).toContain("esc cancel");
  });

  it("says so when a refusal is longer than a short terminal can show", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();
    const long = Array.from({ length: 12 }, (_, i) => `issue ${i + 1}: something the config got wrong`).join("\n");
    ui.client.failOnce("instance.create", new U8Error("INSTANCE_INVALID", long));

    await resize(ui, 10);
    await ui.type("i");
    await ui.type("n");
    await ui.type("x");
    await ui.type("\r");
    await settle();

    const lines = ui.frame().split("\n");
    expect(lines).toHaveLength(frameRows(10));
    expect(ui.frame()).toContain("✗ issue 1: something the config got wrong");
    // Cut, and marked as cut: a refusal that just stops reads as the whole of it.
    expect(ui.frame()).toMatch(/… \d+ more lines do not fit this terminal/);
    expect(ui.frame()).toContain("❯ name    x▌");
    expect(lines.at(-1)).toContain("esc cancel");
  });

  it("asks for the instance's name before destroying it, and shows what goes", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();

    await ui.type("\t");
    await ui.type("i");
    await ui.type("D");
    expect(ui.frame()).toContain("destroy instance feat-x");
    expect(ui.frame()).toContain("removes 2 worktrees u8 created, with whatever is uncommitted in them:");
    expect(ui.frame()).toContain("  /wt/feat-x/api");
    expect(ui.frame()).toContain("type feat-x and press ↵ to destroy it: ▌");

    await ui.type("feat");
    expect(ui.frame()).toContain("type feat-x and press ↵ to destroy it: feat▌");
    await ui.type("\r");
    expect(ui.client.paramsOf("instance.destroy")).toEqual([]);
    expect(ui.frame()).toContain("type feat-x exactly to destroy it — esc cancels");

    await ui.type("-x");
    await ui.type("\r");
    await settle();
    expect(ui.client.paramsOf("instance.destroy")).toEqual([{ name: "feat-x", force: undefined }]);
    expect(ui.frame()).toContain("… feat-x: destroying");
  });

  it("shows a refused prune in full, wrapped to the terminal, with the way on from it", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();
    const refusal =
      "the worktree at /wt/feat-x/api has uncommitted changes (README.md, src/a.ts and 3 more), so nothing was stopped or removed — " +
      "commit or stash them, leave the checkout in place by dropping --prune, or throw them away with --discard";
    ui.client.failOnce("instance.remove", new U8Error("WORKTREE_FAILED", refusal));

    await ui.type("\t");
    await ui.type("j");
    await ui.type("i");
    await ui.type("d");
    expect(ui.frame()).toContain("remove apps from feat-x");
    expect(ui.frame()).toContain("❯ [x] api");
    expect(ui.frame()).toContain("checkout of a repo left with no apps: (•) keep it  ( ) give it up");

    await ui.type("\u001B[B");
    await ui.type("\u001B[B");
    await ui.type("\u001B[C");
    expect(ui.frame()).toContain("( ) keep it  (•) give it up");
    await ui.type("\r");
    await settle();

    expect(ui.frame()).toContain("✗ feat-x · remove api — refused");
    // Longer than the terminal is wide, and not one word of it is cut.
    expect(refusal.length).toBeGreaterThan(200);
    expect(flat(ui)).toContain(refusal);
    expect(ui.frame().split("\n").every((line) => line.length <= 100)).toBe(true);
    expect(ui.frame()).toContain("D discard the uncommitted changes and remove the worktree…");
    expect(ui.frame().split("\n").at(-1)).toContain("↵ or esc close");

    await ui.type("D");
    expect(ui.frame()).toContain("discard uncommitted changes — feat-x");
    expect(ui.frame()).toContain("type feat-x and press ↵ to discard and remove: ▌");
  });

  it("ends an action with its result, and a failed one with the end of its log", async () => {
    const ui = mount({ snapshot: instancesSnapshot() });
    await settle();
    ui.client.lines.push(logLine("api@feat-x", "npm ERR! missing script: build"));

    await ui.type("\t");
    await ui.type("i");
    await ui.type("i");
    await settle();
    await ui.tick();
    expect(ui.frame()).toContain("… feat-x: init — instance:init");
    // The activity line is budgeted for like any other: the frame is as tall as it was.
    expect(ui.frame().split("\n")).toHaveLength(frameRows(24));

    ui.client.finish(
      taskResult(
        "run-1",
        "instance:init",
        [
          { targetId: "api@feat-x", state: "failed", exitCode: 1, durationMs: 3 },
          { targetId: "platform.web@feat-x", state: "ok", durationMs: 3 },
        ],
        false,
      ),
    );
    await settle();
    await ui.tick();

    const frame = ui.frame();
    expect(frame).toContain("✗ feat-x · init — failed");
    expect(frame).toContain("✗ api@feat-x failed — exit 1");
    expect(frame).toContain("── api@feat-x: last 1 line ──");
    expect(frame).toContain("npm ERR! missing script: build");
    expect(frame).not.toContain("… feat-x: init");
    expect(frame.split("\n")).toHaveLength(frameRows(24));

    await ui.type("\r");
    expect(ui.frame()).toContain("▾ feat-x  0/2 running");
  });

  it("offers the restart a membership change calls for, and sends it", async () => {
    const before = withInstances(fixtureSnapshot(), featX({ status: { "platform.web@feat-x": "running" } }));
    const ui = mount({ snapshot: before });
    await settle();

    await ui.type("\t");
    await ui.type("j");
    await ui.type("i");
    await ui.type("d");
    await ui.type("\r");
    await settle();
    const after = withInstances(fixtureSnapshot(), featX({ status: { "platform.web@feat-x": "running" }, stale: ["platform.web@feat-x"] }));
    const instance = after.instances.find((i) => i.name === "feat-x");
    if (instance) instance.appIds = ["platform.web@feat-x"];
    after.repos = after.repos.filter((repo) => repo.name !== "api@feat-x");
    after.services = [...after.services.filter((s) => s.targetId !== "api@feat-x"), serviceState("api@feat-x", "stopped")];
    ui.client.setSnapshot(after);
    ui.client.finish(taskResult("run-1", "instance:teardown", ["api@feat-x"]));
    await settle();
    await ui.tick();

    expect(ui.frame()).toContain("✓ feat-x · remove api");
    expect(flat(ui)).toContain("platform.web@feat-x is now stale: it is still running with what it pointed at before this change");
    expect(ui.frame()).toContain("r restart it now");

    await ui.type("r");
    expect(ui.client.paramsOf("service.restart")).toEqual([{ targets: ["platform.web@feat-x"], instance: "feat-x" }]);
    expect(ui.frame()).toContain("restarting platform.web@feat-x");
  });

  it("says so when it was opened in a worktree that has no instance, and offers one", async () => {
    const ui = mount({ worktree: "/agents/fix-login" });
    await settle();

    expect(ui.frame()).toContain("this worktree has no instance of its own, so this is the base instance — i then w creates one for it");
    // A banner is a line like any other: the frame did not grow.
    expect(ui.frame().split("\n")).toHaveLength(frameRows(24));

    await ui.type("i");
    expect(ui.frame()).toContain("  w  new instance from this worktree…  /agents/fix-login");
    await ui.type("w");
    expect(ui.frame()).toContain("uses /agents/fix-login as it is — u8 never removes a worktree it did not create");
    expect(ui.frame()).toContain("❯ name  fix-login▌");
  });
});

describe("banners", () => {
  it("carries the config error while the daemon runs its last-good config", async () => {
    const ui = mount({ snapshot: fixtureSnapshot({ configError: "repos.api.path: no such directory" }) });
    await settle();

    expect(ui.frame()).toContain("config error — running the last-good config: repos.api.path: no such directory");
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
    expect(ui.frame()).toContain("APP api stopped");

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
    expect(ui.frame()).toContain("APP api stopped");
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
    expect(ui.client.paramsOf("command.run")).toEqual([{ command: "greet", targets: undefined, instance: "base" }]);
    expect(ui.frame()).toContain("running greet on profile all");
  });

  it("closes on esc without running anything", async () => {
    const ui = mount();
    await settle();

    await ui.type("p");
    await ui.type("");
    await settle();

    expect(ui.client.paramsOf("command.run")).toEqual([]);
    expect(ui.frame()).toContain("APP api stopped");
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
    expect(ui.frame()).toContain("APP web stopped");
    expect(ui.frame()).not.toContain("APP api");
  });
});

describe("help", () => {
  it("toggles an overlay explaining what quitting costs", async () => {
    const ui = mount();
    await settle();

    await ui.type("?");
    expect(ui.frame()).toContain("quit the dashboard; the daemon and its services keep running");
    expect(ui.frame()).not.toContain("APP api stopped");

    await ui.type("?");
    expect(ui.frame()).toContain("APP api stopped");
  });
});

describe("terminal", () => {
  it("windows the list to the terminal and follows a resize", async () => {
    const ui = mount();
    await settle();
    expect(ui.frame()).toContain("APP admin stopped");

    // 5 rows: header + footer + the line held back from Ink's full-screen path.
    await resize(ui, 5);
    expect(ui.frame()).toContain("rows 1-2/4");
    expect(ui.frame()).not.toContain("APP admin stopped");

    // The cursor stays visible as it walks off the bottom of the window.
    await ui.type("G");
    expect(ui.frame()).toContain("❯ APP admin stopped");
    expect(ui.frame()).not.toContain("APP api stopped");

    await resize(ui, 24);
    expect(ui.frame()).toContain("APP api stopped");
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
      values: [{ ns: "app", name: "status", scope: "app", owner: "api", value: "running", display: "●", tone: "ok" }],
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
