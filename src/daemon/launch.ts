/**
 * Client-side daemon bootstrap — SPEC §5.1, PLAN 5.2.
 *
 * Every `u8` invocation goes through here: connect to the workspace's socket
 * and, if nobody answers, spawn the daemon and wait for it. Three details are
 * what make that safe rather than racy:
 *
 *  - **A refused connect is the spawn signal, not an error.** A socket file left
 *    behind by a killed daemon looks identical to a live one on disk; the IPC
 *    layer reclaims it when the new daemon binds, so the client only has to
 *    distinguish "nobody is listening" (`DAEMON_UNREACHABLE`) from a real fault.
 *  - **The child outlives us.** It is detached, unref'd, and its stdio points at
 *    `daemon.log` from the first byte — including anything Node prints before
 *    the entry point gets to install its own redirect.
 *  - **Attach state is client-side.** The IPC client reconnects, but it does not
 *    replay `client.attach` or the log subscriptions; {@link attach} owns that.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { TargetId } from "../config/types.js";
import { createRpcClient, type RpcClient } from "../ipc/index.js";
import {
  PROTOCOL_VERSION,
  type RpcNotification,
  type RpcNotificationPayload,
  type Snapshot,
} from "../ipc/protocol.js";
import { readLastLines } from "../process/index.js";
import { errorMessage, isU8Error, U8Error } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import { statePaths, type StatePaths } from "../util/paths.js";
import { VERSION } from "../version.js";
import type { Unsubscribe } from "./contracts.js";

/** How long `ensureDaemon` waits for a freshly spawned daemon to answer. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;

/** Gap between connect attempts while waiting for the socket to appear. */
const CONNECT_POLL_MS = 25;

/**
 * How long to keep trying after the spawned daemon has already exited. It will
 * never listen now, but it may have refused to start *because* a daemon spawned
 * by a concurrent client won the socket — and that one is worth connecting to.
 */
const DEAD_CHILD_GRACE_MS = 250;

/** Re-attach backoff after a dropped connection, capped at the last entry. */
const REATTACH_BACKOFF_MS: readonly number[] = [50, 100, 250, 500, 1_000];

/** How many times {@link attach} tries to get back in before giving up. */
const DEFAULT_REATTACH_ATTEMPTS = 6;

/** Lines of `daemon.log` quoted when a launch times out. */
const LOG_TAIL_LINES = 8;

export interface EnsureDaemonOptions {
  /** Path to `u8.jsonc`. Symlink-resolved, so it matches the daemon's state dir. */
  configPath: string;
  logger?: Logger;
  /** Deadline covering spawn + first successful connect. Defaults to 10s. */
  timeoutMs?: number;
  /** Extra environment for a daemon this call spawns (tests pass `U8_IDLE_MS`). */
  env?: Record<string, string>;
  /** Per-request deadline of the returned client; `0` disables it. */
  requestTimeoutMs?: number;
}

/**
 * A connected, version-checked client. Spawns the daemon when the socket is
 * dead or absent, then waits for it to start answering.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<RpcClient> {
  const logger = opts.logger ?? nullLogger;
  const location = resolveLocation(opts.configPath);
  const client = createRpcClient({
    socketPath: location.paths.socket,
    logger,
    timeoutMs: opts.requestTimeoutMs,
  });

  try {
    await connectOrSpawn(client, location, opts);
    await handshake(client, logger);
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

/**
 * Asks whoever owns the socket to identify itself. `undefined` means nobody is
 * home — which is what both `entry.ts` (refuse to start a second daemon) and a
 * `u8 daemon status` want to know.
 */
export async function pingDaemon(
  socketPath: string,
  timeoutMs = 1_000,
): Promise<{ version: string; protocolVersion: number } | undefined> {
  const client = createRpcClient({ socketPath, timeoutMs });
  try {
    await client.connect();
    const pong = await client.request("daemon.ping", {});
    return { version: pong.version, protocolVersion: pong.protocolVersion };
  } catch (err) {
    if (isUnreachable(err)) return undefined;
    throw err;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

export interface AttachOptions extends EnsureDaemonOptions {
  /** Reported to the daemon; defaults to this package's version. */
  clientVersion?: string;
  /** True for the TUI: lets the daemon distinguish a dashboard from a script. */
  interactive?: boolean;
  /** Log targets to subscribe to immediately (and again after a reconnect). */
  subscribe?: readonly TargetId[];
  /** Re-attach attempts after a dropped connection. Defaults to 6. */
  reattachAttempts?: number;
}

export interface AttachedClient {
  readonly client: RpcClient;
  /** The most recent snapshot: from the attach, refreshed on every re-attach. */
  snapshot(): Snapshot;
  subscribe(targetId: TargetId): Promise<void>;
  unsubscribe(targetId: TargetId): Promise<void>;
  on<N extends RpcNotification>(name: N, cb: (params: RpcNotificationPayload<N>) => void): Unsubscribe;
  /** Fires once a dropped connection is attached and re-subscribed again. */
  onReattach(cb: (snapshot: Snapshot) => void): Unsubscribe;
  /** Fires when re-attaching gave up; nothing will arrive after this. */
  onLost(cb: (err: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

/**
 * `ensureDaemon` + `client.attach`, with the reconnect story the transport does
 * not own: the IPC client can re-open a socket, but the daemon has no memory of
 * a connection that died, so the attach and every log subscription are re-sent
 * here. A daemon that died is spawned again; a daemon that announced its own
 * shutdown is waited for, never restarted.
 */
export async function attach(opts: AttachOptions): Promise<AttachedClient> {
  const logger = opts.logger ?? nullLogger;
  const location = resolveLocation(opts.configPath);
  const clientVersion = opts.clientVersion ?? VERSION;
  const attempts = Math.max(1, opts.reattachAttempts ?? DEFAULT_REATTACH_ATTEMPTS);

  const client = createRpcClient({
    socketPath: location.paths.socket,
    logger,
    timeoutMs: opts.requestTimeoutMs,
  });
  const wanted = new Set<TargetId>(opts.subscribe ?? []);
  const reattachCbs = new Set<(snapshot: Snapshot) => void>();
  const lostCbs = new Set<(err: Error) => void>();

  let snapshot: Snapshot;
  let closed = false;
  let recovering = false;
  /**
   * Set by the daemon's own `daemon.shutdown` announcement, which is the only
   * thing that tells a deliberate stop apart from a crash — on the socket the
   * two look identical.
   *
   * It downgrades recovery to connect-only. Spawning here would undo the very
   * thing that was asked for: `u8 daemon stop` (or a SIGTERM) with a dashboard
   * open would report success and get a fresh daemon a second later. Whoever
   * *does* bring one back is still worth re-attaching to, and that clears it.
   */
  let announcedStop = false;

  const sendAttach = async (): Promise<Snapshot> => {
    const next = await client.request("client.attach", { clientVersion, interactive: opts.interactive });
    for (const targetId of wanted) await client.request("logs.subscribe", { targetId });
    snapshot = next;
    return next;
  };

  const recover = async (): Promise<void> => {
    if (recovering || closed) return;
    recovering = true;
    let last: unknown;
    try {
      for (let attempt = 1; attempt <= attempts && !closed; attempt++) {
        await sleepDetached(backoff(attempt));
        if (closed) return;
        try {
          if (announcedStop) await client.connect();
          else await connectOrSpawn(client, location, opts);
          await handshake(client, logger);
          const fresh = await sendAttach();
          announcedStop = false;
          logger.debug(`re-attached after ${attempt} attempt(s)`);
          emit(reattachCbs, fresh, logger);
          return;
        } catch (err) {
          last = err;
          logger.debug(`re-attach attempt ${attempt} failed: ${errorMessage(err)}`);
        }
      }
      if (closed) return;
      const failure = new U8Error(
        "DAEMON_UNREACHABLE",
        announcedStop
          ? `the daemon on ${location.paths.socket} was stopped and nothing took its place after ` +
            `${attempts} attempts — any u8 command starts a new one`
          : `lost the daemon on ${location.paths.socket} and could not re-attach after ${attempts} attempts: ` +
            errorMessage(last),
      );
      logger.warn(failure.message);
      emit(lostCbs, failure, logger);
    } finally {
      recovering = false;
    }
  };

  // Before the first connect, and kept across reconnects: the announcement
  // arrives moments before the socket closes, and missing it is what turns a
  // stop into a respawn.
  const offShutdown = client.on("daemon.shutdown", () => {
    announcedStop = true;
  });

  try {
    await connectOrSpawn(client, location, opts);
    await handshake(client, logger);
    snapshot = await sendAttach();
  } catch (err) {
    offShutdown();
    await client.close().catch(() => undefined);
    throw err;
  }

  client.onClose(() => {
    if (closed) return;
    void recover();
  });

  return {
    client,
    snapshot: () => snapshot,
    async subscribe(targetId: TargetId): Promise<void> {
      wanted.add(targetId);
      await client.request("logs.subscribe", { targetId });
    },
    async unsubscribe(targetId: TargetId): Promise<void> {
      wanted.delete(targetId);
      await client.request("logs.unsubscribe", { targetId });
    },
    on: (name, cb) => client.on(name, cb),
    onReattach: (cb) => subscription(reattachCbs, cb),
    onLost: (cb) => subscription(lostCbs, cb),
    async close(): Promise<void> {
      closed = true;
      offShutdown();
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Connect / spawn
// ---------------------------------------------------------------------------

/** The symlink-resolved config path and the state dir derived from it. */
interface DaemonLocation {
  configPath: string;
  paths: StatePaths;
}

function resolveLocation(configPath: string): DaemonLocation {
  let real: string;
  try {
    real = fs.realpathSync(configPath);
  } catch {
    throw new U8Error("CONFIG_NOT_FOUND", `config file not found: ${configPath}`, { configPath });
  }
  return { configPath: real, paths: statePaths(real) };
}

async function connectOrSpawn(
  client: RpcClient,
  location: DaemonLocation,
  opts: EnsureDaemonOptions,
): Promise<void> {
  const logger = opts.logger ?? nullLogger;
  try {
    await client.connect();
    return;
  } catch (err) {
    if (!isUnreachable(err)) throw err;
  }

  logger.debug(`no daemon on ${location.paths.socket}; starting one`);
  const child = spawnDaemon(location, opts);
  await waitForConnection(client, location.paths, child, opts);
}

/**
 * Spawns the daemon process detached, with its output already pointed at
 * `daemon.log` — a failure during module loading (a broken install, a TypeScript
 * error in a plugin) has to end up somewhere the timeout message can quote.
 */
function spawnDaemon(location: DaemonLocation, opts: EnsureDaemonOptions): DaemonChild {
  fs.mkdirSync(location.paths.dir, { recursive: true });
  const entry = daemonEntryPath();
  const args = [...nodeArgsFor(entry), entry, "--config", location.configPath];
  const out = fs.openSync(location.paths.daemonLog, "a");
  try {
    const child = spawn(process.execPath, args, {
      cwd: path.dirname(location.configPath),
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ...opts.env },
    });
    const state: DaemonChild = { pid: child.pid, exit: undefined, error: undefined };
    child.on("error", (err) => {
      state.error = err;
    });
    child.on("exit", (code, signal) => {
      state.exit = signal !== null ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
    });
    // The daemon is not ours to wait on; it must survive this process.
    child.unref();
    return state;
  } finally {
    fs.closeSync(out);
  }
}

interface DaemonChild {
  pid: number | undefined;
  /** Set if the child died before the socket came up. */
  exit: string | undefined;
  error: Error | undefined;
}

async function waitForConnection(
  client: RpcClient,
  paths: StatePaths,
  child: DaemonChild,
  opts: EnsureDaemonOptions,
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  let diedAt: number | undefined;
  let last: unknown;
  for (;;) {
    if (child.error) {
      throw new U8Error("DAEMON_UNREACHABLE", `could not start the daemon: ${child.error.message}`);
    }
    try {
      await client.connect();
      return;
    } catch (err) {
      if (!isUnreachable(err)) throw err;
      last = err;
    }
    // A dead child cuts the wait short: a bad config or a lost socket race must
    // report in a moment, not stall every `u8` invocation for the full deadline.
    if (child.exit !== undefined) diedAt ??= Date.now();
    const cutoff = diedAt === undefined ? deadline : Math.min(deadline, diedAt + DEAD_CHILD_GRACE_MS);
    if (Date.now() >= cutoff) break;
    await sleep(CONNECT_POLL_MS);
  }
  throw new U8Error("DAEMON_UNREACHABLE", await launchFailureMessage(paths, child, last));
}

/** The one error a user actually reads: what failed, and where to look. */
async function launchFailureMessage(paths: StatePaths, child: DaemonChild, last: unknown): Promise<string> {
  const parts = [`the daemon did not start listening on ${paths.socket}`];
  if (child.exit !== undefined) parts.push(`the daemon process ${child.exit}`);
  parts.push(`see ${paths.daemonLog}`);
  const tail = await readLastLines(paths.daemonLog, LOG_TAIL_LINES).catch(() => []);
  const message = parts.join("; ");
  if (tail.length === 0) return `${message} (last error: ${errorMessage(last)})`;
  return `${message}:\n${tail.map((line) => `  ${line}`).join("\n")}`;
}

/**
 * The daemon entry point next to this module — `entry.js` in a build, `entry.ts`
 * when running from source. Deriving it from `import.meta.url` is what makes
 * both work without a build step or an env var.
 */
export function daemonEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), self.endsWith(".ts") ? "entry.ts" : "entry.js");
}

/** TypeScript sources need a loader; Node cannot resolve `./x.js` to `x.ts`. */
function nodeArgsFor(entry: string): string[] {
  return entry.endsWith(".ts") ? ["--import", jitiRegisterUrl()] : [];
}

function jitiRegisterUrl(): string {
  const require = createRequire(import.meta.url);
  let register: string;
  try {
    register = path.join(path.dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs");
  } catch (err) {
    throw new U8Error("INTERNAL", `cannot locate jiti to run the daemon from TypeScript sources: ${errorMessage(err)}`);
  }
  if (!fs.existsSync(register)) {
    throw new U8Error("INTERNAL", `jiti is installed but ${register} is missing`);
  }
  return pathToFileURL(register).href;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * A protocol mismatch is fatal — the two sides would misread each other's
 * payloads — while a version mismatch on the same protocol is only worth a
 * warning (SPEC §5.1: prompt to restart, do not force it).
 */
async function handshake(client: RpcClient, logger: Logger): Promise<void> {
  const pong = await client.request("daemon.ping", {});
  if (pong.protocolVersion !== PROTOCOL_VERSION) {
    throw new U8Error(
      "DAEMON_VERSION_MISMATCH",
      `the running daemon (u8 ${pong.version}) speaks protocol v${pong.protocolVersion}, ` +
        `this client (u8 ${VERSION}) speaks v${PROTOCOL_VERSION} — ` +
        `stop it with "u8 daemon stop" and run the command again to start a matching one`,
      { daemonVersion: pong.version, daemonProtocol: pong.protocolVersion, clientProtocol: PROTOCOL_VERSION },
    );
  }
  if (pong.version !== VERSION) {
    logger.warn(
      `daemon is running u8 ${pong.version} but this client is ${VERSION}; ` +
        `restart it with "u8 daemon stop" once the services can be interrupted`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUnreachable(err: unknown): boolean {
  return isU8Error(err) && err.code === "DAEMON_UNREACHABLE";
}

function backoff(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), REATTACH_BACKOFF_MS.length) - 1;
  return REATTACH_BACKOFF_MS[index] ?? 0;
}

/**
 * Ref'd on purpose: this one runs while the caller is actively waiting for a
 * daemon it just asked for, and an empty event loop would exit the process out
 * from under the awaited promise.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The background variant: a recovery loop must not keep a CLI alive. */
function sleepDetached(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function subscription<T>(set: Set<T>, cb: T): Unsubscribe {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

function emit<T>(listeners: ReadonlySet<(value: T) => void>, value: T, logger: Logger): void {
  for (const cb of [...listeners]) {
    try {
      cb(value);
    } catch (err) {
      logger.warn(`attach listener threw: ${errorMessage(err)}`);
    }
  }
}
