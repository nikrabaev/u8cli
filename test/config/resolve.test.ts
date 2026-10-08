import { afterEach, describe, expect, it } from "vitest";
import {
  commandTargets,
  dependenciesOf,
  profileTargets,
  resolveTargetStrings,
  topoWaves,
} from "../../src/config/index.js";
import type { NormalizedWorkspace } from "../../src/config/types.js";
import { cleanupWorkspaces, cmd, loadFixture, u8ErrorFrom } from "./helpers.js";

afterEach(cleanupWorkspaces);

function workspace(): NormalizedWorkspace {
  return loadFixture({
    repos: {
      db: { path: ".", scripts: { start: "docker compose up", stop: "docker compose down" } },
      gateway: { path: ".", scripts: { start: "pnpm dev" }, dependsOn: ["db"] },
      platform: {
        path: ".",
        apps: {
          shell: { scripts: { start: "pnpm dev --port 3100" } },
          api: { scripts: { start: "pnpm dev --port 3101" }, dependsOn: ["gateway"] },
        },
      },
    },
    profiles: {
      full: { default: true, targets: ["db", "gateway", "platform"] },
      frontend: { targets: ["platform.shell"] },
    },
    commands: {
      test: { script: "pnpm test", targets: { db: null, "platform.shell": "pnpm test --shell" } },
      deploy: { targets: { gateway: "./deploy.sh" } },
    },
  }).ws;
}

describe("resolveTargetStrings", () => {
  it("expands repos, keeps app ids and preserves order", () => {
    expect(resolveTargetStrings(workspace(), ["platform", "db"])).toEqual([
      "platform.shell",
      "platform.api",
      "db",
    ]);
  });

  it("dedupes overlapping selections", () => {
    expect(resolveTargetStrings(workspace(), ["platform.api", "platform", "platform.api"])).toEqual([
      "platform.api",
      "platform.shell",
    ]);
  });

  it("throws UNKNOWN_TARGET for a name nobody declared", () => {
    const e = u8ErrorFrom(() => resolveTargetStrings(workspace(), ["ghost"]));
    expect(e.code).toBe("UNKNOWN_TARGET");
    expect(e.message).toContain("ghost");
  });
});

describe("profileTargets", () => {
  it("returns the expanded ids of a named profile", () => {
    expect(profileTargets(workspace(), "frontend")).toEqual(["platform.shell"]);
  });

  it("falls back to the default profile", () => {
    expect(profileTargets(workspace())).toEqual(["db", "gateway", "platform.shell", "platform.api"]);
  });

  it("throws UNKNOWN_PROFILE otherwise", () => {
    expect(u8ErrorFrom(() => profileTargets(workspace(), "nope")).code).toBe("UNKNOWN_PROFILE");
  });
});

describe("commandTargets", () => {
  it("applies the shared script, per-target overrides, null-skip and absent-skip", () => {
    const ws = workspace();
    const ids = ["db", "gateway", "platform.shell", "platform.api"];

    expect(commandTargets(ws, "test", ids)).toEqual([
      { targetId: "gateway", script: "pnpm test" },
      { targetId: "platform.shell", script: "pnpm test --shell" },
      { targetId: "platform.api", script: "pnpm test" },
    ]);
    // No shared script: every target without an override is skipped.
    expect(commandTargets(ws, "deploy", ids)).toEqual([{ targetId: "gateway", script: "./deploy.sh" }]);
  });

  it("accepts a command object and dedupes ids", () => {
    const ws = workspace();
    expect(commandTargets(ws, cmd(ws, "deploy"), ["gateway", "gateway"])).toHaveLength(1);
  });

  it("resolves app:start from each app's start script", () => {
    const ws = loadFixture({
      repos: {
        db: { path: ".", scripts: { start: "up", stop: "down" } },
        docs: { path: "." },
      },
    }).ws;

    expect(commandTargets(ws, "app:start", ["db", "docs"])).toEqual([{ targetId: "db", script: "up" }]);
    expect(commandTargets(ws, "app:stop", ["db", "docs"])).toEqual([{ targetId: "db", script: "down" }]);
    expect(commandTargets(ws, "app:restart", ["db", "docs"])).toEqual([]);
  });

  it("throws UNKNOWN_COMMAND for an undefined name", () => {
    expect(u8ErrorFrom(() => commandTargets(workspace(), "nope", [])).code).toBe("UNKNOWN_COMMAND");
  });
});

describe("dependenciesOf", () => {
  it("returns resolved direct dependencies", () => {
    expect(dependenciesOf(workspace(), "platform.api")).toEqual(["gateway"]);
    expect(dependenciesOf(workspace(), "db")).toEqual([]);
  });

  it("throws for an unknown target", () => {
    expect(u8ErrorFrom(() => dependenciesOf(workspace(), "ghost")).code).toBe("UNKNOWN_TARGET");
  });
});

describe("topoWaves", () => {
  it("groups targets that may start in parallel", () => {
    const ws = workspace();
    expect(topoWaves(ws, profileTargets(ws, "full"))).toEqual([
      ["db", "platform.shell"],
      ["gateway"],
      ["platform.api"],
    ]);
  });

  it("ignores dependencies outside the selection", () => {
    const ws = workspace();
    expect(topoWaves(ws, ["platform.api"])).toEqual([["platform.api"]]);
    expect(topoWaves(ws, ["platform.api", "gateway"])).toEqual([["gateway"], ["platform.api"]]);
  });

  it("keeps the given order inside a wave and dedupes", () => {
    const ws = workspace();
    expect(topoWaves(ws, ["platform.shell", "db", "db"])).toEqual([["platform.shell", "db"]]);
  });

  it("throws for an unknown target", () => {
    expect(u8ErrorFrom(() => topoWaves(workspace(), ["ghost"])).code).toBe("UNKNOWN_TARGET");
  });
});
