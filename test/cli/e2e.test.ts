/**
 * The real binary, spawned as a child process, against a real workspace.
 *
 * The in-process tests cover the surface; these cover the two things only a
 * separate process can prove: that the shipped entry point works end to end
 * (argv → daemon → exit code), and that Ctrl-C means "detach me", not "kill the
 * stack" (SPEC §5.1).
 */
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StatusJson } from "../../src/cli/status.js";
import {
  binCommand,
  cleanup,
  cleanupStateHome,
  createWorkspace,
  pidAlive,
  runBin,
  service,
  startBin,
  waitFor,
  type Workspace,
} from "./helpers.js";

let ws: Workspace;

const TICKER = "while true; do printf 'tick\\n'; sleep 0.05; done";

beforeAll(() => {
  ws = createWorkspace(
    {
      name: "e2e",
      apps: {
        api: { path: "api", scripts: { start: service("api-ready") } },
        ticker: { path: "ticker", scripts: { start: TICKER } },
      },
      commands: { boom: { targets: { api: "printf 'nope\\n' >&2; exit 7" } } },
      profiles: { all: { default: true, targets: ["api", "ticker"] } },
    },
    ["api", "ticker"],
  );
});

afterAll(async () => {
  await cleanup();
  cleanupStateHome();
});

async function statusJson(): Promise<StatusJson> {
  const result = await runBin(["status", "--json"], { cwd: ws.dir });
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as StatusJson;
}

describe("the u8 binary", () => {
  it("drives a workspace from a cold start to a stopped stack", async () => {
    // Cold: no daemon yet, so this invocation has to spawn one.
    const cold = await runBin(["status"], { cwd: ws.dir });
    expect(cold.code).toBe(0);
    expect(cold.out).toContain("api");
    // stdout is a pipe here, exactly as in CI: not one escape byte.
    expect(cold.out).not.toContain("[");

    const started = await runBin(["start", "api"], { cwd: ws.dir });
    expect(started.code).toBe(0);

    let pid = 0;
    await waitFor(async () => {
      const api = (await statusJson()).apps.flatMap((a) => a.subapps).find((s) => s.id === "api");
      pid = api?.pid ?? 0;
      return api?.status === "running";
    }, "api to be running");
    expect(pidAlive(pid)).toBe(true);

    const logs = await runBin(["logs", "api", "-n", "20"], { cwd: ws.dir });
    expect(logs.code).toBe(0);
    expect(logs.out).toContain("api-ready");

    // A failing target is a failing run, which is the whole point in CI.
    const failed = await runBin(["run", "boom"], { cwd: ws.dir });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("exit 7");

    const stopped = await runBin(["stop", "api"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    await waitFor(() => !pidAlive(pid), "the service process to be gone");

    const down = await runBin(["daemon", "stop"], { cwd: ws.dir });
    expect(down.code).toBe(0);
    expect((await runBin(["daemon", "status"], { cwd: ws.dir })).code).toBe(1);
  });

  it("ends quietly when its output pipe is closed early", async () => {
    const { command, args } = binCommand();
    const quoted = [command, ...args, "status"].map((part) => `'${part}'`).join(" ");
    const piped = await new Promise<{ code: number | null; err: string }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", `${quoted} | head -1`], {
        cwd: ws.dir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, err }));
    });

    expect(piped.code).toBe(0);
    expect(piped.err).not.toContain("EPIPE");
    expect(piped.err).not.toContain("    at ");
  });

  it("detaches on Ctrl-C during a follow, leaving the daemon and services up", async () => {
    expect((await runBin(["start", "ticker"], { cwd: ws.dir })).code).toBe(0);
    let pid = 0;
    await waitFor(async () => {
      const ticker = (await statusJson()).apps.flatMap((s) => s.subapps).find((s) => s.id === "ticker");
      pid = ticker?.pid ?? 0;
      return ticker?.status === "running";
    }, "the ticker to be running");

    const follow = startBin(["logs", "ticker", "--follow"], { cwd: ws.dir });
    await waitFor(() => follow.stdout().includes("tick"), "streamed output");
    const seen = follow.stdout().length;
    await waitFor(() => follow.stdout().length > seen, "a line pushed while following");

    follow.child.kill("SIGINT");
    const result = await follow.result;
    // Exited with a code of its own rather than dying from the signal: the
    // binary handled Ctrl-C, which is what lets it detach instead of vanishing.
    expect(result.signal).toBeNull();
    expect(result.code).toBe(130);

    // The daemon and the service it owns are untouched by the client's exit.
    expect(pidAlive(pid)).toBe(true);
    const status = await runBin(["daemon", "status"], { cwd: ws.dir });
    expect(status.code).toBe(0);
    expect(status.out).toContain("1 running");

    const ticker = (await statusJson()).apps.flatMap((a) => a.subapps).find((s) => s.id === "ticker");
    expect(ticker?.status).toBe("running");
    expect(ticker?.pid).toBe(pid);
  });
});
