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
 *    The pid file is asked too, and it is the question that matters when the
 *    socket is *missing*: a daemon whose socket was deleted underneath it is
 *    still running, still owns its services, and must not be duplicated.
 *  - **The pid file is written last.** It is the cleanup handle for a daemon that
 *    is already listening; writing it before `listen()` could clobber the entry
 *    of the daemon that won the socket.
 *  - **A signal is a clean shutdown, not an exit.** SIGTERM/SIGINT run the same
 *    sequence as `u8 daemon stop`, so services are stopped and the socket
 *    removed before the process goes away. The handlers go on *before* startup:
 *    a client spawns this process and then waits on the socket, and a signal in
 *    that half second would otherwise kill it with the default disposition and
 *    leave the socket and pid file behind for the next launch to reclaim.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverConfig } from "../config/index.js";
import { ConfigError, errorMessage, isU8Error, U8Error } from "../util/errors.js";
import { createLogger, type Logger } from "../util/logger.js";
import { statePaths, type StatePaths } from "../util/paths.js";
import { VERSION } from "../version.js";
import { createDaemon, type Daemon } from "./daemon.js";
import { pingDaemon } from "./launch.js";
import { commandIs, findProcessesMatching, pidAlive, processCommand } from "./state.js";

/** How long the "is somebody already there?" probe waits before assuming nobody is. */
const OWNER_PROBE_MS = 1_000;

/**
 * How long to give a predecessor that is already on its way out.
 *
 * A daemon unlinks its socket a moment before it exits, so a client can spawn
 * its replacement into a window where the old process is still listed. Waiting
 * costs a fraction of a second there and turns what would be a spurious refusal
 * into an ordinary start.
 */
const PREDECESSOR_WAIT_MS = 2_000;

/** What a daemon puts in `process.title`; the pid-file check identifies it by this. */
export function daemonTitle(id: string): string {
  return `u8 daemon ${id}`;
}

/**
 * The pid of a daemon that is *running this workspace* according to the pid
 * file, or `undefined` if the file names nobody who is.
 *
 * A live pid is not enough on its own — a pid file outlives the daemon that
 * wrote it, and the number is eventually handed to something unrelated — so the
 * process is asked what it is. The daemon publishes exactly that in its
 * `process.title` (set before the pid file is written, so a file that exists
 * always names an identifiable process), and only a positive match refuses a
 * start: a check that cannot tell must fall back to the socket probe, or a
 * recycled pid would lock a workspace out of ever starting a daemon again.
 */
export async function liveDaemonPid(paths: StatePaths): Promise<number | undefined> {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(paths.pidFile, "utf8").trim());
  } catch {
    return undefined; // never written, or already cleaned up
  }
  // Never ourselves: `runDaemonEntry` also runs inside someone else's process
  // (a test, an embedder), and a daemon refusing to start because the pid file
  // names its own caller would be refusing over nothing.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) return undefined;
  const command = await processCommand(pid);
  return command !== undefined && commandIs(command, daemonTitle(paths.id)) ? pid : undefined;
}

/**
 * A live daemon for this workspace found in the process table rather than in a
 * file — the case the pid file cannot answer, because the pid file was deleted
 * along with the rest of the state dir.
 *
 * It only ever finds a daemon that got as far as *listening*: the title is set
 * at that moment, so two daemons racing a cold start still resolve the way they
 * always have — on the socket bind — and neither sees the other here.
 */
async function runningDaemonPid(paths: StatePaths): Promise<number | undefined> {
  const found = await findProcessesMatching(daemonTitle(paths.id));
  // `undefined` is "the process table could not be read". Refusing on a
  // question we could not ask would strand the workspace; the socket probe and
  // the bind are still there to catch a genuine second daemon.
  return found?.find((pid) => pid !== process.pid);
}

/**
 * Blocks until this process is the only daemon this workspace has, or throws.
 *
 * Two daemons over one workspace is the failure everything else here exists to
 * prevent: they own two copies of every service, and only one of them is
 * reachable, so the other's process tree can only be found with `pgrep`. A
 * predecessor that is winding down is waited for; one that is staying is
 * reported by pid, which is what a user needs in order to do anything about it.
 */
async function requireSoleOwnership(paths: StatePaths, logger: Logger): Promise<void> {
  const deadline = Date.now() + PREDECESSOR_WAIT_MS;
  let announced = false;
  for (;;) {
    const rival = (await liveDaemonPid(paths)) ?? (await runningDaemonPid(paths));
    if (rival === undefined) return;
    if (Date.now() >= deadline) {
      throw new U8Error(
        "DAEMON_ALREADY_RUNNING",
        `a u8 daemon for this workspace is already running as pid ${rival}, but its socket ` +
          `(${paths.socket}) is missing — it stops itself and its services once it notices that, so run ` +
          `the command again in a moment; if it persists, stop it with "kill ${rival}"`,
        { pid: rival, socket: paths.socket },
      );
    }
    if (!announced) {
      announced = true;
      logger.info(`pid ${rival} still owns this workspace; waiting for it to finish before starting`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
  /** True once there is a listening daemon that `shutdown` can take down. */
  let ready = false;
  /** A stop asked for before that; honoured the moment startup finishes. */
  let pending: string | undefined;
  let exitCode = 0;

  /**
   * The one way this process is asked to stop. Before the daemon is up there is
   * nothing to shut down gracefully — no socket, no children — so the request is
   * remembered and replayed as soon as startup settles, one way or the other.
   */
  const requestStop = (reason: string): void => {
    const active = daemon;
    if (!ready || !active) {
      if (pending !== undefined) {
        // Insisting, while startup is stuck somewhere JS cannot interrupt (a
        // config file on a hung mount). Leaving is better than ignoring them;
        // a socket or pid file left behind is reclaimed by the next launch.
        logger.warn(`${reason} again during startup — exiting immediately`);
        process.exit(1);
      }
      pending = reason;
      logger.info(`${reason} during startup — stopping as soon as it finishes`);
      return;
    }
    void active.shutdown(reason).catch((err: unknown) => {
      logger.error(`shutdown failed: ${errorMessage(err)}`);
    });
  };

  const onSigterm = (): void => requestStop("SIGTERM");
  const onSigint = (): void => requestStop("SIGINT");
  // A stray rejection is a bug worth shouting about, but it is not a reason to
  // kill services the user asked to keep running.
  const onRejection = (reason: unknown): void => {
    logger.error(`unhandled rejection: ${errorMessage(reason)}`);
  };
  // An uncaught exception is different: the daemon's state is now unknown, and
  // supervising processes from an unknown state is worse than stopping them.
  const onException = (err: Error): void => {
    logger.error(`uncaught exception: ${errorMessage(err)}`, { stack: err.stack });
    exitCode = 1;
    requestStop("uncaught exception");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  /**
   * Taken off again on the way out. In the daemon process this changes nothing —
   * it exits right after — but this function is exported and also runs in
   * *someone else's* process (a client checking a workspace, a test): leaving
   * the handlers behind would make that process ignore SIGTERM/SIGINT for good
   * and swallow uncaught exceptions into a log nobody is reading.
   */
  const removeHandlers = (): void => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };

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

    // A silent socket does not mean a dead daemon: delete the socket file — or
    // the whole state dir — and the daemon behind it is still running, still
    // holding every service it spawned. Starting a second one here is what
    // strands the first.
    await requireSoleOwnership(paths, logger);

    daemon = createDaemon({ configPath, logger, idleMs: args.idleMs });
    await daemon.start();
    // Before the pid file, so a file that exists always names a process the
    // check above can identify. It is slow enough on macOS to be a window of its
    // own, but a signal landing in it is remembered and replayed by `requestStop`.
    process.title = daemonTitle(paths.id);
    // Only now: the socket is ours, so this file describes a daemon that exists.
    fs.writeFileSync(paths.pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    // From here a signal has a daemon to shut down.
    ready = true;
  } catch (err) {
    const message = describe(err);
    logger.error(`daemon failed to start: ${message}`);
    // Release whatever `start()` managed to bring up before it threw.
    if (daemon) await daemon.shutdown("startup failed").catch(() => undefined);
    removeHandlers();
    return 1;
  }

  try {
    const active = daemon;
    // A signal that arrived while the daemon was coming up: it is up now, so the
    // request it made turns into the ordinary graceful shutdown.
    if (pending !== undefined) requestStop(pending);

    const reason = await active.stopped;
    logger.info(`daemon exiting (${reason})`);
    return exitCode;
  } finally {
    removeHandlers();
  }
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
