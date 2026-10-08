/**
 * `u8 start|stop|restart` and `u8 run` against real services.
 *
 * The exit code is the contract these tests defend: 0 when every target
 * settled, 1 when any of them failed or was aborted. Everything printed is a
 * courtesy; a CI job reads the code.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StatusJson, StatusJsonApp } from "../../src/cli/status.js";
import {
  cleanup,
  cleanupStateHome,
  cli,
  createWorkspace,
  fixtureConfig,
  fixtureDirs,
  pidAlive,
  startCli,
  waitFor,
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

async function app(id: string): Promise<StatusJsonApp> {
  const result = await cli(["status", "--json"], { cwd: ws.dir });
  expect(result.code).toBe(0);
  const json = JSON.parse(result.out) as StatusJson;
  const found = json.repos.flatMap((r) => r.apps).find((a) => a.id === id);
  if (!found) throw new Error(`no app "${id}" in the status output`);
  return found;
}

/**
 * A freshly spawned service is `starting` until it survives the supervisor's
 * grace window (SPEC §5.3), and `u8 start` answers as soon as the process
 * exists — so "is it up?" is a poll, not a single read.
 */
async function settledAs(id: string, status: string): Promise<StatusJsonApp> {
  let state: StatusJsonApp | undefined;
  await waitFor(async () => {
    state = await app(id);
    return state.status === status;
  }, `${id} to be ${status}`);
  if (!state) throw new Error("unreachable");
  return state;
}

describe("start / stop / restart", () => {
  it("starts a target, reports it running, and stops it again", async () => {
    const started = await cli(["start", "api"], { cwd: ws.dir });
    expect(started.code).toBe(0);
    expect(started.out).toContain("api");
    expect(started.out).toContain("ok");
    // A per-target progress line *and* a summary table.
    expect(started.out).toContain("TARGET");
    expect(started.out).toContain("app:start: 1 ok");

    const running = await settledAs("api", "running");
    expect(running.pid).not.toBeNull();
    expect(pidAlive(running.pid ?? 0)).toBe(true);

    const stopped = await cli(["stop", "api"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    await settledAs("api", "stopped");
    expect(pidAlive(running.pid ?? 0)).toBe(false);
  });

  it("restart replaces the process", async () => {
    await cli(["start", "api"], { cwd: ws.dir });
    const first = await settledAs("api", "running");

    const restarted = await cli(["restart", "api"], { cwd: ws.dir });
    expect(restarted.code).toBe(0);

    const second = await settledAs("api", "running");
    expect(second.pid).not.toBe(first.pid);

    await cli(["stop", "api"], { cwd: ws.dir });
  });

  it("--all covers every target in the workspace", async () => {
    const started = await cli(["start", "--all"], { cwd: ws.dir });
    expect(started.code).toBe(0);
    for (const id of ["api", "platform.web", "platform.admin"]) {
      expect(started.out).toContain(id);
      await settledAs(id, "running");
    }

    const status = await cli(["status"], { cwd: ws.dir });
    expect(status.out).toContain("3/3 running");

    const stopped = await cli(["stop", "--all"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    await settledAs("platform.web", "stopped");
  });

  it("refuses --all together with explicit targets", async () => {
    const result = await cli(["start", "--all", "api"], { cwd: ws.dir });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--all cannot be combined with explicit targets");
  });

  it("names an unknown target", async () => {
    const result = await cli(["start", "nope"], { cwd: ws.dir });
    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown target "nope"');
  });
});

describe("run", () => {
  it("runs a command everywhere and exits 0", async () => {
    const result = await cli(["run", "greet"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("greet: 3 ok");
    for (const id of ["api", "platform.web", "platform.admin"]) {
      expect(result.out).toContain(id);
    }
  });

  it("exits 1 when a target fails, and says where the output is", async () => {
    const result = await cli(["run", "flaky"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.out).toContain("failed");
    expect(result.out).toContain("exit 3");
    // The shared script passed on web; admin was excluded with `null`.
    expect(result.out).toContain("ok");
    expect(result.out).toContain("skipped");
    expect(result.err).toContain("u8 logs api --run");
  });

  it("treats a run where everything was skipped as a success", async () => {
    const result = await cli(["run", "flaky", "platform.admin"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("1 skipped");
  });

  it("accepts --serial and --concurrency", async () => {
    const serial = await cli(["run", "greet", "--serial"], { cwd: ws.dir });
    expect(serial.code).toBe(0);
    expect(serial.out).toContain("greet: 3 ok");

    const capped = await cli(["run", "greet", "--concurrency", "1"], { cwd: ws.dir });
    expect(capped.code).toBe(0);
    expect(capped.out).toContain("greet: 3 ok");
  });

  it("detaches on Ctrl-C and leaves the run to the daemon", async () => {
    const run = startCli(["run", "slow", "api"], { cwd: ws.dir });
    await waitFor(() => fs.existsSync(ws.file("api/started")), "the task to start");

    run.interrupt();
    const result = await run.done;
    expect(result.code).toBe(130);
    expect(result.err).toContain("detached");

    // The daemon owns the run (SPEC §5.1): it finishes without its client, and
    // the daemon is still there afterwards.
    await waitFor(() => fs.existsSync(ws.file("api/finished")), "the task to finish anyway");
    expect((await cli(["daemon", "status"], { cwd: ws.dir })).code).toBe(0);
  });

  it("lists the workspace's commands when asked for one that does not exist", async () => {
    const result = await cli(["run", "nope"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown command "nope"');
    expect(result.err).toContain("greet");
  });
});
