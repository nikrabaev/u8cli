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
 */
import fs from "node:fs";
import path from "node:path";

import { discoverConfig, loadWorkspaceFrom } from "../config/index.js";
import { attach, ensureDaemon, type AttachedClient } from "../daemon/index.js";
import type { RpcClient } from "../ipc/index.js";
import { ConfigError, isU8Error, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { statePaths, type StatePaths } from "../util/paths.js";
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

/** State-dir layout for this workspace — sockets, pid file, `daemon.log`. */
export function statePathsOf(ctx: CliContext): StatePaths {
  return statePaths(configPathOf(ctx));
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
