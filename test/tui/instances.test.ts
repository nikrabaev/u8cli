/**
 * What the dashboard reads off a snapshot about an instance.
 *
 * Every one of these is a question somebody watching ten instances asks at a
 * glance, and every answer is a derivation — so they are pinned here as plain
 * functions, without a controller or a terminal in the way.
 */
import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/ipc/protocol.js";
import {
  addableApps,
  destroyLines,
  detailLines,
  externalDependencies,
  instanceChanges,
  keptCheckouts,
  sectionFacts,
  sectionFlags,
  worktreeCovered,
  type IndicatorReader,
} from "../../src/tui/instances.js";
import { agent2, featX, fixtureSnapshot, instancesSnapshot, serviceState, withInstances } from "./helpers.js";

const nothing: IndicatorReader = () => undefined;

function instanceOf(snapshot: Snapshot, name: string): Snapshot["instances"][number] {
  const found = snapshot.instances.find((i) => i.name === name);
  if (!found) throw new Error(`no instance ${name}`);
  return found;
}

describe("section flags", () => {
  it("says nothing about an instance with nothing to report", () => {
    expect(sectionFlags({ initialized: true, stale: [], down: [] })).toEqual([]);
  });

  it("names a run in flight, a missing init, stale apps and a base app that is down", () => {
    expect(
      sectionFlags({
        initialized: false,
        busy: "instance:init",
        stale: ["api@feat-x", "platform.web@feat-x"],
        down: ["platform.admin", "db"],
      }),
    ).toEqual([
      { text: "… instance:init", tone: "info" },
      { text: "not initialised", tone: "warn" },
      { text: "2 stale", tone: "warn" },
      // Spelled with its instance: beside feat-x's rows a bare name reads as feat-x's own.
      { text: "platform.admin@base, db@base are down", tone: "error" },
    ]);
  });

  it("reads stale apps and base dependencies off the snapshot", () => {
    const snapshot = withInstances(fixtureSnapshot(), featX({ status: { "api@feat-x": "running" }, stale: ["api@feat-x"] }));
    const instance = instanceOf(snapshot, "feat-x");

    expect(sectionFacts(snapshot, instance, instance.appIds)).toEqual({
      initialized: true,
      busy: undefined,
      stale: ["api@feat-x"],
      // web@feat-x depends on platform.admin, which only base has — and base's is stopped.
      down: ["platform.admin"],
    });

    const up = { ...snapshot, services: [...snapshot.services, serviceState("platform.admin", "running")] };
    expect(sectionFacts(up, instance, instance.appIds).down).toEqual([]);
  });
});

describe("membership", () => {
  it("offers the apps of base the instance has no copy of", () => {
    expect(addableApps(instancesSnapshot(), "feat-x").map((app) => app.id)).toEqual(["platform.admin"]);
    expect(addableApps(instancesSnapshot(), "agent-2").map((app) => app.id)).toEqual(["platform.web", "platform.admin"]);
  });

  it("finds the checkouts an earlier remove left without apps", () => {
    // `infra@feat-x` is in the record's checkouts and in no repo: nothing runs from it.
    expect(keptCheckouts(instancesSnapshot(), "feat-x")).toEqual([{ repo: "infra", path: "/wt/feat-x/infra", owned: true }]);
    expect(keptCheckouts(instancesSnapshot(), "agent-2")).toEqual([]);
    expect(keptCheckouts(instancesSnapshot(), "base")).toEqual([]);
  });

  it("lists what an instance uses from outside itself, and who needs it", () => {
    expect(externalDependencies(instancesSnapshot(), "feat-x")).toEqual([
      { id: "platform.admin", status: "stopped", neededBy: ["platform.web@feat-x"] },
    ]);
    expect(externalDependencies(instancesSnapshot(), "agent-2")).toEqual([]);
  });
});

describe("what a reload changed", () => {
  const base = fixtureSnapshot();

  it("says an instance appeared or went away, whoever did it", () => {
    const one = withInstances(base, featX());
    expect(instanceChanges(base, one)).toEqual(["instance feat-x created"]);
    expect(instanceChanges(one, base)).toEqual(["instance feat-x destroyed"]);
  });

  it("names the apps an instance gained and lost", () => {
    const before = withInstances(base, agent2());
    const grown = agent2();
    grown.instance.appIds = ["api@agent-2", "platform.web@agent-2"];
    expect(instanceChanges(before, withInstances(base, grown))).toEqual(["agent-2 gained platform.web"]);
    expect(instanceChanges(withInstances(base, grown), before)).toEqual(["agent-2 lost platform.web"]);
  });

  it("says a checkout was given up only when that is all that happened", () => {
    const before = withInstances(base, featX());
    const pruned = featX();
    delete pruned.instance.checkouts["infra@feat-x"];
    expect(instanceChanges(before, withInstances(base, pruned))).toEqual(["feat-x gave up its checkout of infra"]);

    // An app pruned with its checkout is one event, and "lost" is its name.
    const shrunk = featX();
    shrunk.instance.appIds = ["platform.web@feat-x"];
    delete shrunk.instance.checkouts["api@feat-x"];
    expect(instanceChanges(before, withInstances(base, shrunk))).toEqual(["feat-x lost api"]);
  });

  it("says when an instance becomes ready, and nothing when nothing about instances moved", () => {
    const before = withInstances(base, featX({ initialized: false }));
    expect(instanceChanges(before, withInstances(base, featX()))).toEqual(["feat-x is initialised"]);
    expect(instanceChanges(before, before)).toEqual([]);
    // A config edit that leaves instances alone is still just a reload.
    expect(instanceChanges(base, { ...base, activeProfile: "frontend" })).toEqual([]);
  });
});

describe("worktrees", () => {
  it("knows a directory is covered once an instance runs from it", () => {
    const snapshot = instancesSnapshot();
    expect(worktreeCovered(snapshot, "/agents/wt-3")).toBe(true);
    expect(worktreeCovered(snapshot, "/agents/wt-3/platform")).toBe(true);
    // A sibling whose name merely starts the same way is somebody else's.
    expect(worktreeCovered(snapshot, "/agents/wt-33")).toBe(false);
    expect(worktreeCovered(snapshot, "/agents/wt")).toBe(false);
  });
});

describe("detail", () => {
  const text = (lines: ReturnType<typeof detailLines>): string[] => lines.map((line) => line.text);

  it("lays out an instance's checkouts, apps and what it borrows from base", () => {
    const snapshot = withInstances(
      fixtureSnapshot(),
      featX({ status: { "api@feat-x": "running", "platform.web@feat-x": "running" }, stale: ["platform.web@feat-x"] }),
    );
    const read: IndicatorReader = (scope, owner, ns, name) =>
      scope === "repo" && owner === "api@feat-x" && ns === "git" && name === "dirty" ? "3" : undefined;

    const lines = detailLines({ snapshot, instance: "feat-x", read, now: 3_601_000 });

    expect(text(lines)).toEqual([
      "instance feat-x · 2/2 running · initialised · created 1h0m ago",
      "",
      "checkouts",
      // What it is, then where: whose a checkout is must not wrap out of sight behind its path.
      "  api       branch feat-x · created by u8 (the branch too) · 3 uncommitted",
      "            /wt/feat-x/api",
      "  platform  adopted — u8 never removes it",
      "            /agents/wt-3/platform",
      "  infra     branch feat-x · created by u8 · no apps (kept)",
      "            /wt/feat-x/infra",
      "",
      "apps",
      "  api           running          http 20001  http://localhost:20001",
      "  platform.web  running · stale  http 20002  http://localhost:20002",
      "",
      "uses from base",
      "  platform.admin@base  stopped — not running  (needed by platform.web) — start it from its own section",
    ]);
    // The checkout nothing runs from, the stale app and the dependency that is down are the ones that stand out.
    expect(lines.filter((line) => line.tone === "warn").map((line) => line.text.trim().split(" ")[0])).toEqual([
      "infra",
      "platform.web",
    ]);
    expect(lines.at(-1)?.tone).toBe("error");
  });

  it("says an instance leans on nothing when every dependency is its own", () => {
    const lines = detailLines({ snapshot: instancesSnapshot(), instance: "agent-2", read: nothing, now: 2_000 });
    expect(text(lines).slice(-2)).toEqual(["uses from base", "  nothing — every app it depends on is its own copy"]);
  });

  it("describes base by the paths the config declares, and borrows nothing", () => {
    const lines = detailLines({ snapshot: instancesSnapshot(), instance: "base", read: nothing, now: 0 });
    expect(text(lines)).toEqual([
      "instance base · 0/3 running · initialised",
      "",
      "checkouts",
      "  api       the path u8.jsonc declares — never created or removed by u8",
      "            /ws/api",
      "  platform  the path u8.jsonc declares — never created or removed by u8",
      "            /ws/platform",
      "",
      "apps",
      "  api             stopped  no ports",
      "  platform.web    stopped  no ports",
      "  platform.admin  stopped  no ports",
    ]);
  });

  it("warns when the instance has not been through its init steps", () => {
    const snapshot = withInstances(fixtureSnapshot(), featX({ initialized: false }));
    const [title] = detailLines({ snapshot, instance: "feat-x", read: nothing, now: 1_000 });
    expect(title).toEqual({
      text: "instance feat-x · 0/2 running · not initialised — run init before starting it · created 0ms ago",
      tone: "warn",
    });
  });
});

describe("what destroy does", () => {
  it("names every worktree it removes, what git sees in it, and what it only forgets", () => {
    const snapshot = withInstances(fixtureSnapshot(), featX({ status: { "api@feat-x": "running" } }));
    const read: IndicatorReader = (_scope, owner, ns, name) =>
      owner === "api@feat-x" && ns === "git" && name === "dirty" ? "3" : undefined;

    expect(destroyLines(snapshot, "feat-x", read)).toEqual([
      { text: "stops 1 running app, runs the teardown steps and frees its ports", tone: "plain" },
      { text: "removes 2 worktrees u8 created, with whatever is uncommitted in them:", tone: "error" },
      { text: "  /wt/feat-x/api — api: 3 uncommitted", tone: "error" },
      // Kept after its last app left, and still removed with the instance.
      { text: "  /wt/feat-x/infra", tone: "plain" },
      { text: "forgets 1 adopted checkout — the directory is not touched:", tone: "plain" },
      { text: "  /agents/wt-3/platform", tone: "plain" },
    ]);
  });
});
