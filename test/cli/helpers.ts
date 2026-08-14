/**
 * Harness for the CLI tests.
 *
 * Two ways to drive `u8`, and the difference matters:
 *
 *  - {@link cli} calls `run(argv, io)` **in this process** with captured streams.
 *    That is the fast path and covers everything about argv, output and exit
 *    codes — the daemon it talks to is still a real detached process on a real
 *    socket, so nothing about the behaviour is simulated.
 *  - {@link runBin} spawns the actual entry point with node, which is the only
 *    way to test what a signal does to the binary.
 *
 * Everything else here exists to keep those honest: one state home per worker,
 * real workspaces in tmpdirs, and a teardown that stops every daemon a test
 * caused to exist — including the ones the CLI auto-spawned behind its back.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../../src/cli/run.js";
import type { CliIo } from "../../src/cli/io.js";
import { createRpcClient } from "../../src/ipc/index.js";
import { statePaths, type StatePaths } from "../../src/util/paths.js";

/** One state home per worker; each workspace still gets its own hashed subdir. */
const STATE_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-cli-state-")));
process.env.U8_STATE_HOME = STATE_HOME;

/**
 * Backstop for daemons the CLI spawns on its own: they inherit this process's
 * environment, and a leaked one must not sit on a socket for ten minutes. Tests
 * are far shorter than this, so it never fires mid-test.
 */
process.env.U8_IDLE_MS = "20000";

/** Deterministic colour decisions: the CLI reads these from the *injected* env. */
delete process.env.FORCE_COLOR;

const workspaces: Workspace[] = [];

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll-until-condition; never a bare sleep, and it fails loudly on timeout. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(20);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Fixture workspaces
// ---------------------------------------------------------------------------

/** Announces itself on both streams, then idles until it is signalled. */
export function service(marker: string): string {
  return `printf '%s\\n' '${marker}'; printf '%s-err\\n' '${marker}' >&2; while true; do sleep 0.05; done`;
}

export interface Workspace {
  dir: string;
  configPath: string;
  paths: StatePaths;
  file(rel: string): string;
  rewrite(config: object): void;
}

/** A workspace on disk. The config may be a factory needing the dir's path. */
export function createWorkspace(
  config: object | ((dir: string) => object),
  dirs: readonly string[] = [],
): Workspace {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-cli-ws-")));
  for (const rel of dirs) fs.mkdirSync(path.join(dir, rel), { recursive: true });

  const configPath = path.join(dir, "u8.jsonc");
  const write = (value: object): void => {
    fs.writeFileSync(configPath, JSON.stringify(value, null, 2), "utf8");
  };
  write(typeof config === "function" ? config(dir) : config);

  const ws: Workspace = {
    dir,
    configPath,
    paths: statePaths(configPath),
    file: (rel: string) => path.join(dir, rel),
    rewrite: write,
  };
  workspaces.push(ws);
  return ws;
}

/** An empty directory, for the cases that must run without a workspace at all. */
export function createEmptyDir(): Workspace {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-cli-empty-")));
  const configPath = path.join(dir, "u8.jsonc");
  const ws: Workspace = {
    dir,
    configPath,
    paths: statePaths(configPath),
    file: (rel: string) => path.join(dir, rel),
    rewrite: () => {
      throw new Error("this fixture has no config");
    },
  };
  workspaces.push(ws);
  return ws;
}

/**
 * The workspace most tests drive: one single-subapp app (`api`, a merged row)
 * and one two-subapp app (`platform`), plus commands that pass, fail and skip.
 */
export function fixtureConfig(): Record<string, unknown> {
  return {
    name: "fixture",
    templates: {
      app: "APP {app@name:pad(10)}{git@branch}",
      subapp: "SUB {app@name:pad(10)} {app@status} {x@ver}",
    },
    indicators: { ver: { cmd: "printf 1.2.3", interval: 60_000 } },
    apps: {
      api: { path: "api", scripts: { start: service("api-ready") } },
      platform: {
        path: "platform",
        subapps: {
          web: { path: "web", scripts: { start: service("web-ready") } },
          admin: { path: "admin", scripts: { start: service("admin-ready") } },
        },
      },
    },
    profiles: {
      all: { default: true, targets: ["api", "platform"] },
      frontend: { targets: ["platform.web"] },
    },
    commands: {
      greet: { script: "printf 'hello from %s\\n' \"$(basename \"$PWD\")\"" },
      flaky: {
        script: "printf 'ok\\n'",
        targets: { api: "printf 'boom\\n' >&2; exit 3", "platform.admin": null },
      },
      // Announces that it started and, a beat later, that it finished — so a
      // test can interrupt it mid-flight and then prove it ran to completion
      // without the client that launched it.
      slow: { targets: { api: "printf x > started; sleep 1; printf x > finished" } },
    },
  };
}

export function fixtureDirs(): string[] {
  return ["api", "platform/web", "platform/admin"];
}

// ---------------------------------------------------------------------------
// In-process CLI
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /**
   * The signal that killed the process, for {@link runBin}/{@link startBin}
   * only. `null` means it chose its own exit code — which is the difference
   * between a CLI that *handles* Ctrl-C and one that merely dies from it.
   */
  signal?: NodeJS.Signals | null;
}

export interface CliOptions {
  cwd?: string;
  /** The *injected* env; deliberately empty by default so colour is decided here. */
  env?: Record<string, string>;
  /** Whether stdout is a terminal, which is the colour default. */
  tty?: boolean;
  signal?: AbortSignal;
}

class Capture {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function makeIo(opts: CliOptions, out: Capture, err: Capture): CliIo {
  return {
    stdout: out,
    stderr: err,
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? {},
    tty: opts.tty === true,
    signal: opts.signal,
  };
}

/** `u8 <argv>` in this process. Resolves with the exit code and both streams. */
export async function cli(argv: readonly string[], opts: CliOptions = {}): Promise<CliResult> {
  const out = new Capture();
  const err = new Capture();
  const code = await run(argv, makeIo(opts, out, err));
  return { code, out: out.text, err: err.text };
}

export interface RunningCli {
  stdout(): string;
  stderr(): string;
  /** What Ctrl-C does to a streaming command: aborts the io signal. */
  interrupt(): void;
  done: Promise<CliResult>;
}

/** A CLI invocation that is expected to keep running until it is interrupted. */
export function startCli(argv: readonly string[], opts: CliOptions = {}): RunningCli {
  const out = new Capture();
  const err = new Capture();
  const controller = new AbortController();
  const done = run(argv, makeIo({ ...opts, signal: controller.signal }, out, err)).then((code) => ({
    code,
    out: out.text,
    err: err.text,
  }));
  return {
    stdout: () => out.text,
    stderr: () => err.text,
    interrupt: () => controller.abort(),
    done,
  };
}

// ---------------------------------------------------------------------------
// The real binary
// ---------------------------------------------------------------------------

/**
 * `node [--import jiti] src/cli/main.ts` — the same trick the daemon launcher
 * uses to run TypeScript sources without a build step, so the end-to-end tests
 * exercise the shipped entry point rather than a compiled copy of it.
 */
export function binCommand(): { command: string; args: string[] } {
  const entry = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const require = createRequire(import.meta.url);
  const register = path.join(path.dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs");
  return { command: process.execPath, args: ["--import", register, entry] };
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

export function spawnCli(argv: readonly string[], opts: SpawnOptions): ChildProcess {
  const { command, args } = binCommand();
  return spawn(command, [...args, ...argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Spawns the binary and waits for it to exit. */
export async function runBin(argv: readonly string[], opts: SpawnOptions): Promise<CliResult> {
  const child = spawnCli(argv, opts);
  return collect(child).result;
}

export interface RunningBin {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  result: Promise<CliResult>;
}

/** Spawns the binary and streams its output as it arrives. */
export function startBin(argv: readonly string[], opts: SpawnOptions): RunningBin {
  return collect(spawnCli(argv, opts));
}

function collect(child: ChildProcess): RunningBin {
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    err += chunk;
  });
  const result = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A killed process has no exit code; 128+n is what a shell would report.
      resolve({ code: code ?? (signal === "SIGINT" ? 130 : 1), out, err, signal });
    });
  });
  return { child, stdout: () => out, stderr: () => err, result };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Stops every daemon these tests caused to exist and removes the workspaces.
 *
 * The CLI spawns daemons implicitly, so this cannot be driven off a list of
 * daemons a test started — it walks the workspaces instead and asks whoever is
 * on each socket to stop, then insists.
 */
export async function cleanup(): Promise<void> {
  for (const ws of workspaces.splice(0)) {
    const pid = readPid(ws.paths.pidFile);
    const client = createRpcClient({ socketPath: ws.paths.socket, timeoutMs: 3_000 });
    try {
      await client.connect();
      await client.request("daemon.stop", {});
    } catch {
      // Already gone, or never came up.
    } finally {
      await client.close().catch(() => undefined);
    }

    if (pid !== undefined) {
      const deadline = Date.now() + 3_000;
      while (pidAlive(pid) && Date.now() < deadline) await delay(20);
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Raced us to the exit.
        }
      }
    }
    fs.rmSync(ws.paths.dir, { recursive: true, force: true });
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
}

export function cleanupStateHome(): void {
  fs.rmSync(STATE_HOME, { recursive: true, force: true });
}

function readPid(pidFile: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
