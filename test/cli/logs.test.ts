/**
 * `u8 logs <target> [-f] [-n N] [--run <runId>]`.
 *
 * Backfill, live follow, the target prefix, and what Ctrl-C does to a follow —
 * all against a real service writing to a real log file in the state dir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StatusJson } from "../../src/cli/status.js";

import {
  cleanup,
  cleanupStateHome,
  cli,
  createWorkspace,
  service,
  startCli,
  waitFor,
  type Workspace,
} from "./helpers.js";

let ws: Workspace;

const TICKER = "while true; do printf 'tick\\n'; sleep 0.05; done";

beforeAll(async () => {
  ws = createWorkspace(
    {
      name: "logs-fixture",
      repos: {
        api: { path: "api", scripts: { start: service("api-ready") } },
        ticker: { path: "ticker", scripts: { start: TICKER } },
        platform: {
          path: "platform",
          apps: {
            web: { path: "web", scripts: { start: service("web-ready") } },
            admin: { path: "admin", scripts: { start: service("admin-ready") } },
          },
        },
      },
      commands: { greet: { script: "printf 'hello from %s\\n' \"$(basename \"$PWD\")\"" } },
      profiles: { all: { default: true, targets: ["api", "ticker", "platform"] } },
    },
    ["api", "ticker", "platform/web", "platform/admin"],
  );
  const started = await cli(["start", "--all"], { cwd: ws.dir });
  expect(started.code).toBe(0);
});

afterAll(async () => {
  await cleanup();
  cleanupStateHome();
});

/** The backfill, polled until the line a service prints at startup shows up. */
async function backfill(argv: readonly string[], expected: string): Promise<string> {
  let out = "";
  await waitFor(async () => {
    const result = await cli(argv, { cwd: ws.dir });
    expect(result.code).toBe(0);
    out = result.out;
    return out.includes(expected);
  }, `"${expected}" in the output of u8 ${argv.join(" ")}`);
  return out;
}

describe("backfill", () => {
  it("prints a service's captured stdout and stderr, unprefixed and unstyled", async () => {
    const out = await backfill(["logs", "api", "-n", "50"], "api-ready");

    expect(out).toContain("api-ready-err");
    expect(out).not.toContain("api |");
    expect(out).not.toContain("[");
  });

  it("prefixes every line when a target expands to more than one app", async () => {
    const out = await backfill(["logs", "platform"], "web-ready");

    await waitFor(async () => (await cli(["logs", "platform"], { cwd: ws.dir })).out.includes("admin-ready"), "admin's log");
    expect(out).toContain("platform.web |");
  });

  it("skips the backfill entirely with -n 0", async () => {
    const result = await cli(["logs", "api", "-n", "0"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toBe("");
  });

  it("says so, on stderr, when a target has never written a line", async () => {
    const idle = createWorkspace({ repos: { never: { path: "." } } });
    const result = await cli(["logs", "never"], { cwd: idle.dir });

    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain("no log lines");
  });

  it("reads a task run's log with --run", async () => {
    const run = await cli(["run", "greet", "api"], { cwd: ws.dir });
    expect(run.code).toBe(0);
    const runId = /\(run ([^)]+)\)/.exec(run.out)?.[1];
    expect(runId).toBeDefined();

    const logs = await cli(["logs", "api", "--run", runId ?? ""], { cwd: ws.dir });
    expect(logs.code).toBe(0);
    expect(logs.out).toContain("hello from api");
  });

  it("de-duplicates the known targets when the one asked for does not exist", async () => {
    const result = await cli(["logs", "nope"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown target "nope"');
    expect(result.err).toContain("known: api, ticker, platform, platform.web, platform.admin");
  });
});

describe("--follow", () => {
  it("keeps streaming until interrupted, then leaves everything running", async () => {
    const follow = startCli(["logs", "ticker", "-f", "-n", "5"], { cwd: ws.dir });

    await waitFor(() => follow.stdout().includes("tick"), "the backfill");
    const seen = follow.stdout().length;
    // Growth after the backfill is the proof that the push stream is live.
    await waitFor(() => follow.stdout().length > seen, "a line pushed while following");

    follow.interrupt();
    const result = await follow.done;
    // 128 + SIGINT: the shell convention for "the user stopped it".
    expect(result.code).toBe(130);

    // Ctrl-C detached the CLI; it did not touch the daemon or its services.
    const status = await cli(["daemon", "status"], { cwd: ws.dir });
    expect(status.code).toBe(0);
    // Polled, not read once: a service is `starting` until it outlives the
    // supervisor's grace window, which says nothing about the interrupt.
    await waitFor(async () => {
      const rows = await cli(["status", "--json"], { cwd: ws.dir });
      const apps = (JSON.parse(rows.out) as StatusJson).repos.flatMap((r) => r.apps);
      return apps.find((a) => a.id === "ticker")?.status === "running";
    }, "the ticker to still be running after the interrupt");
  });
});
