/**
 * What every subcommand is handed, and the two ways it reaches the daemon.
 *
 * Three things live here because getting them wrong is invisible until it
 * bites:
 *
 *  - **The connection is always closed.** Both helpers run their body in a
 *    `try/finally`; a CLI that leaves a socket open hangs the process instead of
 *    exiting, which looks exactly like a hung daemon.
 *  - **A daemon that will not start is usually a broken config.** `ensureDaemon`
 *    can only report "it never listened, see daemon.log"; the config is loaded
 *    here on that path so the user gets the actual issue list instead of a log
 *    tail (SPEC §5.1).
 *  - **`--config` skips discovery entirely**, so a workspace can be driven from
 *    anywhere — and `--cwd` moves the discovery *and* the relative resolution of
 *    `--config` together, which is what makes them composable.
 *  - **The `daemon` subcommands key off the state dir**, not the config file
 *    ({@link daemonLocationOf}), so a daemon outlives the `u8.jsonc` it was
 *    started with.
 */
import fs from "node:fs";
import path from "node:path";

import { discoverConfig, loadWorkspaceFrom } from "../config/index.js";
import { attach, ensureDaemon, type AttachedClient } from "../daemon/index.js";
import type { RpcClient } from "../ipc/index.js";
import { ConfigError, isU8Error, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { CONFIG_FILENAME, statePaths, type StatePaths } from "../util/paths.js";
import { createStyler, shouldUseColor, type Styler } from "./format.js";
import { writeLine, type CliIo } from "./io.js";

/** Options every subcommand accepts, wherever they were typed on the line. */
export interface GlobalOptions {
  config?: string;
  color?: boolean;
  cwd?: string;
}

export interface CliContext {
  io: CliIo;
  style: Styler;
  /** Whether ANSI may be emitted — `--json` output ignores this and never does. */
  color: boolean;
  /** Working directory after `--cwd`; all relative paths resolve against it. */
  cwd: string;
  globals: GlobalOptions;
}

export function createContext(io: CliIo, globals: GlobalOptions): CliContext {
  const color = shouldUseColor(io, globals.color);
  return {
    io,
    style: createStyler(color),
    color,
    cwd: globals.cwd === undefined ? io.cwd : path.resolve(io.cwd, globals.cwd),
    globals,
  };
}

/**
 * The workspace config this invocation acts on, symlink-resolved so it matches
 * the daemon's state dir. Throws `CONFIG_NOT_FOUND` with the `u8 init` hint.
 */
export function configPathOf(ctx: CliContext): string {
  const given = ctx.globals.config;
  if (given === undefined) return discoverConfig(ctx.cwd);
  const candidate = path.resolve(ctx.cwd, given);
  try {
    return fs.realpathSync(candidate);
  } catch {
    throw new U8Error("CONFIG_NOT_FOUND", `config file not found: ${candidate}`, { configPath: candidate });
  }
}

/** A workspace's state dir, and whether its config is still on disk. */
export interface DaemonLocation {
  /** State-dir layout for this workspace — socket, pid file, `daemon.log`. */
  paths: StatePaths;
  /** The config the state dir is derived from; it may no longer exist. */
  configPath: string;
  /** False when the config is gone and the paths came from where it used to be. */
  configFound: boolean;
}

/**
 * Where the `daemon` subcommands look, which is the state dir rather than the
 * config file.
 *
 * A `u8.jsonc` that a branch switch or a checkout rename took away leaves a
 * daemon still supervising the workspace's processes, and these three commands
 * are the only way left to see or stop it — requiring the file would strand
 * those services on their ports with nothing but `kill` to reach them. Nothing
 * on disk is needed to find them: the workspace id is a hash of the config
 * *path*, so the path the config used to have is enough.
 *
 * Only these commands get the fallback. Every other subcommand has to read the
 * config to know what it is even acting on.
 */
export function daemonLocationOf(ctx: CliContext): DaemonLocation {
  const assumed = assumedConfigPath(ctx);
  const orphaned = statePaths(assumed);
  // A daemon still holding this directory's socket outranks upward discovery.
  // Otherwise a nested workspace whose config went away is answered for by its
  // *parent's* daemon: success reported about processes it never touched, and a
  // `stop` that takes down the wrong one.
  if (!fs.existsSync(assumed) && fs.existsSync(orphaned.socket)) {
    return { paths: orphaned, configPath: assumed, configFound: false };
  }
  try {
    const configPath = configPathOf(ctx);
    return { paths: statePaths(configPath), configPath, configFound: true };
  } catch (err) {
    if (!isU8Error(err) || err.code !== "CONFIG_NOT_FOUND") throw err;
    return { paths: orphaned, configPath: assumed, configFound: false };
  }
}

/**
 * Where this invocation's `u8.jsonc` would be, whether or not it is there. The
 * directory is symlink-resolved because the id hashes the *real* path (`/tmp`
 * is a symlink on macOS) — but the file itself is not required to exist, which
 * is the whole point.
 */
function assumedConfigPath(ctx: CliContext): string {
  const given = ctx.globals.config;
  const candidate = given === undefined ? path.join(ctx.cwd, CONFIG_FILENAME) : path.resolve(ctx.cwd, given);
  let dir: string;
  try {
    dir = fs.realpathSync(path.dirname(candidate));
  } catch {
    dir = path.dirname(candidate);
  }
  return path.join(dir, path.basename(candidate));
}

/**
 * The launch path's voice.
 *
 * `ensureDaemon`/`attach` report things a user needs to know but did not ask
 * for — a daemon running a different u8 than this client (SPEC §5.1), a dropped
 * connection being retried — and with the default null logger those vanish. They
 * go to stderr so stdout stays the command's output, and the chatty levels stay
 * off unless `U8_LOG_LEVEL=debug` asks for them.
 */
function cliLogger(ctx: CliContext): Logger {
  const verbose = (ctx.io.env["U8_LOG_LEVEL"] ?? "").toLowerCase() === "debug";
  const make = (scope: string): Logger => ({
    debug: (msg) => {
      if (verbose) writeLine(ctx.io.stderr, ctx.style.dim(`${scope}: ${msg}`));
    },
    info: (msg) => {
      if (verbose) writeLine(ctx.io.stderr, ctx.style.dim(`${scope}: ${msg}`));
    },
    warn: (msg) => writeLine(ctx.io.stderr, ctx.style.yellow(`warning: ${msg}`)),
    error: (msg) => writeLine(ctx.io.stderr, ctx.style.red(`error: ${msg}`)),
    child: (sub) => make(`${scope}:${sub}`),
  });
  return make("u8");
}

export interface ConnectOptions {
  /**
   * Per-request deadline. `0` disables it, which is mandatory for `run.await`:
   * a task legitimately runs longer than any timeout worth setting.
   */
  requestTimeoutMs?: number;
}

/** `ensureDaemon` (auto-spawning) with the client closed on every path. */
export async function withClient<T>(
  ctx: CliContext,
  opts: ConnectOptions,
  fn: (client: RpcClient) => Promise<T>,
): Promise<T> {
  const configPath = configPathOf(ctx);
  const client = await ensureDaemon({
    configPath,
    requestTimeoutMs: opts.requestTimeoutMs,
    logger: cliLogger(ctx),
  }).catch((err: unknown) => {
    throw explainLaunchFailure(err, configPath);
  });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Same, but attached: `task.progress`, `task.finished` and `service.changed` are
 * only pushed to attached connections, so anything that follows a run needs this
 * rather than {@link withClient}. The snapshot comes back with the attach.
 */
export async function withAttached<T>(
  ctx: CliContext,
  opts: ConnectOptions,
  fn: (attached: AttachedClient) => Promise<T>,
): Promise<T> {
  const configPath = configPathOf(ctx);
  const attached = await attach({
    configPath,
    requestTimeoutMs: opts.requestTimeoutMs,
    logger: cliLogger(ctx),
  }).catch((err: unknown) => {
    throw explainLaunchFailure(err, configPath);
  });
  try {
    return await fn(attached);
  } finally {
    await attached.close().catch(() => undefined);
  }
}

/**
 * Turns "the daemon never listened" into the reason it did not, when that reason
 * is in `u8.jsonc`. Anything else — a genuinely broken install, a socket we may
 * not write — is re-thrown untouched, log-tail and all.
 */
function explainLaunchFailure(err: unknown, configPath: string): unknown {
  if (!isU8Error(err) || err.code !== "DAEMON_UNREACHABLE") return err;
  try {
    loadWorkspaceFrom(configPath);
  } catch (configErr) {
    if (configErr instanceof ConfigError) return configErr;
    return configErr;
  }
  return err;
}
