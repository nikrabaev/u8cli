/**
 * Instance actions, from the key that opens the menu to the report that says
 * how it went.
 *
 * Driven the way a user drives them — keys into the controller — against the
 * fake client, which proves two things: that each action sends the request it
 * means to, for the instance it was asked on, and that nothing destructive is
 * sent until it has been asked for twice. What the daemon really answers is
 * `daemon.test.ts`'s business; here its answers are scripted, so that a
 * refusal, a failed step and a dropped connection can each be arranged in a
 * line.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { Snapshot, TaskResult } from "../../src/ipc/protocol.js";
import { createController, DEFAULT_FRAME_MS, type DashboardController } from "../../src/tui/controller.js";
import type { DashboardState, TuiKey } from "../../src/tui/types.js";
import { U8Error } from "../../src/util/errors.js";
import {
  agent2,
  app,
  copyOf,
  createFakeClient,
  featX,
  fixtureSnapshot,
  instancePart,
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

interface Harness {
  client: FakeClient;
  clock: TestScheduler;
  controller: DashboardController;
  state(): DashboardState;
  /** One keypress, as Ink reports it, with the promises it started settled. */
  press(input: string, key?: TuiKey): Promise<void>;
  /** Text, a character at a time. */
  type(text: string): Promise<void>;
  enter(): Promise<void>;
  escape(): Promise<void>;
  down(times?: number): Promise<void>;
  /** Moves the cursor to a row and opens the menu of the instance it is in. */
  menuOn(rowId: string): Promise<void>;
  /** Replaces the daemon's view, the way a reload does. */
  reload(next: Snapshot): void;
  /** Ends the oldest run in flight. */
  finish(result: (runId: string) => TaskResult): Promise<void>;
  /** The lines of the result on screen. */
  report(): string[];
  /** Every instance-changing request sent so far. */
  mutations(): string[];
}

const live: DashboardController[] = [];

const MUTATING = ["instance.create", "instance.add", "instance.remove", "instance.destroy", "instance.init"] as const;

function setup(snapshot: Snapshot = instancesSnapshot(), opts: { worktree?: string } = {}): Harness {
  const client = createFakeClient(snapshot);
  const clock = testScheduler();
  const controller = createController({ client, color: false, scheduler: clock.schedule, worktree: opts.worktree, now: () => 5_000 });
  // Wide enough that no sentence is wrapped: these tests are about what is said.
  controller.setColumns(1_000);
  controller.setViewport(200);
  live.push(controller);

  const h: Harness = {
    client,
    clock,
    controller,
    state: () => controller.getState(),
    // What a key sets in motion is partly a push away — the activity line of an
    // action the daemon has just taken, say — so each one is followed by a frame.
    async press(input, key = {}) {
      controller.handleKey(input, key);
      await settle();
      clock.advance(DEFAULT_FRAME_MS);
    },
    async type(text) {
      for (const ch of text) controller.handleKey(ch, {});
      await settle();
      clock.advance(DEFAULT_FRAME_MS);
    },
    enter: () => h.press("", { return: true }),
    escape: () => h.press("", { escape: true }),
    async down(times = 1) {
      for (let i = 0; i < times; i++) controller.handleKey("", { downArrow: true });
      await settle();
    },
    async menuOn(rowId) {
      const index = controller.getState().rows.findIndex((row) => row.id === rowId);
      if (index < 0) throw new Error(`no row ${rowId}`);
      controller.setCursor(index);
      await h.press("i");
    },
    reload(next) {
      client.setSnapshot(next);
      client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
      clock.advance(DEFAULT_FRAME_MS);
    },
    async finish(result) {
      const runId = client.running[0];
      if (runId === undefined) throw new Error("no run in flight");
      client.finish(result(runId));
      await settle();
      clock.advance(DEFAULT_FRAME_MS);
    },
    report: () => controller.getState().report?.lines.map((line) => line.text) ?? [],
    mutations: () => client.calls.filter((call) => (MUTATING as readonly string[]).includes(call.method)).map((call) => call.method),
  };
  return h;
}

afterEach(async () => {
  for (const controller of live.splice(0)) await controller.dispose();
});

/** `feat-x` with other apps: what a snapshot looks like after its membership changed. */
function featXWith(ids: Array<"api" | "platform.web" | "platform.admin">, opts: Parameters<typeof featX>[0] = {}): ReturnType<typeof featX> {
  const part = featX(opts);
  const all = {
    api: copyOf(app("api"), "feat-x", { ports: { http: 20001 } }),
    "platform.web": copyOf(app("platform", "web"), "feat-x", { ports: { http: 20002 }, dependsOn: ["platform.admin"] }),
    "platform.admin": copyOf(app("platform", "admin"), "feat-x", { ports: { http: 20003 } }),
  };
  const own = ids.includes("platform.admin")
    ? { ...all, "platform.web": { ...all["platform.web"], dependsOn: ["platform.admin@feat-x"] } }
    : all;
  const next = instancePart(
    "feat-x",
    ids.map((id) => own[id]),
    { checkouts: part.instance.checkouts, createdAt: 1_000, status: opts.status, stale: opts.stale, initialized: opts.initialized },
  );
  return next;
}

// ---------------------------------------------------------------------------

describe("the instance menu", () => {
  it("offers base nothing that edits or destroys it", async () => {
    const h = setup();
    await h.press("i");

    expect(h.state().mode).toBe("instance");
    expect(h.state().instanceMenu).toMatchObject({ instance: "base", summary: "0/3 running" });
    expect(h.state().instanceMenu?.items.map((item) => [item.key, item.id])).toEqual([
      ["v", "details"],
      ["u", "up"],
      ["i", "init"],
      ["n", "new"],
    ]);

    // The letters that mean add, remove, give up and destroy elsewhere mean nothing here.
    for (const key of ["a", "d", "c", "D"]) await h.press(key);

    expect(h.state().mode).toBe("instance");
    expect(h.mutations()).toEqual([]);
  });

  it("offers an instance everything, and starts remove from the list's selection", async () => {
    const h = setup();
    await h.menuOn("platform.web@feat-x");

    expect(h.state().instanceMenu?.summary).toBe("0/2 running · platform.admin@base is down");
    expect(h.state().instanceMenu?.items.map((item) => [item.key, item.label, item.hint])).toEqual([
      ["v", "details", "checkouts, ports, what it uses from base"],
      ["u", "up", "init if needed, start, wait until ready"],
      ["i", "init", "run the init steps again"],
      ["a", "add apps…", "platform.admin"],
      ["d", "remove apps…", "platform.web (the selection)"],
      // Only there while there is one: the checkout an earlier remove kept.
      ["c", "give up a kept checkout…", "infra"],
      ["D", "destroy…", "stop it, run teardown, remove the worktrees u8 created"],
      ["n", "new instance…", "its own worktrees, ports and processes"],
    ]);
  });

  it("does not take a heading for a selection: removing everything is destroy", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");

    expect(h.state().instanceMenu?.items.find((item) => item.id === "remove")?.hint).toBe("choose which");
  });

  it("greys out add when the instance already runs everything, and says why", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featXWith(["api", "platform.web", "platform.admin"])));
    await h.menuOn("instance:feat-x");

    expect(h.state().instanceMenu?.items.find((item) => item.id === "add")?.disabled).toBe(
      "it already runs every app the config declares",
    );
    await h.press("a");

    expect(h.state().mode).toBe("instance");
    expect(h.state().notice).toEqual({ text: "feat-x: it already runs every app the config declares", tone: "warn" });
  });

  it("stays about the instance it was opened on, wherever the cursor is by the time a key is pressed", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");

    // No key moves the cursor while the menu is up; a rebuild can. Either way
    // the menu said "instance feat-x" when it opened, and that is what D means.
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));
    await h.press("D");

    expect(h.state().confirm).toMatchObject({ title: "destroy instance feat-x", expect: "feat-x" });
    // The other instance's name is not the answer either.
    await h.type("agent-2");
    await h.enter();
    expect(h.mutations()).toEqual([]);
    for (const _ of "agent-2") await h.press("", { backspace: true });
    await h.type("feat-x");
    await h.enter();
    expect(h.client.paramsOf("instance.destroy")).toEqual([{ name: "feat-x", force: undefined }]);
  });

  it("is not thrown by rows moving under it when somebody else's instance goes away", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");

    // feat-x is destroyed elsewhere: agent-2's rows move up, and the menu is still agent-2's.
    h.reload(withInstances(fixtureSnapshot(), agent2()));
    await h.press("D");

    expect(h.state().confirm).toMatchObject({ title: "destroy instance agent-2", expect: "agent-2" });
  });

  it("closes when its instance is destroyed underneath it", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");

    h.reload(withInstances(fixtureSnapshot(), agent2()));

    expect(h.state().mode).toBe("list");
    expect(h.state().instanceMenu).toBeUndefined();
  });

  it("does not act on a key that lands between its instance going away and the next frame", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");

    // The reload is in, the frame that would show the list is not: the screen
    // still says "instance feat-x", and the key is sent to the menu.
    const next = withInstances(fixtureSnapshot(), agent2());
    h.client.setSnapshot(next);
    h.client.push("config.reloaded", { ok: true, stale: [], snapshot: next });
    expect(h.state().mode).toBe("instance");
    h.controller.handleKey("D", {});
    h.controller.handleKey("", { return: true });
    await settle();
    h.clock.advance(DEFAULT_FRAME_MS);

    expect(h.state().mode).toBe("list");
    expect(h.state().confirm).toBeUndefined();
    expect(h.client.calls.filter((call) => call.method !== "logs.read")).toEqual([]);
    expect(h.state().logs).toBeUndefined();
  });

  it("keeps its highlight on the entry, not the index, when the entries change under it", async () => {
    const before = featX();
    delete before.instance.checkouts["infra@feat-x"];
    const h = setup(withInstances(fixtureSnapshot(), before, agent2()));
    await h.menuOn("instance:feat-x");
    const destroy = h.state().instanceMenu?.items.findIndex((item) => item.id === "destroy") ?? -1;
    await h.down(destroy);
    expect(h.state().instanceMenu?.items[h.state().instanceMenu?.index ?? -1]?.id).toBe("destroy");

    // A remove finishes and leaves a checkout: "give up a kept checkout…" appears above "destroy…".
    h.reload(instancesSnapshot());

    const menu = h.state().instanceMenu;
    expect(menu?.items[destroy]?.id).toBe("checkouts");
    expect(menu?.items[menu.index]?.id).toBe("destroy");
    await h.enter();
    // Enter still means what was highlighted: the question, not a form whose Enter prunes.
    expect(h.state().mode).toBe("confirm");
    expect(h.state().form).toBeUndefined();
  });

  it("opens the detail view, which leads back to the same instance's actions", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("v");

    expect(h.state().mode).toBe("detail");
    expect(h.state().detail?.instance).toBe("feat-x");
    expect(h.state().detail?.lines[0]?.text).toBe("instance feat-x · 0/2 running · initialised · created 4.0s ago");

    // Live while it is open: what comes up shows as up.
    h.client.push("service.changed", { state: serviceState("api@feat-x", "running") });
    h.clock.advance(DEFAULT_FRAME_MS);
    expect(h.state().detail?.lines[0]?.text).toContain("1/2 running");

    await h.press("i");
    expect(h.state().mode).toBe("instance");
    expect(h.state().instanceMenu?.instance).toBe("feat-x");

    await h.escape();
    expect(h.state().mode).toBe("list");
  });
});

describe("creating an instance", () => {
  it("asks for a name, a branch and the apps, and sends exactly that", async () => {
    const h = setup(fixtureSnapshot());
    await h.press("i");
    await h.press("n");

    expect(h.state().mode).toBe("form");
    expect(h.state().form?.fields.map((field) => [field.kind, field.key, field.kind === "check" ? field.checked : field.value])).toEqual([
      ["text", "name", ""],
      ["text", "branch", ""],
      ["text", "from", ""],
      // What `u8 instance create` takes with no targets: the active profile.
      ["check", "api", true],
      ["check", "platform.web", true],
      ["check", "platform.admin", true],
    ]);

    await h.type("feat-y");
    await h.down();
    await h.type("agent/feat-y");
    await h.down(4);
    await h.press(" ");
    await h.enter();

    expect(h.client.paramsOf("instance.create")).toEqual([
      { name: "feat-y", targets: ["api", "platform.web"], branch: "agent/feat-y", from: undefined },
    ]);
    // It answers once git has made the worktrees: no deadline applies.
    expect(h.client.optsOf("instance.create")).toEqual([{ timeoutMs: 0 }]);
    expect(h.state().mode).toBe("list");
    expect(h.state().activity).toEqual(["feat-y: creating — instance:init"]);
    expect(h.client.optsOf("run.await")).toEqual([{ timeoutMs: 0 }]);
  });

  it("lands on the new instance, draws its init inline, and ends with where it listens", async () => {
    const h = setup(fixtureSnapshot());
    await h.press("i");
    await h.press("n");
    await h.type("feat-y");
    await h.enter();

    const created = instancePart("feat-y", [copyOf(app("api"), "feat-y", { ports: { http: 20100 } })], { initialized: false });
    h.reload(withInstances(fixtureSnapshot(), created));
    expect(h.state().rows[h.state().cursor]?.id).toBe("instance:feat-y");

    h.client.push("task.progress", {
      progress: { runId: "run-1", command: "instance:init", targetId: "api@feat-y", state: "running" },
    });
    h.clock.advance(DEFAULT_FRAME_MS);
    expect(h.state().progress).toEqual({ "api@feat-y": "running" });
    expect(h.state().rows[h.state().cursor]?.text).toBe("▾ feat-y  0/1 running · … instance:init · not initialised");

    const ready = instancePart("feat-y", [copyOf(app("api"), "feat-y", { ports: { http: 20100 } })]);
    h.client.setSnapshot(withInstances(fixtureSnapshot(), ready));
    await h.finish((runId) => taskResult(runId, "instance:init", ["api@feat-y"]));

    expect(h.state().mode).toBe("report");
    expect(h.state().report).toMatchObject({ title: "feat-y · create", ok: true, actions: [] });
    expect(h.report()).toEqual([
      "instance feat-y created and initialised",
      "  api@feat-y  http  http://localhost:20100",
      "nothing is running yet — start it from its menu (i u), or with S on its section",
    ]);
    expect(h.state().activity).toEqual([]);

    await h.enter();
    expect(h.state().mode).toBe("list");
    expect(h.state().rows[h.state().cursor]?.id).toBe("instance:feat-y");
  });

  it("shows the daemon's refusal in full and keeps what was typed", async () => {
    const h = setup();
    await h.press("i");
    await h.press("n");
    await h.type("feat-x");
    h.client.failOnce("instance.create", new U8Error("INSTANCE_EXISTS", 'instance "feat-x" already exists'));
    await h.enter();

    expect(h.state().mode).toBe("form");
    expect(h.state().form).toMatchObject({ error: 'instance "feat-x" already exists', submitting: false });
    expect(h.state().form?.fields[0]).toMatchObject({ key: "name", value: "feat-x" });
    expect(h.state().activity).toEqual([]);

    // One correction, not a second trip through the form.
    await h.press("", { backspace: true });
    await h.type("z");
    await h.enter();
    expect(h.client.paramsOf("instance.create").map((params) => (params as { name: string }).name)).toEqual(["feat-x", "feat-z"]);
    expect(h.state().mode).toBe("list");
  });

  it("does not send a form with no name or no apps", async () => {
    const h = setup(fixtureSnapshot());
    await h.press("i");
    await h.press("n");
    await h.enter();
    expect(h.state().form?.error).toBe("give the instance a name");

    await h.type("feat-y");
    await h.down(3);
    for (let i = 0; i < 3; i++) {
      await h.press(" ");
      await h.down();
    }
    await h.enter();
    expect(h.state().form?.error).toBe("tick at least one app for it to run");
    expect(h.mutations()).toEqual([]);

    await h.escape();
    expect(h.state().mode).toBe("list");
    expect(h.mutations()).toEqual([]);
  });

  it("reports a failed init step with its reason and the end of its log", async () => {
    const h = setup(fixtureSnapshot());
    await h.press("i");
    await h.press("n");
    await h.type("feat-y");
    await h.enter();
    const created = instancePart("feat-y", [copyOf(app("api"), "feat-y"), copyOf(app("platform", "web"), "feat-y")], { initialized: false });
    h.reload(withInstances(fixtureSnapshot(), created));
    h.client.lines.push(logLine("api@feat-y", "\u001B[31mnpm ERR! missing script: build\u001B[0m"), logLine("api@feat-y", "exit 1"));

    await h.finish((runId) =>
      taskResult(
        runId,
        "instance:init",
        [
          { targetId: "api@feat-y", state: "failed", exitCode: 1, durationMs: 9 },
          { targetId: "platform.web@feat-y", state: "ok", durationMs: 9 },
        ],
        false,
      ),
    );

    expect(h.state().report).toMatchObject({ title: "feat-y · create — init failed", ok: false });
    expect(h.report()).toEqual([
      "instance feat-y was created, but its init steps did not finish",
      "✗ api@feat-y failed — exit 1",
      "",
      "── api@feat-y: last 2 lines ──",
      // The step's own colours are not this panel's.
      "npm ERR! missing script: build",
      "exit 1",
      "",
      "instance feat-y reads not initialised until its init steps have been through — fix the step, then run init again from its menu (i i)",
    ]);
    // An init step's output is in the run's log, not the service's.
    expect(h.client.paramsOf("logs.read")).toEqual([{ targetId: "api@feat-y", lines: 30, runId: "run-1" }]);
  });
});

describe("a worktree with no instance", () => {
  it("offers to make one from it, and brings it up the way `u8 up` does", async () => {
    const h = setup(fixtureSnapshot(), { worktree: "/agents/fix login" });
    await h.press("i");
    expect(h.state().instanceMenu?.items.at(-1)).toMatchObject({ id: "adopt", key: "w", hint: "/agents/fix login" });

    await h.press("w");
    expect(h.state().form).toMatchObject({ kind: "adopt", title: "new instance from this worktree" });
    expect(h.state().form?.fields[0]).toMatchObject({ key: "name", value: "fix-login" });
    await h.enter();

    // No targets: which repos a worktree holds is the daemon's to work out.
    expect(h.client.paramsOf("instance.create")).toEqual([{ name: "fix-login", adopt: ["/agents/fix login"], targets: undefined }]);

    const made = instancePart("fix-login", [copyOf(app("api"), "fix-login", { ports: { http: 20200 } })], {
      checkouts: { "api@fix-login": { path: "/agents/fix login/api", owned: false } },
    });
    h.reload(withInstances(fixtureSnapshot(), made));
    expect(h.state().worktree).toBeUndefined();

    await h.finish((runId) => taskResult(runId, "instance:init", ["api@fix-login"]));
    expect(h.client.paramsOf("service.start")).toEqual([{ instance: "fix-login", wait: true }]);
    expect(h.state().activity).toEqual(["fix-login: creating from this worktree — app:start — waiting until ready"]);

    await h.finish((runId) => taskResult(runId, "app:start", ["api@fix-login"]));
    expect(h.state().report).toMatchObject({ title: "fix-login · create and start", ok: true });
    expect(h.report()).toEqual([
      "instance fix-login created and initialised",
      "instance fix-login is up: 1 app ready",
      "  api@fix-login  http  http://localhost:20200",
    ]);
  });
});

describe("up and init", () => {
  it("runs init first when the instance has not been through it, then starts and waits", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featX({ initialized: false })));
    await h.menuOn("instance:feat-x");
    await h.press("u");

    expect(h.client.paramsOf("instance.init")).toEqual([{ name: "feat-x" }]);
    expect(h.client.paramsOf("service.start")).toEqual([]);
    expect(h.state().activity).toEqual(["feat-x: up — instance:init"]);

    await h.finish((runId) => taskResult(runId, "instance:init", ["api@feat-x", "platform.web@feat-x"]));
    expect(h.client.paramsOf("service.start")).toEqual([{ instance: "feat-x", wait: true }]);

    await h.finish((runId) => taskResult(runId, "app:start", ["api@feat-x", "platform.web@feat-x"]));
    expect(h.state().report).toMatchObject({ title: "feat-x · up", ok: true });
    expect(h.report()).toEqual([
      "instance feat-x is up: 2 apps ready",
      "  api@feat-x           http  http://localhost:20001",
      "  platform.web@feat-x  http  http://localhost:20002",
      // Up does not start base: it says what the instance leans on there instead.
      'instance "feat-x" uses platform.admin from another instance, and it is not running — start it from its own section (s on the row)',
    ]);
  });

  it("skips init for an instance that is ready, and stops at an init that fails", async () => {
    const ready = setup();
    await ready.menuOn("instance:agent-2");
    await ready.press("u");
    expect(ready.client.paramsOf("instance.init")).toEqual([]);
    expect(ready.client.paramsOf("service.start")).toEqual([{ instance: "agent-2", wait: true }]);

    const broken = setup(withInstances(fixtureSnapshot(), featX({ initialized: false })));
    await broken.menuOn("instance:feat-x");
    await broken.press("u");
    await broken.finish((runId) =>
      taskResult(runId, "instance:init", [{ targetId: "api@feat-x", state: "failed", exitCode: 2, durationMs: 1 }], false),
    );

    expect(broken.client.paramsOf("service.start")).toEqual([]);
    expect(broken.state().report).toMatchObject({ title: "feat-x · up — init failed", ok: false });
    expect(broken.report()[0]).toBe("✗ api@feat-x failed — exit 2");
  });

  it("reads a start that failed from the service log", async () => {
    const h = setup();
    await h.menuOn("instance:agent-2");
    await h.press("u");
    h.client.lines.push(logLine("api@agent-2", "Error: listen EADDRINUSE :::20010"));

    await h.finish((runId) =>
      taskResult(runId, "app:start", [{ targetId: "api@agent-2", state: "failed", error: "exited with code 1 before it was ready", durationMs: 1 }], false),
    );

    expect(h.state().report).toMatchObject({ title: "agent-2 · up — failed", ok: false });
    expect(h.report()).toEqual([
      "instance agent-2 did not come up",
      "✗ api@agent-2 failed — exited with code 1 before it was ready",
      "",
      "── api@agent-2: last 1 line ──",
      "Error: listen EADDRINUSE :::20010",
    ]);
    expect(h.client.paramsOf("logs.read")).toEqual([{ targetId: "api@agent-2", lines: 30, runId: undefined }]);
  });

  it("shows a start the daemon will not take as a refusal, not as an action it lost track of", async () => {
    const stopping = "the daemon is shutting down — service.start was refused";
    const ready = setup();
    ready.client.failOnce("service.start", new U8Error("PROCESS_FAILED", stopping));
    await ready.menuOn("instance:agent-2");
    await ready.press("u");

    expect(ready.state().report).toMatchObject({ title: "agent-2 · up — refused", ok: false });
    expect(ready.report()).toEqual([stopping]);
    expect(ready.state().activity).toEqual([]);

    // The same after an init that went through: the start is the second request there.
    const fresh = setup(withInstances(fixtureSnapshot(), featX({ initialized: false })));
    await fresh.menuOn("instance:feat-x");
    await fresh.press("u");
    fresh.client.failOnce("service.start", new U8Error("PROCESS_FAILED", stopping));
    await fresh.finish((runId) => taskResult(runId, "instance:init", ["api@feat-x", "platform.web@feat-x"]));

    expect(fresh.state().report).toMatchObject({ title: "feat-x · up — refused", ok: false });
    expect(fresh.report()).toEqual([stopping]);
  });

  it("says the outcome is unknown only when the daemon was not there to answer", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featX({ initialized: false })));
    await h.menuOn("instance:feat-x");
    await h.press("u");
    h.client.failOnce("service.start", new U8Error("DAEMON_UNREACHABLE", "connection closed before service.start completed"));
    await h.finish((runId) => taskResult(runId, "instance:init", ["api@feat-x", "platform.web@feat-x"]));

    expect(h.state().report?.title).toBe("feat-x · up — outcome unknown");
  });

  it("re-runs the init steps and says when they are through", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("i");

    expect(h.client.paramsOf("instance.init")).toEqual([{ name: "agent-2" }]);
    await h.finish((runId) => taskResult(runId, "instance:init", ["api@agent-2"]));
    expect(h.state().report).toMatchObject({ title: "agent-2 · init", ok: true });
    expect(h.report()).toEqual(["instance agent-2 is initialised"]);
  });

  it("starts base's profile and waits, without an init of its own", async () => {
    const h = setup();
    await h.press("i");
    await h.press("u");

    expect(h.client.paramsOf("service.start")).toEqual([{ instance: "base", wait: true }]);
    expect(h.mutations()).toEqual([]);
  });
});

describe("adding apps", () => {
  it("offers only what the instance does not run, and sends what was ticked", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("a");

    expect(h.state().form?.title).toBe("add apps to feat-x");
    expect(h.state().form?.fields.map((field) => field.key)).toEqual(["platform.admin", "branch", "from"]);

    await h.enter();
    expect(h.state().form?.error).toBe("tick at least one app to add");
    expect(h.mutations()).toEqual([]);

    await h.press(" ");
    await h.enter();
    expect(h.client.paramsOf("instance.add")).toEqual([
      { name: "feat-x", targets: ["platform.admin"], branch: undefined, from: undefined },
    ]);
    expect(h.client.optsOf("instance.add")).toEqual([{ timeoutMs: 0 }]);
    expect(h.state().activity).toEqual(["feat-x: adding platform.admin — instance:init"]);
  });

  it("names the neighbours that went stale, and restarts them when asked", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featX({ status: { "platform.web@feat-x": "running" } }), agent2()));
    await h.menuOn("api@feat-x");
    await h.press("a");
    await h.press(" ");
    await h.enter();

    // feat-x has its own admin now: its running web still points at base's.
    h.client.setSnapshot(
      withInstances(
        fixtureSnapshot(),
        featXWith(["api", "platform.web", "platform.admin"], { status: { "platform.web@feat-x": "running" }, stale: ["platform.web@feat-x"] }),
        agent2(),
      ),
    );
    await h.finish((runId) => taskResult(runId, "instance:init", ["platform.admin@feat-x"]));

    expect(h.state().report).toMatchObject({
      title: "feat-x · add platform.admin",
      ok: true,
      actions: [{ key: "r", label: "restart it now" }],
    });
    expect(h.report()).toEqual([
      "added platform.admin to instance feat-x",
      "  platform.admin@feat-x  http  http://localhost:20003",
      "not started yet — s on the new rows starts them",
      "platform.web@feat-x is now stale: it is still running with what it pointed at before this change — restart to pick it up: r here restarts it, or R on the instance's section",
      // Its web depends on its own admin now, which is not started yet — but that is not base's.
    ]);

    await h.press("r");
    expect(h.client.paramsOf("service.restart")).toEqual([{ targets: ["platform.web@feat-x"], instance: "feat-x" }]);
    expect(h.state().mode).toBe("list");
  });

  it("restarts the instance the result is about, not the one the cursor has moved to since", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featX({ status: { "platform.web@feat-x": "running" } }), agent2()));
    await h.menuOn("api@feat-x");
    await h.press("a");
    await h.press(" ");
    await h.enter();
    // An add takes a while; the user has gone to look at another instance.
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));

    h.client.setSnapshot(
      withInstances(
        fixtureSnapshot(),
        featXWith(["api", "platform.web", "platform.admin"], { status: { "platform.web@feat-x": "running" }, stale: ["platform.web@feat-x"] }),
        agent2(),
      ),
    );
    await h.finish((runId) => taskResult(runId, "instance:init", ["platform.admin@feat-x"]));
    await h.press("r");

    expect(h.client.paramsOf("service.restart")).toEqual([{ targets: ["platform.web@feat-x"], instance: "feat-x" }]);
  });

  it("says so when an added app leaves the instance leaning on a base app that is down", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featXWith(["api"])));
    await h.menuOn("api@feat-x");
    await h.press("a");
    // platform.web, whose dependency platform.admin only base has.
    await h.press(" ");
    await h.enter();
    expect(h.client.paramsOf("instance.add")).toMatchObject([{ targets: ["platform.web"] }]);

    h.client.setSnapshot(withInstances(fixtureSnapshot(), featXWith(["api", "platform.web"])));
    await h.finish((runId) => taskResult(runId, "instance:init", ["platform.web@feat-x"]));

    expect(h.report().at(-1)).toBe(
      'instance "feat-x" uses platform.admin from another instance, and it is not running — start it from its own section (s on the row)',
    );
  });

  it("shows why the daemon would not take it, as the daemon worded it", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("a");
    await h.press(" ");
    const busy = 'instance "feat-x" is still busy with an earlier init, add or remove — wait for that run to finish';
    h.client.failOnce("instance.add", new U8Error("INSTANCE_INVALID", busy));
    await h.enter();

    expect(h.state().mode).toBe("form");
    expect(h.state().form?.error).toBe(busy);
  });

  it("says an app joined without finishing init when its step fails", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("a");
    await h.press(" ");
    await h.enter();
    h.client.setSnapshot(withInstances(fixtureSnapshot(), featXWith(["api", "platform.web", "platform.admin"], { initialized: false }), agent2()));

    await h.finish((runId) =>
      taskResult(runId, "instance:init", [{ targetId: "platform.admin@feat-x", state: "failed", exitCode: 1, durationMs: 1 }], false),
    );

    expect(h.state().report).toMatchObject({ title: "feat-x · add platform.admin — init failed", ok: false });
    expect(h.report()).toEqual([
      "✗ platform.admin@feat-x failed — exit 1",
      "",
      'platform.admin joined instance "feat-x" without finishing init — fix the step, then run init again from its menu (i i)',
    ]);
  });
});

describe("removing apps", () => {
  it("starts from the selection, keeps the checkout unless told otherwise, and says what became of it", async () => {
    const h = setup();
    await h.menuOn("platform.web@feat-x");
    await h.press("d");

    expect(h.state().form?.title).toBe("remove apps from feat-x");
    expect(h.state().form?.fields.map((field) => [field.key, field.kind === "check" ? field.checked : field.value])).toEqual([
      ["api", false],
      ["platform.web", true],
      ["checkout", "keep"],
    ]);
    // On the line that was ticked for the user: the one to look at before Enter.
    expect(h.state().form?.index).toBe(1);

    await h.enter();
    expect(h.client.paramsOf("instance.remove")).toEqual([{ name: "feat-x", targets: ["platform.web"], prune: false }]);
    expect(h.client.optsOf("instance.remove")).toEqual([{ timeoutMs: 0 }]);

    // What the daemon leaves: web gone, its checkout still in the record, its repo gone from `repos`.
    h.client.setSnapshot(withInstances(fixtureSnapshot(), featXWith(["api"]), agent2()));
    await h.finish((runId) => taskResult(runId, "instance:teardown", ["platform.web@feat-x"]));

    expect(h.state().report).toMatchObject({ title: "feat-x · remove platform.web", ok: true });
    expect(h.report()).toEqual([
      "removed platform.web from instance feat-x",
      "kept the checkout of platform at /agents/wt-3/platform — bring it back by adding an app of it (i a), or give it up from the menu (i c)",
    ]);
  });

  it("gives the checkout up only when that was chosen", async () => {
    const h = setup();
    await h.menuOn("platform.web@feat-x");
    await h.press("d");
    await h.down();
    await h.press("", { rightArrow: true });
    expect(h.state().form?.fields.at(-1)).toMatchObject({ key: "checkout", value: "prune" });
    await h.enter();

    expect(h.client.paramsOf("instance.remove")).toEqual([{ name: "feat-x", targets: ["platform.web"], prune: true }]);

    const after = featXWith(["api"]);
    delete after.instance.checkouts["platform@feat-x"];
    h.client.setSnapshot(withInstances(fixtureSnapshot(), after, agent2()));
    await h.finish((runId) => taskResult(runId, "instance:teardown", ["platform.web@feat-x"]));

    expect(h.report()).toEqual([
      "removed platform.web from instance feat-x",
      "forgot the checkout at /agents/wt-3/platform (adopted — the directory was not touched)",
    ]);
  });

  it("names who went stale and what the instance now takes from base", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featXWith(["api", "platform.web", "platform.admin"], { status: { "platform.web@feat-x": "running" } })));
    await h.menuOn("platform.admin@feat-x");
    await h.press("d");
    await h.enter();
    expect(h.client.paramsOf("instance.remove")).toMatchObject([{ targets: ["platform.admin"] }]);

    // Its web goes back to base's admin — which is not running — and is still up on the old wiring.
    h.client.setSnapshot(
      withInstances(fixtureSnapshot(), featXWith(["api", "platform.web"], { status: { "platform.web@feat-x": "running" }, stale: ["platform.web@feat-x"] })),
    );
    await h.finish((runId) => taskResult(runId, "instance:teardown", ["platform.admin@feat-x"]));

    expect(h.report()).toEqual([
      "removed platform.admin from instance feat-x",
      "platform.web@feat-x is now stale: it is still running with what it pointed at before this change — restart to pick it up: r here restarts it, or R on the instance's section",
      'instance "feat-x" uses platform.admin from another instance, and it is not running — start it from its own section (s on the row)',
    ]);
    expect(h.state().report?.actions).toEqual([{ key: "r", label: "restart it now" }]);
  });

  it("shows the refusal to empty an instance in the daemon's words, having removed nothing", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("d");
    const refusal =
      'removing "api" would leave instance "agent-2" with no apps — to be rid of the instance, destroy it: u8 instance destroy agent-2';
    h.client.failOnce("instance.remove", new U8Error("INSTANCE_INVALID", refusal));
    await h.enter();

    expect(h.state().mode).toBe("form");
    expect(h.state().form?.error).toBe(refusal);
    expect(h.state().activity).toEqual([]);
  });

  describe("a worktree with uncommitted work", () => {
    const dirty =
      "the worktree at /wt/feat-x/api has uncommitted changes (README.md, src/a.ts and 3 more), so nothing was stopped or removed — " +
      "commit or stash them, leave the checkout in place by dropping --prune, or throw them away with --discard";

    /** Removes feat-x's api with the checkout given up, and has the daemon refuse the prune. */
    async function refusedPrune(): Promise<Harness> {
      const h = setup();
      await h.menuOn("api@feat-x");
      await h.press("d");
      await h.down(2);
      await h.press(" ");
      h.client.failOnce("instance.remove", new U8Error("WORKTREE_FAILED", dirty));
      await h.enter();
      return h;
    }

    it("is never discarded from the form: the refusal comes first, whole, with the way on from it", async () => {
      const h = await refusedPrune();

      expect(h.client.paramsOf("instance.remove")).toEqual([{ name: "feat-x", targets: ["api"], prune: true }]);
      expect(h.state().mode).toBe("report");
      expect(h.state().report).toMatchObject({
        title: "feat-x · remove api — refused",
        ok: false,
        actions: [{ key: "D", label: "discard the uncommitted changes and remove the worktree…" }],
      });
      expect(h.report()).toEqual([dirty]);
    });

    it("asks for the instance's name before discarding, and cancel sends nothing", async () => {
      const h = await refusedPrune();
      await h.press("D");

      expect(h.state().mode).toBe("confirm");
      expect(h.state().confirm).toMatchObject({ title: "discard uncommitted changes — feat-x", expect: "feat-x", typed: "" });
      // What would be lost is still on screen while the name is typed.
      expect(h.state().confirm?.lines.map((line) => line.text)).toEqual([
        dirty,
        "",
        "removes the worktree api leaves behind with everything uncommitted in it; git is not asked again, and nothing brings it back",
      ]);

      await h.enter();
      await h.type("feat");
      await h.enter();
      expect(h.state().mode).toBe("confirm");
      expect(h.state().notice).toEqual({ text: "type feat-x exactly to discard and remove — esc cancels", tone: "warn" });

      await h.escape();
      // Back on the refusal, with nothing more sent.
      expect(h.state().mode).toBe("report");
      expect(h.client.paramsOf("instance.remove")).toHaveLength(1);
    });

    it("discards once the name has been typed", async () => {
      const h = await refusedPrune();
      await h.press("D");
      await h.type("feat-x");
      await h.enter();

      expect(h.client.paramsOf("instance.remove")).toEqual([
        { name: "feat-x", targets: ["api"], prune: true },
        { name: "feat-x", targets: ["api"], prune: true, discard: true },
      ]);
      expect(h.state().mode).toBe("list");

      const after = featXWith(["platform.web"]);
      delete after.instance.checkouts["api@feat-x"];
      h.client.setSnapshot(withInstances(fixtureSnapshot(), after, agent2()));
      await h.finish((runId) => taskResult(runId, "instance:teardown", ["api@feat-x"]));
      expect(h.report()).toEqual([
        "removed api from instance feat-x",
        "removed the worktree at /wt/feat-x/api",
        // What is left of feat-x is its web, which still leans on base's admin.
        'instance "feat-x" uses platform.admin from another instance, and it is not running — start it from its own section (s on the row)',
      ]);
    });

    it("asks for the name again before forcing a discard whose teardown failed", async () => {
      const h = await refusedPrune();
      await h.press("D");
      await h.type("feat-x");
      await h.enter();
      const kept = 'teardown failed, so "api" stayed in instance "feat-x" — fix the step and remove again, or force it';
      await h.finish((runId) =>
        taskResult(runId, "instance:teardown", [{ targetId: "api@feat-x", state: "failed", error: kept, durationMs: 1 }], false),
      );
      expect(h.state().report?.actions).toEqual([{ key: "F", label: "remove api anyway (force)…" }]);

      await h.press("F");
      // The request being forced still discards — the worktree as it is by now,
      // which may hold more than when the name was typed. It is typed again.
      expect(h.state().confirm).toMatchObject({ expect: "feat-x", verb: "force the removal" });
      expect(h.state().confirm?.lines.map((line) => [line.tone, line.text])).toEqual([
        ["warn", "drops the apps from the instance anyway: whatever the failed step was meant to undo stays as it is"],
        [
          "error",
          "and removes the worktree api leaves behind with everything uncommitted in it — as it is now, not as it was when this was first asked",
        ],
      ]);

      await h.press("y");
      await h.enter();
      expect(h.client.paramsOf("instance.remove")).toHaveLength(2);
      await h.press("", { backspace: true });

      await h.type("feat-x");
      await h.enter();
      expect(h.client.paramsOf("instance.remove").at(-1)).toEqual({
        name: "feat-x",
        targets: ["api"],
        prune: true,
        discard: true,
        force: true,
      });
    });

    it("offers no discard for a refusal that is about something else", async () => {
      const h = setup();
      await h.menuOn("api@feat-x");
      await h.press("d");
      await h.down(2);
      await h.press(" ");
      h.client.failOnce("instance.remove", new U8Error("INSTANCE_INVALID", 'instance "feat-x" is being destroyed'));
      await h.enter();

      expect(h.state().mode).toBe("form");
      expect(h.state().form?.error).toBe('instance "feat-x" is being destroyed');
    });
  });

  it("offers to force a removal whose teardown failed, behind a y that Enter does not give", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("d");
    await h.enter();
    const kept = 'teardown failed, so "api" stayed in instance "feat-x" — fix the step and remove again, or force it';
    h.client.lines.push(logLine("api@feat-x", "dropdb: database is being accessed by other users"));

    // Nothing left the instance: the snapshot is what it was.
    await h.finish((runId) =>
      taskResult(runId, "instance:teardown", [{ targetId: "api@feat-x", state: "failed", error: kept, durationMs: 1 }], false),
    );

    expect(h.state().report).toMatchObject({
      title: "feat-x · remove api — failed",
      ok: false,
      actions: [{ key: "F", label: "remove api anyway (force)…" }],
    });
    expect(h.report()).toEqual([
      `✗ api@feat-x failed — ${kept}`,
      "",
      "── api@feat-x: last 1 line ──",
      "dropdb: database is being accessed by other users",
      "",
    ]);

    await h.press("F");
    expect(h.state().confirm?.title).toBe("remove api from feat-x although teardown failed");
    // A y question: there is nothing to type, and nothing Enter can agree to.
    expect(h.state().confirm?.expect).toBeUndefined();
    await h.enter();
    expect(h.state().mode).toBe("confirm");
    await h.press("n");
    expect(h.state().mode).toBe("report");
    expect(h.client.paramsOf("instance.remove")).toHaveLength(1);

    // The result names feat-x, and so does the force — whatever the cursor is on by now.
    h.controller.dismissReport();
    h.controller.setCursor(h.state().rows.findIndex((row) => row.id === "api@agent-2"));
    await h.press("i");
    await h.press("o");
    await h.press("F");
    await h.press("y");
    expect(h.client.paramsOf("instance.remove")).toEqual([
      { name: "feat-x", targets: ["api"], prune: false },
      { name: "feat-x", targets: ["api"], prune: false, force: true },
    ]);
  });

  it("says a forced removal gives the checkout up too, when the removal it repeats did", async () => {
    const h = setup();
    await h.menuOn("api@feat-x");
    await h.press("d");
    await h.down(2);
    await h.press(" ");
    await h.enter();
    await h.finish((runId) =>
      taskResult(runId, "instance:teardown", [{ targetId: "api@feat-x", state: "failed", error: "teardown failed", durationMs: 1 }], false),
    );

    await h.press("F");
    expect(h.state().confirm?.expect).toBeUndefined();
    expect(h.state().confirm?.lines.map((line) => line.text)).toEqual([
      "drops the apps from the instance anyway: whatever the failed step was meant to undo stays as it is",
      "and gives up the checkout of a repo left with no apps: a worktree u8 created is removed if git reports it clean",
    ]);
    await h.press("y");
    expect(h.client.paramsOf("instance.remove").at(-1)).toEqual({ name: "feat-x", targets: ["api"], prune: true, force: true });
  });

  it("does not let a refusal that arrives late close whatever has been opened since", async () => {
    const h = setup();
    const dirty = "the worktree at /wt/feat-x/api has uncommitted changes (README.md), so nothing was stopped or removed";
    let refuse: (err: Error) => void = () => undefined;
    // The daemon has one queue for instance changes: this one sits behind somebody else's.
    h.client.answer("instance.remove", () => new Promise((_resolve, reject) => (refuse = reject)) as never);
    await h.menuOn("api@feat-x");
    await h.press("d");
    await h.down(2);
    await h.press(" ");
    await h.enter();
    expect(h.state().form?.submitting).toBe(true);

    // Not waiting for it: out of the form, and into the question before a destroy.
    await h.escape();
    await h.menuOn("api@agent-2");
    await h.press("D");
    await h.type("agent");
    expect(h.state().confirm).toMatchObject({ title: "destroy instance agent-2", typed: "agent" });

    refuse(new U8Error("WORKTREE_FAILED", dirty));
    await settle();
    h.clock.advance(DEFAULT_FRAME_MS);

    // The question is still there, with what was typed into it; the refusal waits its turn.
    expect(h.state().mode).toBe("confirm");
    expect(h.state().confirm).toMatchObject({ title: "destroy instance agent-2", typed: "agent" });
    expect(h.state().report).toBeUndefined();
    expect(h.state().notice?.text).toBe("feat-x · remove api — refused — the result opens when you are back on the list");

    await h.escape();
    expect(h.state().mode).toBe("report");
    expect(h.report()).toEqual([dirty]);
    expect(h.state().report?.actions).toEqual([{ key: "D", label: "discard the uncommitted changes and remove the worktree…" }]);
    expect(h.client.paramsOf("instance.destroy")).toEqual([]);
  });

  it("reports an ordinary refusal that arrives after its form was escaped", async () => {
    const h = setup();
    let refuse: (err: Error) => void = () => undefined;
    h.client.answer("instance.remove", () => new Promise((_resolve, reject) => (refuse = reject)) as never);
    await h.menuOn("api@agent-2");
    await h.press("d");
    await h.enter();
    await h.escape();
    await h.press(":");

    refuse(new U8Error("INSTANCE_INVALID", 'removing "api" would leave instance "agent-2" with no apps'));
    await settle();
    h.clock.advance(DEFAULT_FRAME_MS);

    // Neither lost with the form nor drawn over the palette.
    expect(h.state().mode).toBe("palette");
    expect(h.state().palette).toBeDefined();
    await h.escape();
    expect(h.state().report).toMatchObject({ title: "remove apps from agent-2 — refused", ok: false });
    expect(h.report()).toEqual(['removing "api" would leave instance "agent-2" with no apps']);
  });

  it("will not give up a checkout that got its apps back while the form was open", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("c");
    await h.press(" ");

    // Somebody adds an app of infra back: for the daemon, "infra" now names
    // apps to stop and remove, which is not what this form says.
    const back = featX();
    back.repos.push({
      name: "infra@feat-x",
      baseName: "infra",
      instance: "feat-x",
      path: "/wt/feat-x/infra",
      apps: [copyOf(app("infra"), "feat-x")],
    });
    back.instance.appIds.push("infra@feat-x");
    h.reload(withInstances(fixtureSnapshot(), back, agent2()));
    await h.enter();

    expect(h.state().form?.error).toBe(
      "infra is no longer a checkout without apps — feat-x runs from it again. Close this and look again.",
    );
    expect(h.mutations()).toEqual([]);
  });

  it("gives up a checkout an earlier remove kept", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("c");

    expect(h.state().form?.title).toBe("give up checkouts feat-x kept");
    // Not ticked for the user, though it is the only one: this Enter removes a worktree.
    expect(h.state().form?.fields).toEqual([
      { kind: "check", key: "infra", label: "infra", checked: false, note: "/wt/feat-x/infra" },
    ]);
    await h.enter();
    expect(h.state().form?.error).toBe("tick at least one checkout to give up");
    expect(h.mutations()).toEqual([]);

    await h.press(" ");
    await h.enter();
    expect(h.client.paramsOf("instance.remove")).toEqual([{ name: "feat-x", targets: ["infra"], prune: true }]);

    const after = featX();
    delete after.instance.checkouts["infra@feat-x"];
    h.client.setSnapshot(withInstances(fixtureSnapshot(), after, agent2()));
    await h.finish((runId) => taskResult(runId, "instance:teardown", []));
    expect(h.state().report).toMatchObject({ title: "feat-x · remove", ok: true });
    expect(h.report()).toEqual(["removed the worktree at /wt/feat-x/infra"]);
  });
});

describe("destroying an instance", () => {
  it("says what it removes and takes the instance's name, typed, for an answer", async () => {
    const h = setup(withInstances(fixtureSnapshot(), featX({ status: { "api@feat-x": "running" } }), agent2()));
    await h.menuOn("api@feat-x");
    await h.press("D");

    expect(h.state().mode).toBe("confirm");
    expect(h.state().confirm).toMatchObject({ title: "destroy instance feat-x", expect: "feat-x", verb: "destroy it" });
    expect(h.state().confirm?.lines.map((line) => line.text)).toEqual([
      "stops 1 running app, runs the teardown steps and frees its ports",
      "removes 2 worktrees u8 created, with whatever is uncommitted in them:",
      "  /wt/feat-x/api",
      "  /wt/feat-x/infra",
      "forgets 1 adopted checkout — the directory is not touched:",
      "  /agents/wt-3/platform",
    ]);

    // Enter on its own, the wrong name, and a y: none of them is the answer.
    await h.enter();
    await h.press("y");
    await h.enter();
    expect(h.state().confirm?.typed).toBe("y");
    await h.press("", { backspace: true });
    await h.type("feat-");
    await h.enter();
    expect(h.state().mode).toBe("confirm");
    expect(h.mutations()).toEqual([]);

    await h.type("x");
    await h.enter();
    expect(h.client.paramsOf("instance.destroy")).toEqual([{ name: "feat-x", force: undefined }]);
    expect(h.state().mode).toBe("list");
    expect(h.state().activity).toEqual(["feat-x: destroying — instance:teardown"]);
  });

  it("lists what is there when it is answered, not when it was asked", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("D");
    expect(h.state().confirm?.lines.map((line) => line.text)).toContain("  /wt/feat-x/infra");

    // The kept checkout is given up elsewhere while the question is open.
    const after = featX();
    delete after.instance.checkouts["infra@feat-x"];
    h.reload(withInstances(fixtureSnapshot(), after, agent2()));

    expect(h.state().mode).toBe("confirm");
    expect(h.state().confirm?.lines.map((line) => line.text)).toEqual([
      "stops 0 running apps, runs the teardown steps and frees its ports",
      "removes 1 worktree u8 created, with whatever is uncommitted in it:",
      "  /wt/feat-x/api",
      "forgets 1 adopted checkout — the directory is not touched:",
      "  /agents/wt-3/platform",
    ]);
  });

  it("sends nothing when the question is escaped", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("D");
    await h.type("feat-x");
    await h.escape();

    expect(h.state().mode).toBe("list");
    expect(h.state().confirm).toBeUndefined();
    expect(h.mutations()).toEqual([]);
  });

  it("reports what was removed and what was only forgotten, and leaves the cursor on a heading", async () => {
    const h = setup();
    await h.menuOn("platform.web@feat-x");
    await h.press("D");
    await h.type("feat-x");
    await h.enter();

    h.reload(withInstances(fixtureSnapshot(), agent2()));
    await h.finish((runId) => taskResult(runId, "instance:teardown", ["api@feat-x", "platform.web@feat-x"]));

    expect(h.state().report).toMatchObject({ title: "feat-x · destroy", ok: true });
    expect(h.report()).toEqual([
      "instance feat-x destroyed",
      "removed the worktree at /wt/feat-x/api",
      "forgot the checkout at /agents/wt-3/platform (adopted — the directory was not touched)",
      "removed the worktree at /wt/feat-x/infra",
    ]);
    await h.enter();
    expect(h.state().rows[h.state().cursor]?.id).toBe("instance:agent-2");
  });

  it("offers to force a destroy whose teardown failed, and asks for the name again", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("D");
    await h.type("feat-x");
    await h.enter();
    const kept = 'teardown failed, so instance "feat-x" was kept — fix the step and destroy it again, or force it';

    await h.finish((runId) =>
      taskResult(
        runId,
        "instance:teardown",
        [
          { targetId: "api@feat-x", state: "failed", exitCode: 1, durationMs: 1 },
          { targetId: "platform.web@feat-x", state: "failed", error: kept, durationMs: 1 },
        ],
        false,
      ),
    );

    expect(h.state().report).toMatchObject({
      title: "feat-x · destroy — failed",
      ok: false,
      actions: [{ key: "F", label: "destroy feat-x anyway (force)…" }],
    });
    expect(h.report().slice(0, 2)).toEqual(["✗ api@feat-x failed — exit 1", `✗ platform.web@feat-x failed — ${kept}`]);

    await h.press("F");
    expect(h.state().confirm).toMatchObject({ title: "destroy instance feat-x although teardown failed", expect: "feat-x" });
    await h.type("feat-x");
    await h.enter();
    expect(h.client.paramsOf("instance.destroy")).toEqual([
      { name: "feat-x", force: undefined },
      { name: "feat-x", force: true },
    ]);
  });

  it("shows a destroy the daemon would not start", async () => {
    const h = setup();
    await h.menuOn("instance:feat-x");
    await h.press("D");
    await h.type("feat-x");
    h.client.failOnce("instance.destroy", new U8Error("INSTANCE_INVALID", 'instance "feat-x" is already being destroyed'));
    await h.enter();

    expect(h.state().report).toMatchObject({ title: "feat-x · destroy — refused", ok: false });
    expect(h.report()).toEqual(['instance "feat-x" is already being destroyed']);
  });
});

describe("results", () => {
  it("waits behind whatever is open, and is the next thing on screen", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("i");
    await h.press(":");
    expect(h.state().mode).toBe("palette");

    await h.finish((runId) => taskResult(runId, "instance:init", ["api@agent-2"]));

    // Not over a palette the user is typing in.
    expect(h.state().mode).toBe("palette");
    expect(h.state().report).toBeUndefined();
    expect(h.state().notice?.text).toBe("agent-2 · init — the result opens when you are back on the list");

    await h.escape();
    expect(h.state().mode).toBe("report");
    expect(h.report()).toEqual(["instance agent-2 is initialised"]);
  });

  it("queues, and says how many more there are", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("i");
    await h.menuOn("api@feat-x");
    await h.press("i");

    await h.finish((runId) => taskResult(runId, "instance:init", ["api@agent-2"]));
    await h.finish((runId) => taskResult(runId, "instance:init", ["api@feat-x", "platform.web@feat-x"]));

    expect(h.state().report).toMatchObject({ title: "agent-2 · init", waiting: 1 });
    await h.enter();
    expect(h.state().report).toMatchObject({ title: "feat-x · init", waiting: 0 });
    await h.enter();
    expect(h.state().mode).toBe("list");
  });

  it("keeps the last one reachable after a key that closed it unread", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("i");
    await h.finish((runId) => taskResult(runId, "instance:init", ["api@agent-2"]));
    await h.enter();
    expect(h.state().mode).toBe("list");

    await h.press("i");
    expect(h.state().instanceMenu?.items.at(-1)).toMatchObject({ id: "result", key: "o", hint: "agent-2 · init" });
    await h.press("o");

    expect(h.state().mode).toBe("report");
    expect(h.report()).toEqual(["instance agent-2 is initialised"]);
  });

  it("scrolls a result longer than the screen, and no further than its end", async () => {
    const h = setup();
    h.controller.setViewport(6);
    await h.menuOn("api@agent-2");
    await h.press("i");
    for (let i = 0; i < 20; i++) h.client.lines.push(logLine("api@agent-2", `line ${i}`));
    await h.finish((runId) =>
      taskResult(runId, "instance:init", [{ targetId: "api@agent-2", state: "failed", exitCode: 1, durationMs: 1 }], false),
    );

    const total = h.state().report?.lines.length ?? 0;
    expect(total).toBeGreaterThan(20);
    // One line of the body is the title; the rest is the window.
    const window = 5;
    for (let i = 0; i < 100; i++) h.controller.reportScroll(1);
    expect(h.state().report?.top).toBe(total - window);
    h.controller.reportScroll(-1);
    expect(h.state().report?.top).toBe(total - window - 1);
    h.controller.reportTop();
    expect(h.state().report?.top).toBe(0);
    h.controller.reportBottom();
    expect(h.state().report?.top).toBe(total - window);
  });

  it("counts every line of a refusal that is already several, so all of it can be reached", async () => {
    const h = setup();
    h.controller.setViewport(3);
    const git = 'could not create a worktree for "api": Preparing worktree (checking out \'main\')\nfatal: \'main\' is already checked out at \'/ws/api\'\nhint: use --force';
    h.client.failOnce("instance.destroy", new U8Error("WORKTREE_FAILED", git));
    await h.menuOn("instance:feat-x");
    await h.press("D");
    await h.type("feat-x");
    await h.enter();

    expect(h.report()).toEqual(git.split("\n"));
    // Two rows of window under the title: the last line is one scroll away, and reachable.
    h.controller.reportBottom();
    expect(h.state().report?.top).toBe(1);
  });

  it("reports an action whose run it lost track of, instead of leaving it in flight for ever", async () => {
    const h = setup();
    h.client.fail("run.await", new U8Error("DAEMON_UNREACHABLE", "connection closed before run.await completed"));
    await h.menuOn("api@agent-2");
    await h.press("i");
    await settle();

    expect(h.state().activity).toEqual([]);
    expect(h.state().report).toMatchObject({ title: "agent-2 · init — outcome unknown", ok: false });
    expect(h.report()).toEqual([
      "connection closed before run.await completed",
      "the dashboard lost track of this action before it finished; the list shows the instance as it is now",
    ]);
  });
});

describe("teardown with an action in flight", () => {
  it("reports nothing and arms nothing once the dashboard has closed", async () => {
    const h = setup();
    await h.menuOn("api@agent-2");
    await h.press("i");
    expect(h.state().activity).toEqual(["agent-2: init — instance:init"]);

    await h.controller.dispose();
    expect(h.clock.pending).toBe(0);
    const asked = h.client.calls.length;

    h.client.finish(taskResult("run-1", "instance:init", [{ targetId: "api@agent-2", state: "failed", durationMs: 1 }], false));
    await settle();

    expect(h.clock.pending).toBe(0);
    expect(h.client.listenerCount()).toBe(0);
    // The run's end is nobody's news any more: no snapshot is fetched for a
    // report that will not be shown, and no log is read for it.
    expect(h.client.calls).toHaveLength(asked);
  });
});
