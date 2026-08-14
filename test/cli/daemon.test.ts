/**
 * `u8 daemon status|stop|logs`.
 *
 * The rule these tests hold to is that none of them may auto-spawn a daemon:
 * asking whether one is running must not start one, and stopping one that is
 * already gone must not resurrect it just to kill it again.
 */
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { StatusJson } from "../../src/cli/status.js";
import {
  cleanup,
  cleanupStateHome,
  cli,
  createEmptyDir,
  createNestedWorkspace,
  createWorkspace,
  pidAlive,
  service,
  waitFor,
  type Workspace,
} from "./helpers.js";

afterEach(cleanup);
afterAll(cleanupStateHome);

function workspace(): Workspace {
  return createWorkspace(
    {
      name: "daemon-fixture",
      apps: { api: { path: "api", scripts: { start: service("api-ready") } } },
    },
    ["api"],
  );
}

describe("daemon status", () => {
  it("reports a workspace with no daemon without starting one", async () => {
    const ws = workspace();
    const result = await cli(["daemon", "status"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.out).toContain("not running");
    expect(result.out).toContain(ws.paths.socket);
    expect(fs.existsSync(ws.paths.pidFile)).toBe(false);
  });

  it("describes the running daemon", async () => {
    const ws = workspace();
    expect((await cli(["status"], { cwd: ws.dir })).code).toBe(0);

    const result = await cli(["daemon", "status"], { cwd: ws.dir });
    expect(result.code).toBe(0);
    expect(result.out).toContain("running");
    for (const label of ["version", "pid", "uptime", "workspace", "config", "socket", "services"]) {
      expect(result.out).toContain(label);
    }
    expect(result.out).toContain(ws.configPath);
  });
});

describe("daemon logs", () => {
  it("says so when there is nothing to read yet", async () => {
    const ws = workspace();
    const result = await cli(["daemon", "logs"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain("no daemon log yet");
  });

  it("tails the daemon's own log", async () => {
    const ws = workspace();
    await cli(["status"], { cwd: ws.dir });

    const result = await cli(["daemon", "logs", "-n", "50"], { cwd: ws.dir });
    expect(result.code).toBe(0);
    expect(result.out).toContain("daemon");
  });
});

describe("daemon stop", () => {
  it("stops the daemon and its services, and is idempotent", async () => {
    const ws = workspace();
    expect((await cli(["start", "api"], { cwd: ws.dir })).code).toBe(0);

    const json = JSON.parse((await cli(["status", "--json"], { cwd: ws.dir })).out) as StatusJson;
    const pid = json.apps.flatMap((a) => a.subapps)[0]?.pid ?? 0;
    expect(pidAlive(pid)).toBe(true);

    const stopped = await cli(["daemon", "stop"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("daemon stopped");

    // SPEC §5.1: a daemon shutdown takes its service tree with it.
    await waitFor(() => !pidAlive(pid), "the service to be stopped with the daemon");
    expect((await cli(["daemon", "status"], { cwd: ws.dir })).code).toBe(1);

    const again = await cli(["daemon", "stop"], { cwd: ws.dir });
    expect(again.code).toBe(0);
    expect(again.out).toContain("no daemon running");
  });

  it("blames the interrupt, not the daemon, when Ctrl-C cuts the wait short", async () => {
    const ws = workspace();
    expect((await cli(["status"], { cwd: ws.dir })).code).toBe(0);

    // Ctrl-C while waiting for the socket to go quiet: the stop was already
    // accepted, so reporting that the daemon "is still listening" would be a
    // lie about a shutdown that is in fact under way.
    const result = await cli(["daemon", "stop"], { cwd: ws.dir, signal: AbortSignal.abort() });
    expect(result.code).toBe(130);
    expect(result.err).toContain("interrupted");
    expect(result.err).not.toContain("still listening");

    // And it really was on its way out.
    await waitFor(async () => (await cli(["daemon", "status"], { cwd: ws.dir })).code === 1, "the daemon to exit");
  });
});

/**
 * A branch switch or a checkout rename takes `u8.jsonc` away from a daemon that
 * is still supervising the workspace's processes. The workspace id is a hash of
 * the config *path*, so nothing on disk is needed to find that daemon — and
 * these three commands are the only way left to reach it.
 */
describe("a workspace whose config is gone", () => {
  it("still sees, logs and stops the daemon that is holding its services", async () => {
    const ws = workspace();
    expect((await cli(["start", "api"], { cwd: ws.dir })).code).toBe(0);

    const json = JSON.parse((await cli(["status", "--json"], { cwd: ws.dir })).out) as StatusJson;
    const pid = json.apps.flatMap((a) => a.subapps)[0]?.pid ?? 0;
    expect(pidAlive(pid)).toBe(true);

    fs.rmSync(ws.configPath);

    const status = await cli(["daemon", "status"], { cwd: ws.dir });
    expect(status.code).toBe(0);
    expect(status.out).toContain("daemon: running");
    expect(status.out).toContain(ws.paths.socket);

    const logs = await cli(["daemon", "logs", "-n", "5"], { cwd: ws.dir });
    expect(logs.code).toBe(0);

    const stopped = await cli(["daemon", "stop"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain("daemon stopped");
    await waitFor(() => !pidAlive(pid), "the service to be reaped with the daemon");
  });

  it("addresses the directory it is standing in, not an ancestor workspace", async () => {
    const outer = workspace();
    const inner = createNestedWorkspace(outer, "inner", {
      name: "inner-fixture",
      apps: { web: { path: ".", scripts: { start: service("web-ready") } } },
    });

    expect((await cli(["start", "web"], { cwd: inner.dir })).code).toBe(0);
    expect((await cli(["status"], { cwd: outer.dir })).code).toBe(0);
    const json = JSON.parse((await cli(["status", "--json"], { cwd: inner.dir })).out) as StatusJson;
    const pid = json.apps.flatMap((a) => a.subapps)[0]?.pid ?? 0;
    expect(pidAlive(pid)).toBe(true);

    fs.rmSync(inner.configPath);

    // Upward discovery finds the outer `u8.jsonc` from here. Acting on it would
    // report success about a daemon that never touched these processes — and
    // stop the wrong one.
    const status = await cli(["daemon", "status"], { cwd: inner.dir });
    expect(status.code).toBe(0);
    expect(status.out).toContain(inner.paths.socket);

    const stopped = await cli(["daemon", "stop"], { cwd: inner.dir });
    expect(stopped.code).toBe(0);
    await waitFor(() => !pidAlive(pid), "the inner workspace's service to be reaped");
    expect((await cli(["daemon", "status"], { cwd: outer.dir })).code).toBe(0);
  });

  it("names what to do when there is no workspace and no daemon either", async () => {
    const ws = createEmptyDir();
    const result = await cli(["daemon", "status"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.out).toContain("not running");
    expect(result.err).toContain("no u8.jsonc");
    expect(result.err).toContain("u8 init");
    expect(fs.existsSync(ws.paths.dir)).toBe(false);
  });
});
