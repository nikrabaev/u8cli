/**
 * The daemon *process* — SPEC §5.1, PLAN 5.1.
 *
 * This module is what {@link daemonEntryPath} points at: a client spawns it
 * detached and then waits for the socket to answer. It owns everything that is
 * true of the process rather than of the daemon object — argv, stdio, the pid
 * file, signals — and nothing else; the daemon itself is `createDaemon`.
 *
 * Four rules shape it:
 *  - **Every byte of output ends up in `daemon.log`.** The spawning client points
 *    stdio there too, but a hand-started daemon must behave the same, and the
 *    launch-timeout message quotes that file — output landing on a terminal
 *    nobody is watching would make a failed start unexplainable.
 *  - **One daemon per workspace.** The socket is asked who owns it *before*
 *    anything is constructed, so a second start refuses with
 *    `DAEMON_ALREADY_RUNNING` instead of racing the live daemon for its socket.
 *  - **The pid file is written last.** It is the cleanup handle for a daemon that
 *    is already listening; writing it before `listen()` could clobber the entry
 *    of the daemon that won the socket.
 *  - **A signal is a clean shutdown, not an exit.** SIGTERM/SIGINT run the same
 *    sequence as `u8 daemon stop`, so services are stopped and the socket
 *    removed before the process goes away.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverConfig } from "../config/index.js";
import { ConfigError, errorMessage, isU8Error, U8Error } from "../util/errors.js";
import { createLogger, type Logger } from "../util/logger.js";
import { statePaths } from "../util/paths.js";
import { VERSION } from "../version.js";
import { createDaemon, type Daemon } from "./daemon.js";
import { pingDaemon } from "./launch.js";

/** How long the "is somebody already there?" probe waits before assuming nobody is. */
const OWNER_PROBE_MS = 1_000;

export interface EntryArgs {
  /** `--config <path>`; falls back to upward discovery from the cwd. */
  configPath?: string;
  /** `--idle-ms <n>`; overrides `limits.daemonIdle` and `U8_IDLE_MS`. */
  idleMs?: number;
  /** `--foreground`: keep stdout/stderr on the terminal instead of `daemon.log`. */
  foreground: boolean;
}

/**
 * Deliberately hand-rolled rather than commander: this process is spawned by
 * u8 itself with a fixed argv, and pulling the CLI framework into the daemon's
 * startup path would only add a way for it to fail before it can log anything.
 */
export function parseEntryArgs(argv: readonly string[]): EntryArgs {
  const args: EntryArgs = { foreground: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const [flag, inline] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new U8Error("INTERNAL", `${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case "--config":
      case "-c":
        args.configPath = value();
        break;
      case "--idle-ms": {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) throw new U8Error("INTERNAL", `--idle-ms must be a number, got "${raw}"`);
        args.idleMs = parsed;
        break;
      }
      case "--foreground":
        args.foreground = true;
        break;
      default:
        throw new U8Error("INTERNAL", `unknown daemon argument "${arg}"`);
    }
  }
  return args;
}

/**
 * Points this process's stdout and stderr at `daemon.log`.
 *
 * Node cannot re-open fd 1 and 2 in place, so the streams' `write` is replaced
 * with a synchronous append to our own descriptor. Synchronous is the point: a
 * daemon that is being torn down must not lose its last lines to a queued write.
 */
function redirectOutput(file: string): void {
  const fd = fs.openSync(file, "a", 0o600);
  const append = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : cb;
    try {
      const enc = typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
      fs.writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk, enc) : (chunk as Uint8Array));
      if (typeof done === "function") (done as (err?: Error) => void)();
    } catch (err) {
      // Nowhere left to report it: the log *is* the reporting channel.
      if (typeof done === "function") (done as (err?: Error) => void)(err as Error);
    }
    return true;
  };
  process.stdout.write = append as unknown as typeof process.stdout.write;
  process.stderr.write = append as unknown as typeof process.stderr.write;
}

/** The real path of `u8.jsonc`, or a `CONFIG_NOT_FOUND` naming what was tried. */
function resolveConfigPath(given: string | undefined): string {
  const candidate = given ?? discoverConfig(process.cwd());
  try {
    return fs.realpathSync(candidate);
  } catch {
    throw new U8Error("CONFIG_NOT_FOUND", `config file not found: ${candidate}`, { configPath: candidate });
  }
}

/** Multi-line for a `ConfigError` — the issue list is the useful part. */
function describe(err: unknown): string {
  if (err instanceof ConfigError) return err.format();
  if (isU8Error(err)) return `${err.code}: ${err.message}`;
  return errorMessage(err);
}

export async function runDaemonEntry(argv: readonly string[]): Promise<number> {
  // Safe to build before the redirect: the logger writes through
  // `process.stdout.write`, which `redirectOutput` replaces underneath it.
  const logger: Logger = createLogger("daemon");
  let daemon: Daemon | undefined;

  try {
    const args = parseEntryArgs(argv);
    const configPath = resolveConfigPath(args.configPath);
    const paths = statePaths(configPath);
    fs.mkdirSync(paths.dir, { recursive: true });
    if (!args.foreground) redirectOutput(paths.daemonLog);
    logger.info(`u8 ${VERSION} daemon starting`, { configPath, stateDir: paths.dir, pid: process.pid });

    // Ask before building anything: losing this race after spawning children
    // would mean two daemons owning the same workspace's processes.
    const owner = await pingDaemon(paths.socket, OWNER_PROBE_MS);
    if (owner) {
      throw new U8Error(
        "DAEMON_ALREADY_RUNNING",
        `a u8 ${owner.version} daemon is already listening on ${paths.socket}`,
        { socket: paths.socket, version: owner.version },
      );
    }

    daemon = createDaemon({ configPath, logger, idleMs: args.idleMs });
    await daemon.start();
    // Only now: the socket is ours, so this file describes a daemon that exists.
    fs.writeFileSync(paths.pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    process.title = `u8 daemon ${paths.id}`;
  } catch (err) {
    const message = describe(err);
    logger.error(`daemon failed to start: ${message}`);
    // Release whatever `start()` managed to bring up before it threw.
    if (daemon) await daemon.shutdown("startup failed").catch(() => undefined);
    return 1;
  }

  const active = daemon;
  let exitCode = 0;

  const stop = (reason: string): void => {
    void active.shutdown(reason).catch((err: unknown) => {
      logger.error(`shutdown failed: ${errorMessage(err)}`);
    });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // A stray rejection is a bug worth shouting about, but it is not a reason to
  // kill services the user asked to keep running.
  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandled rejection: ${errorMessage(reason)}`);
  });
  // An uncaught exception is different: the daemon's state is now unknown, and
  // supervising processes from an unknown state is worse than stopping them.
  process.on("uncaughtException", (err) => {
    logger.error(`uncaught exception: ${errorMessage(err)}`, { stack: err.stack });
    exitCode = 1;
    stop("uncaught exception");
  });

  const reason = await active.stopped;
  logger.info(`daemon exiting (${reason})`);
  return exitCode;
}

/**
 * True when node was told to run *this* file, so importing the module (a test,
 * a bundler) never starts a daemon. Unresolvable argv fails open: a daemon that
 * refuses to run would strand every client waiting on its socket.
 */
function startedAsScript(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return true;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (real(invoked) === real(fileURLToPath(import.meta.url))) return true;
  return /^entry\.(ts|js|mjs|cjs)$/.test(path.basename(invoked));
}

if (startedAsScript()) {
  // `process.exit` rather than a natural drain: stdio here is a file descriptor,
  // so its writes are already flushed, and a lingering handle in any dependency
  // must not turn "stopped" into "still running".
  runDaemonEntry(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`u8 daemon crashed during startup: ${errorMessage(err)}\n`);
      process.exit(1);
    },
  );
}
