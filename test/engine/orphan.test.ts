/**
 * A running target the config no longer declares (SPEC §8: a reload leaves
 * running processes alone). It must stay stoppable — by id and by an unqualified
 * "stop everything" — or deleting an app from `u8.jsonc` while it runs orphans
 * its process until the daemon dies.
 *
 * Only stop resolution is widened: starting or running a command against a
 * target the config dropped is still an error, since there is nothing left to
 * say what would be started.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHarnesses, createHarness, settled, statesByTarget, type Harness } from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

const START = "true # start";

/** `api` and `web` (which depends on it), plus a two-subapp `platform`. */
function stack(): Harness {
  return createHarness({
    dirs: ["api", "web", "platform/shell", "platform/admin"],
    config: {
      apps: {
        api: { path: "api", scripts: { start: START } },
        web: { path: "web", scripts: { start: START }, dependsOn: ["api"] },
        platform: {
          path: "platform",
          subapps: { shell: { path: "shell", scripts: { start: START } }, admin: { path: "admin", scripts: { start: START } } },
        },
      },
      profiles: { all: { default: true, targets: ["api", "web", "platform"] } },
    },
  });
}

/** The same workspace with `web` and `platform` deleted. */
function apiOnly(): object {
  return {
    apps: { api: { path: "api", scripts: { start: START } } },
    profiles: { all: { default: true, targets: ["api"] } },
  };
}

describe("targets dropped by a reload", () => {
  it("keeps running and is stoppable by id", async () => {
    const h = stack();
    await settled(h.engine.startTargets());
    const seen: Array<[string, string]> = [];
    h.plugins.addHook("audit", "app:stop", {
      post: (ctx) => {
        seen.push([ctx.target.id, ctx.cwd]);
      },
    });

    h.reload(apiOnly());

    expect(h.supervisor.isRunning("web")).toBe(true);

    const result = await settled(h.engine.stopTargets(["web"]));

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ web: "ok" });
    expect(h.supervisor.stopOrder).toEqual(["web"]);
    expect(h.supervisor.isRunning("web")).toBe(false);
    // The pipeline still ran, with the workspace root standing in for the cwd
    // the config no longer declares.
    expect(seen).toEqual([["web", h.dir]]);
  });

  it("is reachable through the app name it belonged to", async () => {
    const h = stack();
    await settled(h.engine.startTargets());

    h.reload(apiOnly());
    const result = await settled(h.engine.stopTargets(["platform"]));

    expect(statesByTarget(result)).toEqual({ "platform.shell": "ok", "platform.admin": "ok" });
    expect(h.supervisor.isRunning("platform.shell")).toBe(false);
  });

  it("is picked up by its app name when only the subapp was dropped", async () => {
    const h = stack();
    await settled(h.engine.startTargets());

    h.reload({
      apps: {
        api: { path: "api", scripts: { start: START } },
        platform: { path: "platform", subapps: { shell: { path: "shell", scripts: { start: START } } } },
      },
      profiles: { all: { default: true, targets: ["api", "platform"] } },
    });
    const result = await settled(h.engine.stopTargets(["platform"]));

    // `platform.admin` is gone from the config but still running under the app.
    expect(statesByTarget(result)).toEqual({ "platform.shell": "ok", "platform.admin": "ok" });
  });

  it("is reaped by a profile-wide stop, before the targets that remain", async () => {
    const h = stack();
    await settled(h.engine.startTargets());

    h.reload(apiOnly());
    const result = await settled(h.engine.stopTargets());

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({
      "web": "ok",
      "platform.shell": "ok",
      "platform.admin": "ok",
      api: "ok",
    });
    // Orphans go first: nothing left in the config describes what depends on them.
    expect(h.supervisor.stopOrder.indexOf("web")).toBeLessThan(h.supervisor.stopOrder.indexOf("api"));
    expect(h.supervisor.runningCount()).toBe(0);
  });

  it("drops out of the selection once it is down", async () => {
    const h = stack();
    await settled(h.engine.startTargets());
    h.reload(apiOnly());
    await settled(h.engine.stopTargets());
    h.supervisor.events.length = 0;

    const again = await settled(h.engine.stopTargets());

    expect(again.targets.map((t) => t.targetId)).toEqual(["api"]);
    expect(h.supervisor.stopOrder).toEqual(["api"]);
  });

  it("stays an error for start, restart and command runs", async () => {
    const h = stack();
    await settled(h.engine.startTargets());
    h.reload(apiOnly());

    expect(() => h.engine.startTargets(["web"])).toThrow(/unknown target "web"/);
    expect(() => h.engine.restartTargets(["web"])).toThrow(/unknown target "web"/);
    expect(() => h.engine.runCommand({ command: "app:start", targets: ["web"] })).toThrow(/unknown target/);
    // And a target nobody ever ran is unknown to stop as well.
    expect(() => h.engine.stopTargets(["ghost"])).toThrow(/unknown target "ghost"/);
  });
});
