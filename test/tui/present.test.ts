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
  banners,
  footerLines,
  headerText,
  hintText,
  listViewport,
  logTitle,
  logViewport,
  progressLabel,
  rowRangeText,
  summaryText,
  FAREWELL,
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
    running: 1,
    total: 3,
    instances: 1,
    pluginErrors: [],
    progress: {},
    activeRuns: 0,
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
  const modes: Mode[] = ["list", "logs", "palette", "profiles"];

  it.each(modes)("fits an 80-column terminal in %s mode", (mode) => {
    expect(displayWidth(hintText(mode, false))).toBeLessThanOrEqual(HINT_WIDTH_BUDGET);
  });

  it("keeps the quit binding on the list bar", () => {
    expect(hintText("list", false)).toContain("q quit");
    expect(hintText("list", true)).toBe("? or esc  close help");
  });

  it("promises the stack survives the dashboard", () => {
    expect(FAREWELL).toContain("keep running");
    expect(displayWidth(FAREWELL)).toBeLessThanOrEqual(100);
  });
});
