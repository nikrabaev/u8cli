/**
 * Harness for the daemon integration tests.
 *
 * Everything here is real: a workspace on disk, a daemon in its own process, a
 * unix socket, and services that are actual shells. The only thing faked is the
 * clock budget — idle timeouts and log caps are shrunk through config and env.
 *
 * The state home is set once per worker, so every workspace lands in its own
 * hash-derived state dir exactly as it would in production.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDaemon, type EnsureDaemonOptions } from "../../src/daemon/launch.js";
import { createRpcClient, type RpcClient } from "../../src/ipc/index.js";
import type { RpcNotification, RpcNotificationPayload } from "../../src/ipc/protocol.js";
import { statePaths, type StatePaths } from "../../src/util/paths.js";

/** One state home per worker; each workspace still gets its own subdirectory. */
const STATE_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-state-")));
process.env.U8_STATE_HOME = STATE_HOME;

/**
 * A daemon left over from a failed test must not outlive it by ten minutes, so
 * every daemon these tests spawn gets a short idle timeout as a backstop. Tests
 * that assert on idle exit pass their own, much shorter, value.
 */
const BACKSTOP_IDLE_MS = 20_000;

const workspaces: string[] = [];
const daemons: StatePaths[] = [];
const clients: RpcClient[] = [];

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll-until-condition; never a bare sleep, and it fails loudly on timeout. */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(10);
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

export async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(10);
  }
  return !pidAlive(pid);
}

// ---------------------------------------------------------------------------
// Fixture workspaces
// ---------------------------------------------------------------------------

/** Idles until signalled, after announcing itself on both streams. */
export const SERVICE_SCRIPT = "printf 'ready\\n'; printf 'booting\\n' >&2; while true; do sleep 0.05; done";

/** Idles, but writes a marker file first so a test can prove it really ran. */
export function markerService(marker: string): string {
  return `printf 'ready\\n'; printf '%s\\n' "$$" > '${marker}'; while true; do sleep 0.05; done`;
}

export interface Workspace {
  dir: string;
  configPath: string;
  paths: StatePaths;
  /** Rewrites `u8.jsonc` in place — the input to a `workspace.reload`. */
  rewrite(config: object): void;
  file(rel: string): string;
}

/** The config may be a factory so a fixture can name paths inside its own dir. */
export function createWorkspace(
  config: object | ((dir: string) => object),
  dirs: readonly string[] = [],
): Workspace {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-ws-")));
  workspaces.push(dir);
  for (const rel of dirs) fs.mkdirSync(path.join(dir, rel), { recursive: true });

  const configPath = path.join(dir, "u8.jsonc");
  const write = (value: object): void => {
    fs.writeFileSync(configPath, JSON.stringify(value, null, 2), "utf8");
  };
  write(typeof config === "function" ? config(dir) : config);

  return {
    dir,
    configPath,
    paths: statePaths(configPath),
    rewrite: write,
    file: (rel: string) => path.join(dir, rel),
  };
}

/** The two-service workspace most tests use: `web` depends on `api`. */
export function twoServiceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apps: {
      api: { path: "api", scripts: { start: SERVICE_SCRIPT } },
      web: { path: "web", scripts: { start: SERVICE_SCRIPT }, dependsOn: ["api"] },
    },
    profiles: {
      all: { default: true, targets: ["api", "web"] },
      "api-only": { targets: ["api"] },
    },
    commands: {
      hello: { script: "printf 'hello from %s\\n' \"$(basename \"$PWD\")\"" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Daemons
// ---------------------------------------------------------------------------

export interface StartOptions extends Partial<EnsureDaemonOptions> {
  /** `U8_IDLE_MS` for a daemon this call spawns. */
  idleMs?: number;
}

/** `ensureDaemon` with test defaults, tracked so `cleanup` can tear it down. */
export async function connect(ws: Workspace, opts: StartOptions = {}): Promise<RpcClient> {
  const client = await ensureDaemon({
    configPath: ws.configPath,
    timeoutMs: opts.timeoutMs ?? 15_000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
    logger: opts.logger,
    env: { U8_IDLE_MS: String(opts.idleMs ?? BACKSTOP_IDLE_MS), ...opts.env },
  });
  track(ws, client);
  return client;
}

/** Registers an externally created client/daemon for teardown. */
export function track(ws: Workspace, client?: RpcClient): void {
  if (!daemons.some((p) => p.socket === ws.paths.socket)) daemons.push(ws.paths);
  if (client) clients.push(client);
}

export function daemonPid(ws: Workspace): number | undefined {
  try {
    const pid = Number(fs.readFileSync(ws.paths.pidFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function daemonLog(ws: Workspace): string {
  try {
    return fs.readFileSync(ws.paths.daemonLog, "utf8");
  } catch {
    return "";
  }
}

/** Every notification of one kind, in arrival order. */
export function record<N extends RpcNotification>(
  client: RpcClient,
  name: N,
): Array<RpcNotificationPayload<N>> {
  const seen: Array<RpcNotificationPayload<N>> = [];
  client.on(name, (params) => {
    seen.push(params);
  });
  return seen;
}

/**
 * Stops every daemon a test started, whatever state it left them in: ask
 * politely, then signal, then insist. Called from `afterEach`, so a failing
 * assertion can never leak a daemon or its service tree into the next test.
 */
export async function cleanup(): Promise<void> {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  const crashes: string[] = [];

  for (const paths of daemons.splice(0)) {
    let pid: number | undefined;
    try {
      pid = Number(fs.readFileSync(paths.pidFile, "utf8").trim()) || undefined;
    } catch {
      pid = undefined;
    }

    const stopper = createRpcClient({ socketPath: paths.socket, timeoutMs: 3_000 });
    try {
      await stopper.connect();
      await stopper.request("daemon.stop", {});
    } catch {
      // Already gone, or never came up.
    } finally {
      await stopper.close().catch(() => undefined);
    }

    if (pid !== undefined && !(await waitForPidGone(pid, 3_000))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Raced us to the exit.
      }
    }
    crashes.push(...crashLines(paths.daemonLog));
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }

  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });

  // Applies to every test: a daemon that swallowed a rejection or fell over
  // still answers RPCs, so nothing else in the suite would notice.
  if (crashes.length > 0) {
    throw new Error(`the daemon logged ${crashes.length} fatal event(s):\n${crashes.join("\n")}`);
  }
}

function crashLines(daemonLog: string): string[] {
  try {
    return fs
      .readFileSync(daemonLog, "utf8")
      .split("\n")
      .filter((line) => /unhandled rejection|uncaught exception/i.test(line));
  } catch {
    return [];
  }
}

export function cleanupStateHome(): void {
  fs.rmSync(STATE_HOME, { recursive: true, force: true });
}
