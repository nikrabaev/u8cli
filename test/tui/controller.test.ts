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
import type { Snapshot } from "../../src/ipc/protocol.js";
import type { DashboardState } from "../../src/tui/types.js";
import {
  agent2,
  app,
  copyOf,
  createFakeClient,
  featX,
  fixtureSnapshot,
  indicator,
  instancePart,
  instancesSnapshot,
  logLine,
  serviceState,
  settle,
  statusIndicator,
  testScheduler,
  withInstances,
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
    instance: opts.instance,
    worktree: opts.worktree,
    now: opts.now,
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
      // A single-app repo is one merged row rendered with the app template.
      ["merged", "api", "APP api stopped"],
      ["repo", "platform", "REPO platform"],
      ["app", "platform.web", "APP web stopped"],
      ["app", "platform.admin", "APP admin stopped"],
    ]);
    expect(state().running).toBe(0);
    expect(state().total).toBe(3);
  });

  it("acts on every selected app from a repo header row", () => {
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

    expect(state().rows[0]?.text).toBe("APP api running");
    expect(state().running).toBe(1);
  });

  it("fills a bare token from the cells that carry no namespace", () => {
    const base = fixtureSnapshot();
    const { client, frame, state } = setup({
      client: createFakeClient({
        ...base,
        templates: { repo: "REPO {repo@name} {size}", app: "APP {app@name} {ver} {size} {nope}" },
        indicators: [
          ...base.indicators,
          indicator({ ns: "", name: "ver", scope: "app", owner: "api", value: "1.2.3" }),
          indicator({ ns: "", name: "ver", scope: "app", owner: "platform.web", value: "2.0" }),
          indicator({ ns: "", name: "size", scope: "repo", owner: "api", value: "4K" }),
          indicator({ ns: "", name: "size", scope: "repo", owner: "platform", value: "12M" }),
          // A plugin may use the same name; its namespace keeps the two apart.
          indicator({ ns: "meta", name: "ver", scope: "app", owner: "api", value: "plugin" }),
        ],
      }),
    });

    expect(state().rows.map((row) => row.text)).toEqual([
      // An app row reads its repo's cell for a token the app has none for.
      "APP api 1.2.3 4K {nope!}",
      "REPO platform 12M",
      "APP web 2.0 12M {nope!}",
      // No cell at all: the marker is spelled the way the token was.
      "APP admin {ver!} 12M {nope!}",
    ]);

    client.push("indicator.changed", {
      values: [indicator({ ns: "", name: "ver", scope: "app", owner: "platform.admin", value: "3.1" })],
    });
    frame();
    expect(state().rows[3]?.text).toBe("APP admin 3.1 12M {nope!}");
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
    expect(seen[0]?.rows[0]?.text).toBe("APP api stopped");
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

describe("instances", () => {
  /** The fixture plus one instance holding a copy of `api`. */
  function withInstance(): FakeClient {
    const base = fixtureSnapshot();
    const copy = { ...app("api"), id: "api@feat-x", baseId: "api", instance: "feat-x", repoName: "api@feat-x" };
    return createFakeClient({
      ...base,
      repos: [...base.repos, { name: "api@feat-x", baseName: "api", instance: "feat-x", path: "/wt/api", apps: [copy] }],
      instances: [
        ...base.instances,
        { name: "feat-x", isBase: false, createdAt: 1, appIds: ["api@feat-x"], checkouts: {}, initialized: false },
      ],
      services: [...base.services, serviceState("api@feat-x", "running")],
      indicators: [
        ...base.indicators,
        indicator({ ns: "app", name: "name", scope: "app", owner: "api@feat-x", value: "api" }),
        statusIndicator("api@feat-x", "running"),
      ],
    });
  }

  it("lists every instance under its own heading once there is more than base", () => {
    const { state } = setup({ client: withInstance() });
    expect(state().rows.map((row) => [row.kind, row.id, row.instance, row.text])).toEqual([
      ["instance", "instance:base", "base", "▾ base · profile all  0/3 running"],
      ["merged", "api", "base", "APP api stopped"],
      ["repo", "platform", "base", "REPO platform"],
      ["app", "platform.web", "base", "APP web stopped"],
      ["app", "platform.admin", "base", "APP admin stopped"],
      ["instance", "instance:feat-x", "feat-x", "▾ feat-x  1/1 running · not initialised"],
      ["merged", "api@feat-x", "feat-x", "APP api running"],
    ]);
    // The header counts what is on screen, and says how many instances that is.
    expect(state()).toMatchObject({ running: 1, total: 4, instances: 2 });
  });

  it("draws no heading for a workspace that only has base", () => {
    const { state } = setup();
    expect(state().rows.some((row) => row.kind === "instance")).toBe(false);
    expect(state().instances).toBe(1);
  });

  it("lands on the instance the dashboard was opened for", () => {
    const { state } = setup({ client: withInstance(), instance: "feat-x" });
    expect(state().rows[state().cursor]?.id).toBe("instance:feat-x");
  });

  it("means the instance under the cursor when a key says 'everything'", async () => {
    const { client, controller, state } = setup({ client: withInstance(), instance: "feat-x" });

    // On the heading: the selection is the whole instance, by id.
    await controller.stop("selection");
    // "The whole profile", said inside an instance, is that instance — never base.
    await controller.restart("profile");
    controller.setCursor(state().rows.findIndex((row) => row.id === "api"));
    await controller.restart("profile");

    expect(client.paramsOf("service.stop")).toEqual([{ targets: ["api@feat-x"], instance: "feat-x" }]);
    expect(client.paramsOf("service.restart")).toEqual([
      { targets: undefined, instance: "feat-x" },
      { targets: undefined, instance: "base" },
    ]);
  });
});

describe("section headings", () => {
  it("says what is wrong with an instance on its heading, and nothing when nothing is", () => {
    const snapshot = withInstances(
      fixtureSnapshot(),
      featX({ status: { "api@feat-x": "running", "platform.web@feat-x": "running" }, stale: ["api@feat-x"], initialized: false }),
      agent2(),
    );
    const { state } = setup({ client: createFakeClient(snapshot) });

    expect(state().rows.filter((row) => row.kind === "instance").map((row) => row.text)).toEqual([
      "▾ base · profile all  0/3 running",
      // Its web depends on base's platform.admin, which is not running.
      "▾ feat-x  2/2 running · not initialised · 1 stale · platform.admin@base is down",
      "▾ agent-2  0/1 running",
    ]);
  });

  it("follows the push stream: a base app coming up clears the flag on the instance that needs it", () => {
    const { client, frame, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    const heading = (): string | undefined => state().rows.find((row) => row.id === "instance:feat-x")?.text;
    expect(heading()).toBe("▾ feat-x  0/2 running · platform.admin@base is down");

    client.push("service.changed", { state: serviceState("platform.admin", "running") });
    frame();
    expect(heading()).toBe("▾ feat-x  0/2 running");

    client.push("service.changed", { state: serviceState("api@feat-x", "running", true) });
    frame();
    expect(heading()).toBe("▾ feat-x  1/2 running · 1 stale");
  });

  it("names the run in flight on the instance it touches, and on no other", () => {
    const { client, frame, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    const headings = (): string[] => state().rows.filter((row) => row.kind === "instance").map((row) => row.text);

    client.push("task.progress", {
      progress: { runId: "r1", command: "instance:init", targetId: "api@agent-2", state: "running" },
    });
    frame();
    expect(headings()).toEqual([
      "▾ base · profile all  0/3 running",
      "▾ feat-x  0/2 running · platform.admin@base is down",
      "▾ agent-2  0/1 running · … instance:init",
    ]);

    client.push("task.finished", {
      result: { runId: "r1", command: "instance:init", ok: true, targets: [], startedAt: 0, finishedAt: 1 },
    });
    frame();
    expect(headings()[2]).toBe("▾ agent-2  0/1 running");
  });
});

describe("moving between sections", () => {
  /** Row ids, with the cursor's marked. */
  const cursorRow = (state: DashboardState): string | undefined => state.rows[state.cursor]?.id;

  it("jumps to the next and the previous heading", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });

    controller.jumpSection(1);
    expect(cursorRow(state())).toBe("instance:feat-x");
    controller.jumpSection(1);
    expect(cursorRow(state())).toBe("instance:agent-2");
    // Nothing further down: it stays rather than wrapping to the top.
    controller.jumpSection(1);
    expect(cursorRow(state())).toBe("instance:agent-2");

    controller.jumpSection(-1);
    expect(cursorRow(state())).toBe("instance:feat-x");
  });

  it("goes back to the heading of the section it is in before leaving it", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });

    controller.setCursor(state().rows.findIndex((row) => row.id === "platform.web@feat-x"));
    controller.jumpSection(-1);
    expect(cursorRow(state())).toBe("instance:feat-x");
    controller.jumpSection(-1);
    expect(cursorRow(state())).toBe("instance:base");
  });

  it("folds a section into its heading and lands on it", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    controller.setCursor(state().rows.findIndex((row) => row.id === "platform.web@feat-x"));

    controller.collapseSection();

    expect(state().rows.map((row) => row.id)).toEqual([
      "instance:base",
      "api",
      "platform",
      "platform.web",
      "platform.admin",
      "instance:feat-x",
      "instance:agent-2",
      "api@agent-2",
    ]);
    expect(cursorRow(state())).toBe("instance:feat-x");
    expect(state().rows[state().cursor]?.text).toBe("▸ feat-x  0/2 running · platform.admin@base is down");
    // Folded away, not gone: the heading still counts them and still acts on them.
    expect(state().rows[state().cursor]?.targets).toEqual(["api@feat-x", "platform.web@feat-x"]);
    expect(state().total).toBe(6);

    controller.expandSection();
    expect(state().rows.map((row) => row.id)).toContain("platform.web@feat-x");
    expect(cursorRow(state())).toBe("instance:feat-x");
  });

  it("acts on the whole instance from a folded heading", async () => {
    const { client, controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    controller.setCursor(state().rows.findIndex((row) => row.id === "api@feat-x"));
    controller.collapseSection();

    await controller.stop("selection");
    await controller.restart("profile");

    expect(client.paramsOf("service.stop")).toEqual([
      { targets: ["api@feat-x", "platform.web@feat-x"], instance: "feat-x" },
    ]);
    expect(client.paramsOf("service.restart")).toEqual([{ targets: undefined, instance: "feat-x" }]);
  });

  it("folds every section into an overview, and unfolds them all again", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    controller.setCursor(state().rows.findIndex((row) => row.id === "api@agent-2"));

    controller.toggleAllSections();
    expect(state().rows.map((row) => row.text)).toEqual([
      "▸ base · profile all  0/3 running",
      "▸ feat-x  0/2 running · platform.admin@base is down",
      "▸ agent-2  0/1 running",
    ]);
    expect(cursorRow(state())).toBe("instance:agent-2");

    controller.toggleAllSections();
    expect(state().rows).toHaveLength(10);
    expect(cursorRow(state())).toBe("instance:agent-2");
  });

  it("folds an instance that appears while the list is an overview, and not otherwise", () => {
    const { client, controller, frame, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    const arrive = (name: string): void => {
      const next = withInstances(client.snapshot(), instancePart(name, [copyOf(app("api"), name)]));
      client.setSnapshot(next);
      client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
      frame();
    };

    arrive("agent-3");
    expect(state().rows.map((row) => row.id)).toContain("api@agent-3");

    controller.toggleAllSections();
    arrive("agent-4");
    // Somebody else's `u8 up`: one more heading, not five rows in the middle of the overview.
    expect(state().rows.map((row) => row.id)).toEqual([
      "instance:base",
      "instance:feat-x",
      "instance:agent-2",
      "instance:agent-3",
      "instance:agent-4",
    ]);
  });

  it("narrows the list to one instance, and says so in the header counts", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    controller.setCursor(state().rows.findIndex((row) => row.id === "platform.web@feat-x"));

    controller.toggleFocus();

    expect(state().focus).toBe("feat-x");
    // The heading stays: it is what says whose rows these are, and where `i` acts.
    expect(state().rows.map((row) => row.id)).toEqual(["instance:feat-x", "api@feat-x", "platform.web@feat-x"]);
    expect(cursorRow(state())).toBe("platform.web@feat-x");
    expect(state()).toMatchObject({ running: 0, total: 2, instances: 3 });

    controller.toggleFocus();
    expect(state().focus).toBeUndefined();
    expect(state().rows).toHaveLength(10);
    expect(cursorRow(state())).toBe("platform.web@feat-x");
  });

  it("unfolds the instance it focuses on", () => {
    const { controller, state } = setup({ client: createFakeClient(instancesSnapshot()) });
    controller.toggleAllSections();
    controller.jumpSection(1);

    controller.toggleFocus();

    expect(state().rows.map((row) => row.id)).toEqual(["instance:feat-x", "api@feat-x", "platform.web@feat-x"]);
  });

  it("has nothing to fold, focus or jump to in a workspace that only has base", () => {
    const { controller, state } = setup();
    const before = state().rows.map((row) => [row.kind, row.id, row.text]);
    controller.setCursor(2);

    controller.collapseSection();
    controller.toggleAllSections();
    controller.toggleFocus();
    controller.jumpSection(1);
    controller.jumpSection(-1);

    // The unheaded list a single-instance workspace has always drawn, untouched.
    expect(state().rows.map((row) => [row.kind, row.id, row.text])).toEqual(before);
    expect(before).toEqual([
      ["merged", "api", "APP api stopped"],
      ["repo", "platform", "REPO platform"],
      ["app", "platform.web", "APP web stopped"],
      ["app", "platform.admin", "APP admin stopped"],
    ]);
    expect(state().cursor).toBe(2);
    expect(state().focus).toBeUndefined();
    expect(state().notice).toBeUndefined();
  });
});

describe("the cursor when the list changes under it", () => {
  const cursorRow = (state: DashboardState): string | undefined => state.rows[state.cursor]?.id;

  /** Replaces the daemon's view with `next`, the way a reload does. */
  function reload(h: Harness, next: Snapshot): void {
    h.client.setSnapshot(next);
    h.client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
    h.frame();
  }

  it("lands on the heading that took a destroyed section's place, never on its neighbour's apps", () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@feat-x"));
    // The same index after the reload is `api@agent-2`: the next `x` would stop another task's api.
    const index = h.state().cursor;

    reload(h, withInstances(fixtureSnapshot(), agent2()));

    expect(h.state().rows[index]?.id).toBe("api@agent-2");
    expect(cursorRow(h.state())).toBe("instance:agent-2");
  });

  it("lands on the last heading when the last section is the one that went", () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));

    reload(h, withInstances(fixtureSnapshot(), featX()));

    expect(cursorRow(h.state())).toBe("instance:feat-x");
  });

  it("goes back to the top of an unheaded list when the only instance is destroyed", () => {
    const h = setup({ client: createFakeClient(withInstances(fixtureSnapshot(), agent2())) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));

    reload(h, fixtureSnapshot());

    expect(h.state().rows.some((row) => row.kind === "instance")).toBe(false);
    expect(h.state().cursor).toBe(0);
  });

  it("stays in its section when the app under it leaves the instance", () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "platform.web@feat-x"));

    const shrunk = featX();
    shrunk.instance.appIds = ["api@feat-x"];
    shrunk.repos = shrunk.repos.filter((repo) => repo.name === "api@feat-x");
    reload(h, withInstances(fixtureSnapshot(), shrunk, agent2()));

    // The row is gone; the section's last row is the nearest thing left, and
    // agent-2's heading — the same index — is not.
    expect(cursorRow(h.state())).toBe("api@feat-x");
  });

  it("does not move when somebody else's instance appears above it", () => {
    const h = setup({ client: createFakeClient(withInstances(fixtureSnapshot(), agent2())) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));

    reload(h, withInstances(fixtureSnapshot(), featX(), agent2()));

    expect(cursorRow(h.state())).toBe("api@agent-2");
  });

  it("drops a focus on an instance that is gone, and says so", () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.jumpSection(1);
    h.controller.toggleFocus();

    reload(h, withInstances(fixtureSnapshot(), agent2()));

    expect(h.state().focus).toBeUndefined();
    expect(h.state().rows.map((row) => row.id)).toContain("instance:base");
    expect(cursorRow(h.state())).toBe("instance:agent-2");
    expect(h.state().notice?.text).toBe("instance feat-x destroyed");
  });
});

describe("reload notices", () => {
  it("says what happened to the instances instead of 'config reloaded'", () => {
    const { client, frame, state } = setup({ client: createFakeClient(withInstances(fixtureSnapshot(), agent2())) });

    const grown = agent2();
    grown.instance.appIds = ["api@agent-2", "platform.web@agent-2"];
    client.push("config.reloaded", { ok: true, stale: [], snapshot: withInstances(fixtureSnapshot(), grown) });
    frame();
    expect(state().notice).toEqual({ text: "agent-2 gained platform.web", tone: "info" });

    client.push("config.reloaded", { ok: true, stale: [], snapshot: withInstances(fixtureSnapshot(), grown, featX()) });
    frame();
    expect(state().notice?.text).toBe("instance feat-x created");
  });

  it("still says 'config reloaded' when the config is what changed", () => {
    const { client, frame, state } = setup({ client: createFakeClient(instancesSnapshot()) });

    client.push("config.reloaded", { ok: true, stale: [], snapshot: instancesSnapshot({ activeProfile: "frontend" }) });
    frame();

    expect(state().notice?.text).toBe("config reloaded");
  });

  it("counts the changes past the first two rather than listing them all", () => {
    const { client, frame, state } = setup();
    const parts = ["a", "b", "c", "d"].map((name) => instancePart(name, [copyOf(app("api"), name)]));

    client.push("config.reloaded", { ok: true, stale: [], snapshot: withInstances(fixtureSnapshot(), ...parts) });
    frame();

    expect(state().notice?.text).toBe("instance a created; instance b created; and 2 more changes");
  });
});

describe("an unregistered worktree", () => {
  it("says the dashboard is showing base, until an instance runs from that worktree", () => {
    const h = setup({ worktree: "/agents/wt-3" });
    expect(h.state().worktree).toEqual({ dir: "/agents/wt-3", name: "wt-3" });

    // feat-x's platform checkout is /agents/wt-3/platform: the worktree is somebody's now.
    const next = withInstances(fixtureSnapshot(), featX());
    h.client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
    h.frame();
    expect(h.state().worktree).toBeUndefined();
  });

  it("is not mentioned when the dashboard was opened anywhere else", () => {
    expect(setup().state().worktree).toBeUndefined();
  });
});

describe("lifecycle keys", () => {
  it("starts the selection and the whole profile", async () => {
    const { client, controller } = setup();

    await controller.start("selection");
    controller.setCursor(1);
    await controller.stop("selection");
    await controller.restart("profile");

    expect(client.paramsOf("service.start")).toEqual([{ targets: ["api"], instance: "base" }]);
    // A repo header row acts on every app beneath it.
    expect(client.paramsOf("service.stop")).toEqual([{ targets: ["platform.web", "platform.admin"], instance: "base" }]);
    // No targets means "the active profile" on the wire.
    expect(client.paramsOf("service.restart")).toEqual([{ targets: undefined, instance: "base" }]);
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

  it("merges a repo's apps and prefixes their lines", async () => {
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
    const client = createFakeClient(fixtureSnapshot({ repos: [], profiles: [{ name: "all", isDefault: true, appIds: [] }] }));
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

    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: undefined, instance: "base" }]);
    expect(state().mode).toBe("list");
  });

  it("runs against the selection when that is the scope", async () => {
    const { client, controller } = setup();

    controller.setCursor(3);
    controller.openPalette();
    controller.paletteType("greet");
    await controller.paletteRun();

    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: ["platform.admin"], instance: "base" }]);
  });
});

describe("palette scope", () => {
  it("runs where its scope line said it would, wherever the cursor has been moved to since", async () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@feat-x"));
    h.controller.openPalette();
    expect(h.state().palette?.scopeLabel).toBe("api@feat-x");

    // No key moves the cursor under an open palette, but a rebuild can — an
    // instance destroyed, or one just created to land on. The move is made
    // directly here, which is the same thing to the palette.
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));
    expect(h.state().palette?.scopeLabel).toBe("api@feat-x");
    h.controller.paletteType("greet");
    await h.controller.paletteRun();

    expect(h.client.paramsOf("command.run")).toEqual([{ command: "greet", targets: ["api@feat-x"], instance: "feat-x" }]);
  });

  it("keeps 'the whole instance' meaning the instance it was opened in", async () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@feat-x"));
    h.controller.openPalette();
    h.controller.paletteToggleScope();
    expect(h.state().palette?.scopeLabel).toBe("instance feat-x");

    h.controller.setCursor(0);
    expect(h.state().palette?.scopeLabel).toBe("instance feat-x");
    await h.controller.paletteRun();

    expect(h.client.paramsOf("command.run")).toEqual([{ command: "app:start", targets: undefined, instance: "feat-x" }]);
  });

  it("closes rather than run a command on whatever took a destroyed instance's place", async () => {
    const h = setup({ client: createFakeClient(instancesSnapshot()) });
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@feat-x"));
    h.controller.openPalette();

    // feat-x is destroyed elsewhere; the cursor falls to agent-2's heading.
    const next = withInstances(fixtureSnapshot(), agent2());
    h.client.setSnapshot(next);
    h.client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
    // Before the frame that would show it: the key still goes to the palette.
    h.controller.handleKey("", { return: true });
    await settle();
    h.frame();

    expect(h.state().mode).toBe("list");
    expect(h.state().palette).toBeUndefined();
    expect(h.client.paramsOf("command.run")).toEqual([]);
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

  it("starts the new profile's list at the top, wherever the cursor was in the old one", async () => {
    const { controller, state } = setup();
    controller.setCursor(3);

    controller.openProfiles();
    controller.profilesMove(1);
    await controller.profilesSelect();

    // Two rows now; "the same place" in a different list would be its second.
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

    client.push("config.reloaded", { ok: false, error: "repos.api.path: no such directory", stale: [] });
    frame();
    expect(state().configError).toBe("repos.api.path: no such directory");
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
    expect(state().rows[0]?.text).toBe("APP api stopped");
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

    controller.setCursor(1); // a repo header row: two targets, two subscriptions
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
