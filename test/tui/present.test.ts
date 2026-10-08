/**
 * The layout arithmetic.
 *
 * One invariant runs through all of it: every line the dashboard draws is
 * budgeted for. Draw one more than the terminal has and Ink scrolls the
 * terminal instead of redrawing in place, which smears the whole frame — so the
 * header's banner count and the list's viewport are checked against each other
 * here rather than discovered in a resized window.
 */
import { describe, expect, it } from "vitest";

import { displayWidth } from "../../src/template/index.js";
import {
  activityLines,
  banners,
  footerLines,
  headerText,
  hintText,
  listViewport,
  logTitle,
  logViewport,
  progressLabel,
  reportTitle,
  reportWindow,
  rowRangeText,
  summaryText,
  wrapLines,
  wrapText,
  FAREWELL,
  HELP,
  HINT_WIDTH_BUDGET,
} from "../../src/tui/present.js";
import type { DashboardState, LogViewState, Mode } from "../../src/tui/types.js";

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    mode: "list",
    help: false,
    connection: "connected",
    workspace: "fixture",
    daemonVersion: "0.1.0",
    profile: "all",
    profiles: [],
    rows: [],
    cursor: 0,
    windowTop: 0,
    viewport: 10,
    logViewport: 10,
    columns: 80,
    running: 1,
    total: 3,
    instances: 1,
    pluginErrors: [],
    progress: {},
    activeRuns: 0,
    activity: [],
    exited: false,
    ...overrides,
  };
}

describe("header", () => {
  it("says which workspace, which profile and how much of it is up", () => {
    expect(headerText(state())).toBe("fixture · profile all · 1/3 running · daemon 0.1.0");
  });

  it("says how many instances the count covers once there is more than base", () => {
    expect(headerText(state({ instances: 3, running: 4, total: 7 }))).toBe(
      "fixture · profile all · 3 instances · 4/7 running · daemon 0.1.0",
    );
  });

  it("says which instance the count is about while the list is narrowed to one", () => {
    expect(headerText(state({ instances: 3, focus: "feat-x", running: 1, total: 2 }))).toBe(
      "fixture · profile all · 3 instances · focus feat-x · 1/2 running · daemon 0.1.0",
    );
  });

  it("replaces the daemon version with its state once it stops answering", () => {
    expect(headerText(state({ connection: "reconnecting" }))).toContain("daemon reconnecting");
    expect(headerText(state({ connection: "lost" }))).toContain("daemon lost");
  });

  it("reports the window only while the list is taller than it", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      kind: "app" as const,
      id: `a.${i}`,
      repoName: "a",
      instance: "base",
      text: "",
      targets: [`a.${i}`],
    }));

    expect(rowRangeText(state({ rows, viewport: 10, windowTop: 5 }))).toBe("rows 6-15/40");
    expect(rowRangeText(state({ rows: rows.slice(0, 4), viewport: 10 }))).toBeUndefined();
  });
});

describe("banners", () => {
  it("shows nothing when the daemon is healthy", () => {
    expect(banners(state())).toEqual([]);
  });

  it("leads with the config error, then plugins, then the connection", () => {
    const failures = [
      { plugin: "a", error: "boom" },
      { plugin: "b", error: "bang" },
      { plugin: "c", error: "crash" },
    ];
    const lines = banners(state({ configError: "repos.api.path: missing", pluginErrors: failures, connection: "reconnecting" }));

    expect(lines.map((line) => line.text)).toEqual([
      "config error — running the last-good config: repos.api.path: missing",
      'plugin "a" disabled: boom',
      'plugin "b" disabled: bang',
      "…and 1 more plugin error(s)",
      "daemon unavailable — reconnecting…",
    ]);
  });

  it("says last that the worktree it was opened in has no instance", () => {
    const lines = banners(state({ configError: "bad", worktree: { dir: "/agents/wt", name: "wt" } }));

    expect(lines.map((line) => [line.tone, line.text])).toEqual([
      ["error", "config error — running the last-good config: bad"],
      ["warn", "this worktree has no instance of its own, so this is the base instance — i then w creates one for it"],
    ]);
  });

  it("flattens a multi-line config error onto one line", () => {
    const lines = banners(state({ configError: "two\nproblems\n  here" }));
    expect(lines[0]?.text).toBe("config error — running the last-good config: two problems here");
  });
});

describe("viewport", () => {
  const cases: Array<[string, DashboardState]> = [
    ["a healthy dashboard", state()],
    ["one with a notice", state({ notice: { text: "starting api", tone: "info" } })],
    [
      "one with everything wrong at once",
      state({
        configError: "bad",
        pluginErrors: [{ plugin: "a", error: "boom" }],
        connection: "reconnecting",
        notice: { text: "hi", tone: "warn" },
        summary: { runId: "r", command: "test", ok: false, counts: [], durationMs: 1 },
      }),
    ],
    ["one with an instance action in flight", state({ activity: ["feat-x: creating"] })],
    [
      "one opened in an unregistered worktree with more actions in flight than it lists",
      state({
        worktree: { dir: "/agents/wt", name: "wt" },
        activity: ["a: creating", "b: up", "c: destroying", "d: init"],
        notice: { text: "hi", tone: "info" },
      }),
    ],
  ];

  // One line short of the terminal, deliberately: a frame as tall as the screen
  // sends Ink down its clear-the-whole-terminal path, taking the user's shell
  // scrollback with it every render.
  it.each(cases)("leaves exactly one terminal line unspent for %s", (_label, value) => {
    const rows = 30;
    expect(1 + banners(value).length + listViewport(rows, value) + footerLines(value)).toBe(rows - 1);
    // The log view spends two of its own lines on the title and status bar.
    expect(1 + banners(value).length + 2 + logViewport(rows, value) + footerLines(value)).toBe(rows - 1);
  });

  it("never asks for a window smaller than one row", () => {
    expect(listViewport(1, state())).toBe(1);
    expect(logViewport(2, state({ configError: "bad" }))).toBe(1);
  });
});

describe("instance actions in flight", () => {
  it("gets a footer line each, up to two", () => {
    expect(activityLines(state())).toEqual([]);
    expect(activityLines(state({ activity: ["feat-x: creating", "agent-2: up — app:start"] }))).toEqual([
      "… feat-x: creating",
      "… agent-2: up — app:start",
    ]);
    expect(footerLines(state({ activity: ["feat-x: creating"] }))).toBe(2);
  });

  it("counts the ones past that instead of pushing the list off the screen", () => {
    const busy = state({ activity: ["a: creating", "b: up", "c: destroying", "d: init"] });

    expect(activityLines(busy)).toEqual(["… a: creating", "… and 3 more instance actions in flight"]);
    expect(footerLines(busy)).toBe(3);
  });
});

describe("panels of text", () => {
  it("leaves a line that fits alone", () => {
    expect(wrapText("instance feat-x destroyed", 80)).toEqual(["instance feat-x destroyed"]);
    expect(wrapText("", 80)).toEqual([""]);
  });

  it("wraps at words and hangs the continuation, so a sentence still reads as one", () => {
    const refusal =
      "the worktree at /wt/feat-x/api has uncommitted changes (README.md), so nothing was stopped or removed — " +
      "commit or stash them, leave the checkout in place by dropping --prune, or throw them away with --discard";

    const lines = wrapText(refusal, 60);

    expect(lines).toEqual([
      "the worktree at /wt/feat-x/api has uncommitted changes",
      "  (README.md), so nothing was stopped or removed — commit or",
      "  stash them, leave the checkout in place by dropping",
      "  --prune, or throw them away with --discard",
    ]);
    // Nothing lost, nothing over the edge.
    expect(lines.map((line) => line.trim()).join(" ")).toBe(refusal);
    expect(lines.every((line) => displayWidth(line) <= 60)).toBe(true);
  });

  it("wraps each line of a message that is already several", () => {
    // git's own failures come as two lines; one handed on whole would draw a row nobody counted.
    const git = "could not create a worktree: Preparing worktree (checking out 'main')\nfatal: 'main' is already checked out at '/ws/api'";

    expect(wrapText(git, 200)).toEqual(git.split("\n"));
    expect(wrapText(git, 40)).toEqual([
      "could not create a worktree: Preparing",
      "  worktree (checking out 'main')",
      "fatal: 'main' is already checked out at",
      "  '/ws/api'",
    ]);
    expect(wrapText("one\r\ntwo\tthree", 80)).toEqual(["one", "two  three"]);
    expect(wrapText("a\n\nb", 80)).toEqual(["a", "", "b"]);
    expect(wrapLines([{ text: "a\nb", tone: "error" }], 80)).toEqual([
      { text: "a", tone: "error" },
      { text: "b", tone: "error" },
    ]);
  });

  it("keeps a line's own indent, and hangs under it", () => {
    expect(wrapText("    api@feat-x listens on a port that is a long way off to the right", 30)).toEqual([
      "    api@feat-x listens on a",
      "      port that is a long way",
      "      off to the right",
    ]);
  });

  it("cuts a word wider than the line where it has to, rather than overflowing", () => {
    const dir = "/Users/somebody/Work/project/.u8/worktrees/feat-x/services/platform";

    const lines = wrapText(`  ${dir}`, 30);

    expect(lines.every((line) => displayWidth(line) <= 30)).toBe(true);
    expect(lines.map((line) => line.trim()).join("")).toBe(dir);
  });

  it("wraps toned lines without losing their tone", () => {
    expect(wrapLines([{ text: "one two three four five six", tone: "error" }, { text: "", tone: "plain" }], 12)).toEqual([
      { text: "one two", tone: "error" },
      { text: "  three four", tone: "error" },
      { text: "  five six", tone: "error" },
      { text: "", tone: "plain" },
    ]);
  });

  it("gives a report the body, less its title and the line of what it offers", () => {
    expect(reportWindow(10, { actions: [] })).toBe(9);
    expect(reportWindow(10, { actions: [{ key: "r", label: "restart it now" }] })).toBe(8);
    expect(reportWindow(1, { actions: [{ key: "r", label: "restart it now" }] })).toBe(1);
  });

  it("titles a report with how it ended and how many more are waiting", () => {
    const report = { title: "feat-x · add api", ok: true, lines: [], actions: [], top: 0, waiting: 0 };

    expect(reportTitle(report)).toBe("✓ feat-x · add api");
    expect(reportTitle({ ...report, ok: false, title: "feat-x · remove api — refused", waiting: 2 })).toBe(
      "✗ feat-x · remove api — refused  (2 more results after this)",
    );
    expect(reportTitle({ ...report, waiting: 1 })).toBe("✓ feat-x · add api  (1 more result after this)");
  });
});

describe("runs", () => {
  it("names the state of a single target and tallies several", () => {
    expect(progressLabel(["api"], { api: "running" })).toBe("… running");
    expect(progressLabel(["a", "b", "c"], { a: "ok", b: "ok", c: "failed" })).toBe("2 ok, 1 failed");
    expect(progressLabel(["api"], {})).toBeUndefined();
  });

  it("summarises a finished run in one line", () => {
    expect(
      summaryText({
        runId: "r1",
        command: "test",
        ok: false,
        counts: [
          { state: "ok", count: 2 },
          { state: "failed", count: 1 },
        ],
        durationMs: 2_400,
      }),
    ).toBe("test: 2 ok, 1 failed in 2.4s");
  });
});

describe("log title", () => {
  const view = (overrides: Partial<LogViewState> = {}): LogViewState => ({
    title: "platform.web",
    targets: ["platform.web"],
    prefix: false,
    lines: [],
    follow: true,
    loading: false,
    dropped: 0,
    ...overrides,
  });

  it("says what the view is doing and how much it is holding", () => {
    expect(logTitle(view(), 12)).toBe("logs platform.web · following · 12 lines");
    expect(logTitle(view({ follow: false }), 1)).toBe("logs platform.web · paused · 1 line");
    expect(logTitle(view({ loading: true }), 0)).toBe("logs platform.web · following · loading…");
    expect(logTitle(view({ dropped: 40 }), 2_000)).toBe("logs platform.web · following · 2000 lines · 40 dropped");
  });
});

describe("hints", () => {
  const modes: Mode[] = ["list", "logs", "palette", "profiles", "instance", "detail", "form", "confirm", "report"];

  it.each(modes)("fits an 80-column terminal in %s mode", (mode) => {
    expect(displayWidth(hintText(mode, false))).toBeLessThanOrEqual(HINT_WIDTH_BUDGET);
  });

  it("keeps the quit binding on the list bar", () => {
    expect(hintText("list", false)).toContain("q quit");
    expect(hintText("list", true)).toBe("? or esc  close help");
  });

  it("puts the instance menu on the list bar, and everything else about instances in the help", () => {
    expect(hintText("list", false)).toBe("↵ logs  s/x/r row  S/X/R all  i instance  : palette  P profile  ? help  q quit");

    const help = HELP.map((entry) => entry.keys);
    for (const keys of ["i", "tab ⇧tab", "← → / h l", "z", "f"]) expect(help).toContain(keys);
    // The overlay names each binding once.
    expect(new Set(help).size).toBe(help.length);
  });

  it("promises the stack survives the dashboard", () => {
    expect(FAREWELL).toContain("keep running");
    expect(displayWidth(FAREWELL)).toBeLessThanOrEqual(100);
  });
});
