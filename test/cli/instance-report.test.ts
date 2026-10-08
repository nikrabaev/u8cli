/**
 * What both front ends say about an instance.
 *
 * `u8 instance add` prints these sentences and the dashboard draws them; the
 * end-to-end tests of each prove the words reach the screen. What is pinned
 * here is the part neither of those can isolate: which apps count as rewired,
 * which checkout gets which sentence, and which log a failure is read from.
 */
import { describe, expect, it } from "vitest";

import {
  addressesOf,
  baseDependencyMessage,
  checkoutOutcomes,
  destroyedCheckouts,
  explicitTarget,
  externalDependenciesDown,
  failureTailTitle,
  nameForWorktree,
  readFailureTails,
  rewiredApps,
  rewiredMessage,
  typed,
} from "../../src/cli/instance-report.js";
import type { LogLine } from "../../src/ipc/protocol.js";
import { agent2, featX, fixtureSnapshot, instancesSnapshot, logLine, serviceState, taskResult, withInstances } from "../tui/helpers.js";

describe("addresses", () => {
  it("lists every named port of an instance's apps, or only of the ones asked for", () => {
    const snapshot = instancesSnapshot();
    expect(addressesOf(snapshot, "feat-x")).toEqual([
      { id: "api@feat-x", port: "http", url: "http://localhost:20001" },
      { id: "platform.web@feat-x", port: "http", url: "http://localhost:20002" },
    ]);
    expect(addressesOf(snapshot, "feat-x", ["platform.web@feat-x"]).map((a) => a.id)).toEqual(["platform.web@feat-x"]);
    expect(addressesOf(snapshot, "nope")).toEqual([]);
  });

  it("spells targets the way they are typed, and base's the way an instance has to", () => {
    const snapshot = instancesSnapshot();
    expect(typed(snapshot, ["api@feat-x", "platform.web@feat-x"])).toBe("api platform.web");
    // An app the snapshot no longer has still loses its instance suffix.
    expect(typed(snapshot, ["gone@feat-x"])).toBe("gone");
    expect(explicitTarget("api")).toBe("api@base");
    expect(explicitTarget("api@other")).toBe("api@other");
  });
});

describe("rewiring", () => {
  it("names only the instance's own apps that this change made stale", () => {
    const before = withInstances(
      fixtureSnapshot(),
      featX({ status: { "api@feat-x": "running", "platform.web@feat-x": "running" }, stale: ["api@feat-x"] }),
      agent2(),
    );
    const after = {
      ...before,
      services: [
        // Base's api going stale is not this instance's news.
        serviceState("api", "running", true),
        // Stale before the change: an earlier edit's doing, already said then.
        serviceState("api@feat-x", "running", true),
        serviceState("platform.web@feat-x", "running", true),
        serviceState("api@agent-2", "running", true),
      ],
    };

    expect(rewiredApps(before, after, "feat-x")).toEqual(["platform.web@feat-x"]);
    expect(rewiredApps(before, after, "agent-2")).toEqual(["api@agent-2"]);
  });

  it("words one app and several, and ends in the front end's own way to restart", () => {
    expect(rewiredMessage(["web@x"], "u8 -i x restart web")).toBe(
      "web@x is now stale: it is still running with what it pointed at before this change — restart to pick it up: u8 -i x restart web",
    );
    expect(rewiredMessage(["web@x", "api@x"], "r here")).toBe(
      "web@x, api@x are now stale: they are still running with what they pointed at before this change — restart to pick it up: r here",
    );
  });
});

describe("leaning on base", () => {
  it("finds dependencies outside the instance that are not running", () => {
    const snapshot = instancesSnapshot();
    expect(externalDependenciesDown(snapshot, "feat-x")).toEqual(["platform.admin"]);
    expect(externalDependenciesDown(snapshot, "agent-2")).toEqual([]);
    // Base leans on nobody: what it depends on is its own.
    expect(externalDependenciesDown(snapshot, "base")).toEqual([]);

    const up = { ...snapshot, services: [...snapshot.services, serviceState("platform.admin", "running")] };
    expect(externalDependenciesDown(up, "feat-x")).toEqual([]);
  });

  it("says which, and leaves how to start them to the caller", () => {
    expect(baseDependencyMessage("feat-x", ["api"], "start with: u8 start api@base")).toBe(
      'instance "feat-x" uses api from another instance, and it is not running — start with: u8 start api@base',
    );
    expect(baseDependencyMessage("feat-x", ["api", "db"], "s on their rows")).toBe(
      'instance "feat-x" uses api, db from another instance, and they are not running — s on their rows',
    );
  });
});

describe("checkouts after a removal", () => {
  /** feat-x before and after `mutate` was applied to it. */
  function change(mutate: (part: ReturnType<typeof featX>) => void): [ReturnType<typeof instancesSnapshot>, ReturnType<typeof instancesSnapshot>] {
    const after = featX();
    mutate(after);
    return [withInstances(fixtureSnapshot(), featX()), withInstances(fixtureSnapshot(), after)];
  }

  it("says a checkout was kept when its repo lost its last app", () => {
    const [before, after] = change((part) => {
      part.instance.appIds = ["platform.web@feat-x"];
      part.repos = part.repos.filter((repo) => repo.name !== "api@feat-x");
    });
    expect(checkoutOutcomes(before, after, "feat-x")).toEqual([
      { kind: "kept", repo: "api", path: "/wt/feat-x/api", text: "kept the checkout of api at /wt/feat-x/api" },
    ]);
  });

  it("says a worktree u8 created was removed, and an adopted one only forgotten", () => {
    const [before, after] = change((part) => {
      delete part.instance.checkouts["infra@feat-x"];
      delete part.instance.checkouts["platform@feat-x"];
    });
    expect(checkoutOutcomes(before, after, "feat-x")).toEqual([
      {
        kind: "forgotten",
        repo: "platform",
        path: "/agents/wt-3/platform",
        text: "forgot the checkout at /agents/wt-3/platform",
        note: "(adopted — the directory was not touched)",
      },
      { kind: "removed", repo: "infra", path: "/wt/feat-x/infra", text: "removed the worktree at /wt/feat-x/infra" },
    ]);
  });

  it("says a shared worktree stays while another repo still runs from it, once", () => {
    const shared = { path: "/wt/mono/a", owned: true, worktree: "/wt/mono" };
    const before = withInstances(fixtureSnapshot(), featX());
    const instance = before.instances.find((i) => i.name === "feat-x");
    if (!instance) throw new Error("no feat-x");
    instance.checkouts = {
      "a@feat-x": shared,
      "b@feat-x": { ...shared, path: "/wt/mono/b" },
      "c@feat-x": { ...shared, path: "/wt/mono/c" },
    };
    const after = structuredClone(before);
    const now = after.instances.find((i) => i.name === "feat-x");
    if (!now) throw new Error("no feat-x");
    delete now.checkouts["a@feat-x"];
    delete now.checkouts["b@feat-x"];

    // Two repos left the record and one worktree is the news.
    expect(checkoutOutcomes(before, after, "feat-x")).toEqual([
      {
        kind: "shared",
        repo: "a",
        path: "/wt/mono",
        text: "the worktree at /wt/mono stays: the instance's other apps still run from it",
      },
    ]);
  });

  it("has nothing to say about an instance that is gone, or that changed nothing", () => {
    const snapshot = instancesSnapshot();
    expect(checkoutOutcomes(snapshot, snapshot, "feat-x")).toEqual([]);
    expect(checkoutOutcomes(snapshot, fixtureSnapshot(), "feat-x")).toEqual([]);
  });

  it("says what a destroy did with each checkout", () => {
    expect(destroyedCheckouts(instancesSnapshot(), "feat-x").map((o) => [o.kind, o.text])).toEqual([
      ["removed", "removed the worktree at /wt/feat-x/api"],
      ["forgotten", "forgot the checkout at /agents/wt-3/platform"],
      ["removed", "removed the worktree at /wt/feat-x/infra"],
    ]);
  });
});

describe("naming a worktree", () => {
  it("uses the directory's name, made to fit, and never one that is taken", () => {
    const snapshot = instancesSnapshot();
    expect(nameForWorktree("/agents/fix login!", snapshot)).toBe("fix-login");
    expect(nameForWorktree("/agents/.hidden", snapshot)).toBe("hidden");
    expect(nameForWorktree("/agents/feat-x", snapshot)).toBe("feat-x-2");
    // `base` is the one name no instance may have.
    expect(nameForWorktree("/agents/base", snapshot)).toBe("worktree");
    expect(nameForWorktree("/agents/---", snapshot)).toBe("worktree");
  });
});

describe("failure tails", () => {
  const logs: Record<string, LogLine[]> = {
    "service:api": [logLine("api", "listen EADDRINUSE")],
    "run:r1:web": [logLine("web", "pre hook refused")],
    "run:r2:api": [logLine("api", "npm ERR! missing script"), logLine("api", "exit 1")],
  };
  const asked: string[] = [];
  const read = async (params: { targetId: string; lines: number; runId?: string }): Promise<{ lines: LogLine[] }> => {
    const key = params.runId === undefined ? `service:${params.targetId}` : `run:${params.runId}:${params.targetId}`;
    asked.push(key);
    if (params.targetId === "broken") throw new Error("unknown target");
    return { lines: logs[key] ?? [] };
  };

  it("reads a failed start from the service log, and from the run log when the process never existed", async () => {
    asked.length = 0;
    const result = taskResult(
      "r1",
      "app:start",
      [
        { targetId: "api", state: "failed", durationMs: 1 },
        { targetId: "web", state: "aborted", durationMs: 1 },
        { targetId: "db", state: "ok", durationMs: 1 },
      ],
      false,
    );

    expect(await readFailureTails(read, result)).toEqual([
      { targetId: "api", lines: ["listen EADDRINUSE"] },
      { targetId: "web", lines: ["pre hook refused"] },
    ]);
    // The target that succeeded is never asked about.
    expect(asked).toEqual(["service:api", "service:web", "run:r1:web"]);
  });

  it("reads an init step's failure from the run log, and skips what cannot be read", async () => {
    asked.length = 0;
    const result = taskResult(
      "r2",
      "instance:init",
      [
        { targetId: "api", state: "failed", durationMs: 1 },
        { targetId: "broken", state: "failed", durationMs: 1 },
      ],
      false,
    );

    const tails = await readFailureTails(read, result);
    expect(tails).toEqual([{ targetId: "api", lines: ["npm ERR! missing script", "exit 1"] }]);
    expect(asked).toEqual(["run:r2:api", "run:r2:broken"]);
    expect(tails.map(failureTailTitle)).toEqual(["── api: last 2 lines ──"]);
    expect(failureTailTitle({ targetId: "web", lines: ["one"] })).toBe("── web: last 1 line ──");
  });
});
