/**
 * `u8 profile list|use`.
 *
 * The active profile is daemon-side state in the state dir, not config, so the
 * interesting assertion is that a switch is visible to the *next* invocation —
 * and survives the daemon that recorded it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StatusJson } from "../../src/cli/status.js";
import {
  cleanup,
  cleanupStateHome,
  cli,
  createWorkspace,
  fixtureConfig,
  fixtureDirs,
  type Workspace,
} from "./helpers.js";

let ws: Workspace;

beforeAll(() => {
  ws = createWorkspace(fixtureConfig(), fixtureDirs());
});
afterAll(async () => {
  await cleanup();
  cleanupStateHome();
});

async function activeProfile(): Promise<string> {
  const result = await cli(["status", "--json"], { cwd: ws.dir });
  expect(result.code).toBe(0);
  return (JSON.parse(result.out) as StatusJson).profile.active;
}

describe("profile list", () => {
  it("marks the active profile and counts its targets", async () => {
    const result = await cli(["profile", "list"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    const lines = result.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\*\s+all\b/);
    expect(lines[0]).toContain("(default)");
    expect(lines[0]).toContain("3 targets");
    expect(lines[1]).toContain("frontend");
    expect(lines[1]).toContain("1 target");
    expect(lines[1]).toMatch(/^\s+frontend\b/);
  });
});

describe("profile use", () => {
  it("switches the profile for every later command", async () => {
    const switched = await cli(["profile", "use", "frontend"], { cwd: ws.dir });

    expect(switched.code).toBe(0);
    expect(switched.out).toContain("active profile: frontend");
    expect(switched.out).toContain("platform.web");
    expect(await activeProfile()).toBe("frontend");

    const status = await cli(["status"], { cwd: ws.dir });
    expect(status.out).toContain("profile frontend");
    expect(status.out).not.toContain("APP api");

    expect((await cli(["profile", "list"], { cwd: ws.dir })).out).toMatch(/^\*\s+frontend\b/m);
  });

  it("persists the choice across a daemon restart", async () => {
    expect((await cli(["profile", "use", "frontend"], { cwd: ws.dir })).code).toBe(0);
    expect((await cli(["daemon", "stop"], { cwd: ws.dir })).code).toBe(0);

    // The next command spawns a fresh daemon, which reads the state dir.
    expect(await activeProfile()).toBe("frontend");

    expect((await cli(["profile", "use", "all"], { cwd: ws.dir })).code).toBe(0);
    expect(await activeProfile()).toBe("all");
  });

  it("lists the known profiles when given one that does not exist", async () => {
    const result = await cli(["profile", "use", "nope"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown profile "nope"');
    expect(result.err).toContain("known: all, frontend");
  });
});
