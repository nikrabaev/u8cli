/**
 * The bindings from SPEC §9.1, driven the way Ink drives them: `(input, key)`
 * straight into the controller.
 *
 * The interesting half is what does *not* happen — `s` must not start a service
 * while the log view has the screen, and a key nobody bound must be a no-op
 * rather than an error — so most of these assert on silence.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/ipc/protocol.js";
import { createController, type DashboardController } from "../../src/tui/controller.js";
import type { TuiKey } from "../../src/tui/types.js";
import { createFakeClient, instancesSnapshot, settle, taskResult, testScheduler, type FakeClient } from "./helpers.js";

const live: DashboardController[] = [];

function setup(snapshot?: Snapshot): { client: FakeClient; controller: DashboardController } {
  const client = createFakeClient(snapshot);
  const controller = createController({ client, color: false, scheduler: testScheduler().schedule });
  live.push(controller);
  return { client, controller };
}

/** The id of the row under the cursor. */
function at(controller: DashboardController): string | undefined {
  const state = controller.getState();
  return state.rows[state.cursor]?.id;
}

/** One keypress, as Ink reports it. */
function press(controller: DashboardController, input: string, key: TuiKey = {}): void {
  controller.handleKey(input, key);
}

afterEach(async () => {
  for (const controller of live.splice(0)) await controller.dispose();
});

describe("list mode", () => {
  it("moves the cursor with the arrows and with k/j", () => {
    const { controller } = setup();

    press(controller, "j");
    press(controller, "", { downArrow: true });
    expect(controller.getState().cursor).toBe(2);

    press(controller, "k");
    press(controller, "", { upArrow: true });
    expect(controller.getState().cursor).toBe(0);
  });

  it("pages and jumps to the ends", () => {
    const { controller } = setup();
    controller.setViewport(2);

    press(controller, "G");
    expect(controller.getState().cursor).toBe(3);

    press(controller, "", { pageUp: true });
    expect(controller.getState().cursor).toBe(2);

    press(controller, "g");
    expect(controller.getState().cursor).toBe(0);

    press(controller, "", { end: true });
    expect(controller.getState().cursor).toBe(3);
  });

  it("maps s/x/r to the selection and S/X/R to the profile", async () => {
    const { client, controller } = setup();

    press(controller, "s");
    press(controller, "x");
    press(controller, "r");
    press(controller, "S");
    press(controller, "X");
    press(controller, "R");
    await settle();

    expect(client.paramsOf("service.start")).toEqual([{ targets: ["api"], instance: "base" }, { targets: undefined, instance: "base" }]);
    expect(client.paramsOf("service.stop")).toEqual([{ targets: ["api"], instance: "base" }, { targets: undefined, instance: "base" }]);
    expect(client.paramsOf("service.restart")).toEqual([{ targets: ["api"], instance: "base" }, { targets: undefined, instance: "base" }]);
  });

  it("opens the log view, the palette, the switcher and the help", () => {
    const { controller } = setup();

    press(controller, "", { return: true });
    expect(controller.getState().mode).toBe("logs");

    press(controller, "q");
    expect(controller.getState().mode).toBe("list");

    press(controller, ":");
    expect(controller.getState().mode).toBe("palette");
    press(controller, "", { escape: true });

    press(controller, "p");
    expect(controller.getState().mode).toBe("palette");
    press(controller, "", { escape: true });

    press(controller, "P");
    expect(controller.getState().mode).toBe("profiles");
    press(controller, "", { escape: true });

    press(controller, "?");
    expect(controller.getState().help).toBe(true);
  });

  it("quits on q and on ctrl-c", () => {
    const first = setup();
    press(first.controller, "q");
    expect(first.controller.getState().exited).toBe(true);

    const second = setup();
    press(second.controller, "c", { ctrl: true });
    expect(second.controller.getState().exited).toBe(true);
  });

  it("ignores a chord the dashboard never advertised", async () => {
    const { client, controller } = setup();

    // ctrl-s reaches Ink as a plain `s`; the reflex that saves a file must not
    // start a stack. Same for the alt/option variants.
    press(controller, "s", { ctrl: true });
    press(controller, "x", { ctrl: true });
    press(controller, "r", { meta: true });
    press(controller, "P", { ctrl: true });
    await settle();

    expect(client.calls).toEqual([]);
    expect(controller.getState().mode).toBe("list");
  });

  it("ignores a key nobody bound", async () => {
    const { client, controller } = setup();

    press(controller, "z");
    press(controller, "", { leftArrow: true });
    await settle();

    expect(controller.getState().cursor).toBe(0);
    expect(client.calls).toEqual([]);
  });
});

describe("list mode with instances", () => {
  it("moves between sections with tab and shift-tab", () => {
    const { controller } = setup(instancesSnapshot());

    press(controller, "", { tab: true });
    expect(at(controller)).toBe("instance:feat-x");
    press(controller, "", { tab: true });
    expect(at(controller)).toBe("instance:agent-2");
    press(controller, "", { tab: true, shift: true });
    expect(at(controller)).toBe("instance:feat-x");
  });

  it("folds and unfolds with the arrows and with h/l, and all at once with z", () => {
    const { controller } = setup(instancesSnapshot());
    const count = (): number => controller.getState().rows.length;
    press(controller, "", { tab: true });

    press(controller, "", { leftArrow: true });
    expect(count()).toBe(8);
    press(controller, "", { rightArrow: true });
    expect(count()).toBe(10);
    press(controller, "h");
    expect(count()).toBe(8);
    press(controller, "l");
    expect(count()).toBe(10);

    press(controller, "z");
    expect(count()).toBe(3);
    press(controller, "z");
    expect(count()).toBe(10);
  });

  it("focuses with f and opens the instance menu with i", () => {
    const { controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });

    press(controller, "f");
    expect(controller.getState().focus).toBe("feat-x");
    press(controller, "f");
    expect(controller.getState().focus).toBeUndefined();

    press(controller, "i");
    expect(controller.getState().mode).toBe("instance");
    expect(controller.getState().instanceMenu?.instance).toBe("feat-x");
  });

  it("does not fold on an arrow that came with a modifier", () => {
    const { controller } = setup(instancesSnapshot());

    // Option-left is how a terminal sends "back a word": not this list's key.
    press(controller, "", { leftArrow: true, meta: true });
    press(controller, "i", { ctrl: true });

    expect(controller.getState().rows).toHaveLength(10);
    expect(controller.getState().mode).toBe("list");
  });
});

describe("instance menu mode", () => {
  it("moves with the arrows and j/k, runs with enter, closes with esc and q", () => {
    const { controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "i");

    press(controller, "j");
    press(controller, "", { downArrow: true });
    expect(controller.getState().instanceMenu?.index).toBe(2);
    press(controller, "k");
    press(controller, "", { upArrow: true });
    expect(controller.getState().instanceMenu?.index).toBe(0);

    press(controller, "", { return: true });
    expect(controller.getState().mode).toBe("detail");
    press(controller, "q");
    expect(controller.getState().mode).toBe("list");
    expect(controller.getState().exited).toBe(false);

    press(controller, "i");
    press(controller, "", { escape: true });
    expect(controller.getState().mode).toBe("list");
    press(controller, "i");
    press(controller, "q");
    expect(controller.getState().mode).toBe("list");
    expect(controller.getState().exited).toBe(false);
  });

  it("runs an entry by its letter, and tells d from D", () => {
    const { controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });

    press(controller, "i");
    press(controller, "d");
    expect(controller.getState().mode).toBe("form");
    expect(controller.getState().form?.kind).toBe("remove");
    press(controller, "", { escape: true });

    press(controller, "i");
    press(controller, "D");
    expect(controller.getState().mode).toBe("confirm");
  });

  it("does not run an entry on a chord, or on a letter no entry has", async () => {
    const { client, controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "i");

    press(controller, "D", { ctrl: true });
    press(controller, "u", { meta: true });
    press(controller, "x");
    press(controller, "s");
    await settle();

    expect(controller.getState().mode).toBe("instance");
    expect(client.calls).toEqual([]);
  });
});

describe("detail mode", () => {
  it("scrolls, and leaves the lifecycle keys alone", async () => {
    const { client, controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "i");
    press(controller, "v");
    controller.setViewport(3);

    press(controller, "j");
    press(controller, "", { downArrow: true });
    expect(controller.getState().detail?.top).toBe(2);
    press(controller, "k");
    expect(controller.getState().detail?.top).toBe(1);
    press(controller, "G");
    const bottom = controller.getState().detail?.top ?? 0;
    expect(bottom).toBe((controller.getState().detail?.lines.length ?? 0) - 3);
    press(controller, "", { pageUp: true });
    expect(controller.getState().detail?.top).toBe(bottom - 2);
    press(controller, "g");
    expect(controller.getState().detail?.top).toBe(0);

    press(controller, "s");
    press(controller, "X");
    await settle();
    expect(client.calls).toEqual([]);

    press(controller, "", { escape: true });
    expect(controller.getState().mode).toBe("list");
  });
});

describe("form mode", () => {
  it("types every letter into a text field, the ones that are keys elsewhere included", async () => {
    const { client, controller } = setup();
    press(controller, "i");
    press(controller, "n");

    for (const char of "jkqi-s") press(controller, char);

    expect(controller.getState().mode).toBe("form");
    expect(controller.getState().exited).toBe(false);
    expect(controller.getState().form?.index).toBe(0);
    expect(controller.getState().form?.fields[0]).toMatchObject({ key: "name", value: "jkqi-s" });

    press(controller, "", { backspace: true });
    press(controller, "", { delete: true });
    expect(controller.getState().form?.fields[0]).toMatchObject({ value: "jkqi" });
    await settle();
    expect(client.calls).toEqual([]);
  });

  it("moves between fields with the arrows and tab only, and toggles with space", () => {
    const { controller } = setup();
    press(controller, "i");
    press(controller, "n");
    const index = (): number | undefined => controller.getState().form?.index;

    press(controller, "", { downArrow: true });
    press(controller, "", { tab: true });
    expect(index()).toBe(2);
    press(controller, "", { tab: true, shift: true });
    press(controller, "", { upArrow: true });
    expect(index()).toBe(0);

    press(controller, "", { downArrow: true });
    press(controller, "", { downArrow: true });
    press(controller, "", { downArrow: true });
    expect(controller.getState().form?.fields[3]).toMatchObject({ kind: "check", key: "api", checked: true });
    press(controller, " ");
    expect(controller.getState().form?.fields[3]).toMatchObject({ checked: false });
    // A letter on a checkbox is neither text nor a motion.
    press(controller, "j");
    press(controller, "x");
    expect(index()).toBe(3);
    expect(controller.getState().form?.fields[3]).toMatchObject({ checked: false });
  });

  it("cycles a choice with the arrows and with space", () => {
    const { controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "i");
    press(controller, "d");
    const choice = (): unknown => controller.getState().form?.fields.at(-1);
    for (let i = 0; i < 5; i++) press(controller, "", { downArrow: true });

    expect(choice()).toMatchObject({ kind: "choice", value: "keep" });
    press(controller, "", { rightArrow: true });
    expect(choice()).toMatchObject({ value: "prune" });
    press(controller, "", { leftArrow: true });
    expect(choice()).toMatchObject({ value: "keep" });
    press(controller, " ");
    expect(choice()).toMatchObject({ value: "prune" });
  });

  it("cancels with esc and quits only on ctrl-c", () => {
    const { controller } = setup();
    press(controller, "i");
    press(controller, "n");

    press(controller, "", { escape: true });
    expect(controller.getState().mode).toBe("list");

    press(controller, "i");
    press(controller, "n");
    press(controller, "c", { ctrl: true });
    expect(controller.getState().exited).toBe(true);
  });
});

describe("confirm mode", () => {
  /** The typed question in front of destroying feat-x. */
  function destroyQuestion(): { client: FakeClient; controller: DashboardController } {
    const h = setup(instancesSnapshot());
    press(h.controller, "", { tab: true });
    press(h.controller, "i");
    press(h.controller, "D");
    return h;
  }

  it("takes y, n and q as letters of a name when a name is what was asked for", async () => {
    const { client, controller } = destroyQuestion();

    for (const char of "ynq") press(controller, char);
    await settle();

    expect(controller.getState().mode).toBe("confirm");
    expect(controller.getState().confirm?.typed).toBe("ynq");
    expect(controller.getState().exited).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it("goes ahead on enter only once the name is typed", async () => {
    const { client, controller } = destroyQuestion();

    press(controller, "", { return: true });
    for (const char of "feat-y") press(controller, char);
    press(controller, "", { return: true });
    await settle();
    expect(client.paramsOf("instance.destroy")).toEqual([]);

    press(controller, "", { backspace: true });
    press(controller, "x");
    press(controller, "", { return: true });
    await settle();
    expect(client.paramsOf("instance.destroy")).toEqual([{ name: "feat-x", force: undefined }]);
  });

  it("answers a y question with y, and never with enter", async () => {
    const { client, controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "", { downArrow: true });
    press(controller, "i");
    press(controller, "d");
    press(controller, "", { return: true });
    await settle();
    // The teardown fails and the app stays: the report offers to force it.
    client.finish(
      taskResult("run-1", "instance:teardown", [{ targetId: "api@feat-x", state: "failed", error: "teardown failed", durationMs: 1 }], false),
    );
    await settle();
    expect(controller.getState().mode).toBe("report");

    press(controller, "F");
    expect(controller.getState().mode).toBe("confirm");
    press(controller, "", { return: true });
    press(controller, "x");
    press(controller, " ");
    await settle();
    expect(controller.getState().mode).toBe("confirm");
    expect(client.paramsOf("instance.remove")).toHaveLength(1);

    press(controller, "n");
    expect(controller.getState().mode).toBe("report");
    press(controller, "F");
    press(controller, "y");
    await settle();
    expect(client.paramsOf("instance.remove")).toHaveLength(2);
  });
});

describe("report mode", () => {
  it("scrolls and closes, and runs nothing the report did not offer", async () => {
    const { client, controller } = setup(instancesSnapshot());
    press(controller, "", { tab: true });
    press(controller, "i");
    press(controller, "i");
    await settle();
    client.finish(taskResult("run-1", "instance:init", ["api@feat-x", "platform.web@feat-x"]));
    await settle();
    expect(controller.getState().mode).toBe("report");
    const sent = client.calls.length;

    // Keys that act on the list, and the follow-up letters of other reports.
    for (const key of ["s", "x", "S", "r", "F", "D", "i"]) press(controller, key);
    press(controller, "j");
    await settle();

    expect(controller.getState().mode).toBe("report");
    expect(client.calls).toHaveLength(sent);

    press(controller, "", { return: true });
    expect(controller.getState().mode).toBe("list");
  });
});

describe("log mode", () => {
  it("scrolls instead of running lifecycle keys", async () => {
    const { client, controller } = setup();
    for (let i = 0; i < 10; i++) client.lines.push({ targetId: "api", stream: "stdout", ts: i, text: `line ${i}` });

    await controller.openLogs();
    controller.setLogViewport(2);

    press(controller, "k");
    expect(controller.getState().logs?.follow).toBe(false);

    press(controller, "s");
    press(controller, "S");
    await settle();
    expect(client.paramsOf("service.start")).toEqual([]);

    press(controller, "G");
    expect(controller.getState().logs?.follow).toBe(true);
  });

  it("returns to the list on esc and on q", async () => {
    const { controller } = setup();

    await controller.openLogs();
    press(controller, "", { escape: true });
    await settle();
    expect(controller.getState().mode).toBe("list");

    await controller.openLogs();
    press(controller, "q");
    await settle();
    expect(controller.getState().mode).toBe("list");
    expect(controller.getState().exited).toBe(false);
  });
});

describe("palette mode", () => {
  it("types, filters, moves and runs", async () => {
    const { client, controller } = setup();

    press(controller, ":");
    for (const char of "greet") press(controller, char);
    expect(controller.getState().palette?.query).toBe("greet");
    expect(controller.getState().palette?.items).toHaveLength(1);

    press(controller, "", { backspace: true });
    expect(controller.getState().palette?.query).toBe("gree");

    press(controller, "", { return: true });
    await settle();
    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: ["api"], instance: "base" }]);
    expect(controller.getState().mode).toBe("list");
  });

  it("switches scope with tab and closes with esc", () => {
    const { controller } = setup();

    press(controller, ":");
    press(controller, "", { tab: true });
    expect(controller.getState().palette?.scope).toBe("profile");

    press(controller, "", { escape: true });
    expect(controller.getState().mode).toBe("list");
    expect(controller.getState().palette).toBeUndefined();
  });

  it("moves with ctrl-n/ctrl-p without typing them", () => {
    const { controller } = setup();

    press(controller, ":");
    press(controller, "n", { ctrl: true });
    expect(controller.getState().palette?.index).toBe(1);
    expect(controller.getState().palette?.query).toBe("");

    press(controller, "p", { ctrl: true });
    expect(controller.getState().palette?.index).toBe(0);
  });
});

describe("profile mode", () => {
  it("moves and picks", async () => {
    const { client, controller } = setup();

    press(controller, "P");
    press(controller, "j");
    press(controller, "", { return: true });
    await settle();

    expect(client.paramsOf("profile.use")).toEqual([{ name: "frontend" }]);
    expect(controller.getState().mode).toBe("list");
  });
});

describe("help overlay", () => {
  it("swallows every key until it is dismissed", async () => {
    const { client, controller } = setup();

    press(controller, "?");
    press(controller, "s");
    press(controller, "j");
    await settle();

    expect(client.calls).toEqual([]);
    expect(controller.getState().cursor).toBe(0);
    expect(controller.getState().help).toBe(true);

    press(controller, "", { escape: true });
    expect(controller.getState().help).toBe(false);
  });
});
