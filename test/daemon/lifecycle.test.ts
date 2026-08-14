/**
 * Daemon lifecycle over a real socket: cold spawn, reuse, stale-socket recovery,
 * idle exit, and teardown. Every test drives a daemon in its own process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createDaemon } from "../../src/daemon/daemon.js";
import { runDaemonEntry } from "../../src/daemon/entry.js";
import { daemonEntryPath, ensureDaemon } from "../../src/daemon/launch.js";
import { startRpcServer } from "../../src/ipc/index.js";
import { isU8Error } from "../../src/util/errors.js";
import { nullLogger } from "../../src/util/logger.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonLog,
  daemonPid,
  delay,
  markerService,
  pidAlive,
  record,
  track,
  twoServiceConfig,
  waitFor,
  waitForPidGone,
} from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

/** Running the entry point from TypeScript sources needs the same loader launch.ts uses. */
function jitiArgs(): string[] {
  const require = createRequire(import.meta.url);
  const register = path.join(path.dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs");
  return ["--import", pathToFileURL(register).href];
}

afterAll(() => {
  cleanupStateHome();
});

describe("cold start", () => {
  it("auto-spawns a daemon and answers over the socket", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);

    const client = await connect(ws);
    const pong = await client.request("daemon.ping", {});

    expect(pong.pong).toBe(true);
    expect(pong.protocolVersion).toBe(1);
    expect(fs.existsSync(ws.paths.socket)).toBe(true);

    const pid = daemonPid(ws);
    expect(pid, `no pid file; daemon.log:\n${daemonLog(ws)}`).toBeDefined();
    expect(pidAlive(pid ?? 0)).toBe(true);

    const status = await client.request("daemon.status", {});
    expect(status.pid).toBe(pid);
    expect(status.workspaceId).toBe(ws.paths.id);
    expect(status.runningServices).toBe(0);
  });

  it("a second client reuses the running daemon", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);

    const first = await connect(ws);
    const firstStatus = await first.request("daemon.status", {});
    const second = await connect(ws);
    const secondStatus = await second.request("daemon.status", {});

    expect(secondStatus.pid).toBe(firstStatus.pid);
    expect(secondStatus.clients).toBe(2);
    expect(secondStatus.uptimeMs).toBeGreaterThanOrEqual(firstStatus.uptimeMs);
  });

  it("reports a startup failure quickly, pointing at the daemon log", async () => {
    // `path` is required, so this workspace cannot normalize.
    const ws = createWorkspace({ apps: { api: {} } });

    const startedAt = Date.now();
    const failure = await ensureDaemon({ configPath: ws.configPath, timeoutMs: 10_000 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    const elapsed = Date.now() - startedAt;

    expect(isU8Error(failure)).toBe(true);
    expect((failure as Error).message).toContain(ws.paths.daemonLog);
    // The child is dead; waiting out the full deadline would stall every CLI call.
    expect(elapsed).toBeLessThan(5_000);
    expect(daemonLog(ws)).toContain("path");
  });

  it("refuses to start a second daemon for the same workspace", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws);
    const pid = daemonPid(ws);

    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let code: number;
    try {
      // `--foreground` keeps this (the vitest worker) writing to its own stderr.
      code = await runDaemonEntry(["--config", ws.configPath, "--foreground"]);
    } finally {
      process.stderr.write = original;
    }

    expect(code).toBe(1);
    expect(errors.join("")).toContain("DAEMON_ALREADY_RUNNING");
    // The incumbent is untouched.
    expect(daemonPid(ws)).toBe(pid);
    expect((await client.request("daemon.ping", {})).pong).toBe(true);
  });

  it("appends its own output to daemon.log even when its stdio is discarded", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    track(ws);
    fs.mkdirSync(ws.paths.dir, { recursive: true });
    fs.writeFileSync(ws.paths.daemonLog, "previous run\n", "utf8");

    // Nothing is inherited here: whatever reaches the log is the daemon's own
    // redirect, which is what a hand-started daemon depends on.
    const child = spawn(
      process.execPath,
      [...jitiArgs(), daemonEntryPath(), "--config", ws.configPath],
      { detached: true, stdio: "ignore", env: { ...process.env, U8_IDLE_MS: "20000" } },
    );
    child.unref();

    try {
      await waitFor(() => daemonLog(ws).includes("listening on"), "the daemon to log its start", 15_000);
      const log = daemonLog(ws);
      expect(log.startsWith("previous run")).toBe(true); // appended, never truncated
      expect(log).toContain("daemon starting");
    } finally {
      if (child.pid !== undefined) process.kill(child.pid, "SIGTERM");
    }
  });

  it("rejects a daemon speaking a different protocol version", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    fs.mkdirSync(ws.paths.dir, { recursive: true });
    const impostor = await startRpcServer({
      socketPath: ws.paths.socket,
      handlers: {
        "daemon.ping": () => ({ pong: true as const, version: "9.9.9", protocolVersion: 99 }),
      },
    });

    try {
      const failure = await ensureDaemon({ configPath: ws.configPath, timeoutMs: 5_000 }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(isU8Error(failure) && failure.code).toBe("DAEMON_VERSION_MISMATCH");
      expect((failure as Error).message).toContain("u8 daemon stop");
    } finally {
      await impostor.close();
    }
  });
});

describe("stale socket recovery", () => {
  it("reclaims a socket left behind by a SIGKILLed daemon", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const first = await connect(ws);
    const firstPid = daemonPid(ws);
    expect(firstPid).toBeDefined();

    process.kill(firstPid ?? 0, "SIGKILL");
    expect(await waitForPidGone(firstPid ?? 0)).toBe(true);
    await first.close();
    // The corpse's socket file is still on disk — that is the whole problem.
    expect(fs.existsSync(ws.paths.socket)).toBe(true);

    const second = await connect(ws);
    const secondPid = daemonPid(ws);

    expect(secondPid).toBeDefined();
    expect(secondPid).not.toBe(firstPid);
    expect((await second.request("daemon.ping", {})).pong).toBe(true);
  });
});

describe("idle exit", () => {
  it("exits once the last client leaves and nothing is running", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws, { idleMs: 300 });
    const pid = daemonPid(ws);
    expect(pid).toBeDefined();

    const status = await client.request("daemon.status", {});
    // Armed only when nothing is connected, and this client is.
    expect(status.idleExitInMs).toBeNull();

    await client.close();

    expect(await waitForPidGone(pid ?? 0, 4_000)).toBe(true);
    expect(fs.existsSync(ws.paths.socket)).toBe(false);
    expect(fs.existsSync(ws.paths.pidFile)).toBe(false);
  });

  it("stays up while a service is running, even with no clients", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    const client = await connect(ws, { idleMs: 300 });
    await client.request("client.attach", { clientVersion: "test" });

    const run = await client.request("service.start", { targets: ["api"] });
    await client.request("run.await", { runId: run.runId });
    await client.close();

    // Nothing to poll for here — the assertion is that nothing happens. Three
    // idle windows is long enough for a broken idle predicate to fire.
    await delay(1_000);

    const pid = daemonPid(ws);
    expect(pid).toBeDefined();
    expect(pidAlive(pid ?? 0)).toBe(true);
  });
});

describe("programmatic daemon", () => {
  it("shuts down once, however many callers ask", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    track(ws);
    const daemon = createDaemon({ configPath: ws.configPath, logger: nullLogger, idleMs: 0 });

    await daemon.start();
    expect(daemon.status().pid).toBe(process.pid);
    expect(daemon.status().idleExitInMs).toBeNull(); // idleMs 0 disables idle exit
    expect(daemon.snapshot().workspace.id).toBe(ws.paths.id);
    expect(fs.existsSync(ws.paths.socket)).toBe(true);

    // Reachable from an RPC, a signal and the idle timer at the same moment.
    await Promise.all([daemon.shutdown("first"), daemon.shutdown("second")]);
    await expect(daemon.stopped).resolves.toBe("first");
    await daemon.shutdown("third"); // and again, afterwards

    expect(fs.existsSync(ws.paths.socket)).toBe(false);
  });

  it("starting twice is a no-op rather than a second bind", async () => {
    const ws = createWorkspace(twoServiceConfig(), ["api", "web"]);
    track(ws);
    const daemon = createDaemon({ configPath: ws.configPath, logger: nullLogger, idleMs: 0 });
    try {
      await daemon.start();
      await daemon.start();
      expect(fs.existsSync(ws.paths.socket)).toBe(true);
    } finally {
      await daemon.shutdown("test over");
    }
  });
});

describe("shutdown", () => {
  it("daemon.stop tears down the service tree", async () => {
    // The service records its own pid, so the assertion is about the real child.
    const ws = createWorkspace(
      (dir) => ({
        apps: { api: { path: "api", scripts: { start: markerService(`${dir}/api.pid`) } } },
        profiles: { all: { default: true, targets: ["api"] } },
      }),
      ["api"],
    );

    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    await waitFor(() => fs.existsSync(ws.file("api.pid")), "the service to record its pid");
    const servicePid = Number(fs.readFileSync(ws.file("api.pid"), "utf8").trim());
    expect(pidAlive(servicePid)).toBe(true);

    const shutdowns = record(client, "daemon.shutdown");
    await client.request("daemon.stop", {});

    const daemon = daemonPid(ws);
    expect(await waitForPidGone(daemon ?? 0, 5_000)).toBe(true);
    expect(await waitForPidGone(servicePid, 5_000)).toBe(true);
    expect(shutdowns.map((s) => s.reason)).toContain("daemon.stop");
    expect(fs.existsSync(ws.paths.socket)).toBe(false);
  });
});
