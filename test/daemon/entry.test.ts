/**
 * Unit cover for the two pure decisions the daemon process makes before it
 * exists: how it reads its argv, and where its idle timeout comes from — plus
 * one integration test for the third thing it owns, its signal disposition.
 *
 * Importing this module must not start a daemon — that it does not is itself
 * part of what these tests assert.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveIdleMs } from "../../src/daemon/daemon.js";
import { parseEntryArgs, runDaemonEntry } from "../../src/daemon/entry.js";
import { daemonEntryPath } from "../../src/daemon/launch.js";
import { nullLogger, type Logger } from "../../src/util/logger.js";
import { statePaths, type StatePaths } from "../../src/util/paths.js";

const previousIdle = process.env.U8_IDLE_MS;

afterEach(() => {
  if (previousIdle === undefined) delete process.env.U8_IDLE_MS;
  else process.env.U8_IDLE_MS = previousIdle;
});

function warnCollector(sink: string[]): Logger {
  return { ...nullLogger, warn: (msg: string) => sink.push(msg), child: () => warnCollector(sink) };
}

describe("parseEntryArgs", () => {
  it("reads the config in both spellings", () => {
    expect(parseEntryArgs(["--config", "/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
    expect(parseEntryArgs(["--config=/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
    expect(parseEntryArgs(["-c", "/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
  });

  it("defaults to discovery and foreground off", () => {
    expect(parseEntryArgs([])).toEqual({ foreground: false });
  });

  it("reads the idle override and the foreground switch", () => {
    expect(parseEntryArgs(["--idle-ms", "300", "--foreground"])).toEqual({
      idleMs: 300,
      foreground: true,
    });
  });

  it("refuses arguments it does not understand", () => {
    expect(() => parseEntryArgs(["--nope"])).toThrow(/unknown daemon argument/);
    expect(() => parseEntryArgs(["--config"])).toThrow(/requires a value/);
    expect(() => parseEntryArgs(["--idle-ms", "soon"])).toThrow(/must be a number/);
  });
});

describe("resolveIdleMs", () => {
  it("prefers the explicit override over env and config", () => {
    process.env.U8_IDLE_MS = "1000";
    expect(resolveIdleMs(250, 600_000, nullLogger)).toBe(250);
  });

  it("prefers the environment over the workspace limit", () => {
    process.env.U8_IDLE_MS = "1000";
    expect(resolveIdleMs(undefined, 600_000, nullLogger)).toBe(1_000);
  });

  it("falls back to the workspace limit", () => {
    delete process.env.U8_IDLE_MS;
    expect(resolveIdleMs(undefined, 600_000, nullLogger)).toBe(600_000);
  });

  it("warns about a non-numeric environment value instead of disabling idle exit", () => {
    process.env.U8_IDLE_MS = "later";
    const warnings: string[] = [];
    expect(resolveIdleMs(undefined, 600_000, warnCollector(warnings))).toBe(600_000);
    expect(warnings[0]).toContain("U8_IDLE_MS");
  });

  it("clamps and floors, and treats zero as disabled", () => {
    delete process.env.U8_IDLE_MS;
    expect(resolveIdleMs(-5, 600_000, nullLogger)).toBe(0);
    expect(resolveIdleMs(10.9, 600_000, nullLogger)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

const HANDLED = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"] as const;

function handlerCounts(): Record<string, number> {
  return Object.fromEntries(HANDLED.map((event) => [event, process.listenerCount(event)]));
}

describe("process handlers", () => {
  /**
   * The handlers go on before startup, which means they also go on in whatever
   * process called this function — and a caller left holding a SIGTERM handler
   * of ours would stop responding to `kill` altogether.
   */
  it("takes its handlers back off when startup fails", async () => {
    const before = handlerCounts();
    const missing = path.join(os.tmpdir(), `u8-absent-${process.pid}`, "u8.jsonc");

    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const swallow = (() => true) as typeof process.stdout.write;
    process.stdout.write = swallow;
    process.stderr.write = swallow;
    let code: number;
    try {
      // `--foreground`: no redirect, so the failure lands on this worker's own
      // streams — silenced here rather than printed by every run of the suite.
      code = await runDaemonEntry(["--config", missing, "--foreground"]);
      code = await runDaemonEntry(["--config", missing, "--foreground"]);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }

    expect(code).toBe(1);
    expect(handlerCounts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Signals during startup
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(10);
  }
}

/** Running from source, the entry point is TypeScript and needs jiti — as `spawnDaemon` does. */
function nodeArgsFor(entry: string): string[] {
  if (!entry.endsWith(".ts")) return [];
  const register = path.join(path.dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs");
  return ["--import", pathToFileURL(register).href];
}

/**
 * Opens the write end of a FIFO the moment the daemon opens the read end.
 *
 * `O_NONBLOCK` makes this a probe rather than a wait — it fails with ENXIO until
 * a reader is there — so a successful open is proof that the daemon is parked
 * inside `readFileSync` on its config, and holding the fd keeps it parked.
 */
async function openWriteEnd(file: string, describe: () => string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch {
      if (Date.now() >= deadline) throw new Error(`the daemon never read ${file}: ${describe()}`);
      await delay(10);
    }
  }
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

describe("signals during startup", () => {
  let stateHome: string;
  let workspace: string;
  const children: ChildProcess[] = [];
  /** Write ends of the config FIFOs, closed even when a test fails mid-way. */
  const openFds: number[] = [];

  beforeAll(() => {
    stateHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-entry-state-")));
    process.env.U8_STATE_HOME = stateHome;
  });

  afterAll(() => {
    delete process.env.U8_STATE_HOME;
    fs.rmSync(stateHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const fd of openFds.splice(0)) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already released by the test itself.
      }
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await delay(20);
      }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  interface Parked {
    child: ChildProcess;
    paths: StatePaths;
    /** Resolves once the daemon is blocked reading its config; releases it when called. */
    release(): Promise<void>;
    output(): string;
    exited: Promise<{ code: number | null; signal: string | null }>;
  }

  const CONFIG = JSON.stringify({
    repos: { svc: { path: ".", scripts: { start: "while true; do sleep 0.05; done" } } },
  });

  /**
   * A daemon parked inside startup: its config file is a FIFO, so the read
   * `createDaemon` does blocks until this test feeds it. The window a signal has
   * to land in is therefore ours, not a race against a ~600 ms startup.
   */
  async function parkedDaemon(): Promise<Parked> {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-entry-ws-")));
    const configPath = path.join(workspace, "u8.jsonc");
    const made = spawnSync("mkfifo", [configPath]);
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr?.toString() ?? "unknown error"}`);

    const entry = daemonEntryPath();
    const child = spawn(process.execPath, [...nodeArgsFor(entry), entry, "--config", configPath], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, U8_IDLE_MS: "8000" },
    });
    children.push(child);

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const paths = statePaths(configPath);
    const describe = (): string => `${output}${read(paths.daemonLog)}`;

    const fd = await openWriteEnd(configPath, describe);
    openFds.push(fd);
    return {
      child,
      paths,
      output: describe,
      exited: exitOf(child),
      release: async () => {
        fs.writeSync(fd, CONFIG);
        fs.closeSync(fd);
        openFds.splice(openFds.indexOf(fd), 1);
        await delay(0);
      },
    };
  }

  it("shuts down cleanly for a SIGTERM that arrives before it finished starting", async () => {
    // Blocked on its config: past installing handlers, nowhere near listening.
    const daemon = await parkedDaemon();

    daemon.child.kill("SIGTERM");
    await delay(50); // the signal is pending while startup is still going
    await daemon.release();

    expect(await daemon.exited).toEqual({ code: 0, signal: null });
    expect(read(daemon.paths.daemonLog)).toMatch(/shutting down: SIGTERM/);
    // Nothing for the next launch to reclaim.
    expect(fs.existsSync(daemon.paths.socket)).toBe(false);
    expect(fs.existsSync(daemon.paths.pidFile)).toBe(false);
  });

  it("does the same for SIGINT", async () => {
    const daemon = await parkedDaemon();

    daemon.child.kill("SIGINT");
    await delay(50);
    await daemon.release();

    expect(await daemon.exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(daemon.paths.socket)).toBe(false);
    expect(fs.existsSync(daemon.paths.pidFile)).toBe(false);
  });

  it("still serves a daemon that was never signalled", async () => {
    const daemon = await parkedDaemon();

    await daemon.release();
    await waitFor(
      () => fs.existsSync(daemon.paths.socket) && fs.existsSync(daemon.paths.pidFile),
      `the daemon to finish starting: ${daemon.output()}`,
    );

    daemon.child.kill("SIGTERM");

    expect(await daemon.exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(daemon.paths.socket)).toBe(false);
    expect(fs.existsSync(daemon.paths.pidFile)).toBe(false);
  });
});
