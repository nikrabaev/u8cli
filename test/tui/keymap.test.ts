/**
 * The bindings from SPEC §9.1, driven the way Ink drives them: `(input, key)`
 * straight into the controller.
 *
 * The interesting half is what does *not* happen — `s` must not start a service
 * while the log view has the screen, and a key nobody bound must be a no-op
 * rather than an error — so most of these assert on silence.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createController, type DashboardController } from "../../src/tui/controller.js";
import type { TuiKey } from "../../src/tui/types.js";
import { createFakeClient, settle, testScheduler, type FakeClient } from "./helpers.js";

const live: DashboardController[] = [];

function setup(): { client: FakeClient; controller: DashboardController } {
  const client = createFakeClient();
  const controller = createController({ client, color: false, scheduler: testScheduler().schedule });
  live.push(controller);
  return { client, controller };
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

    expect(client.paramsOf("service.start")).toEqual([{ targets: ["api"] }, { targets: undefined }]);
    expect(client.paramsOf("service.stop")).toEqual([{ targets: ["api"] }, { targets: undefined }]);
    expect(client.paramsOf("service.restart")).toEqual([{ targets: ["api"] }, { targets: undefined }]);
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
    expect(client.paramsOf("command.run")).toEqual([{ command: "greet", targets: ["api"] }]);
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
