/**
 * `u8 daemon status|stop|logs` — the three commands that talk *about* the
 * daemon rather than through it.
 *
 * None of them may auto-spawn one. "Is it running?" that starts a daemon in
 * order to answer "yes" is useless, and a `stop` that first starts something to
 * stop is worse; every path here connects to the existing socket or reports
 * that nobody is there. `daemon logs` does not even need that much — the log is
 * a file in the state dir, readable while the daemon is down, which is exactly
 * when it matters.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { pingDaemon } from "../daemon/index.js";
import { createRpcClient, type RpcClient } from "../ipc/index.js";
import { readLastLines } from "../process/index.js";
import { isU8Error } from "../util/errors.js";
import { formatUptime } from "../indicators/index.js";
import { configPathOf, statePathsOf, type CliContext } from "./context.js";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "./errors.js";
import { formatDuration, renderTable } from "./format.js";
import { writeLine, writeLines } from "./io.js";

/** Deadline for the "did it actually go away?" wait after `daemon.stop`. */
const STOP_TIMEOUT_MS = 15_000;

const STOP_POLL_MS = 50;

/** Default tail length for `u8 daemon logs`. */
export const DEFAULT_DAEMON_LOG_LINES = 50;

/** Gap between size checks while following a file. */
const TAIL_POLL_MS = 200;

export async function daemonStatusCommand(ctx: CliContext): Promise<number> {
  const paths = statePathsOf(ctx);
  const client = await connectExisting(paths.socket);
  if (!client) {
    writeLine(ctx.io.stdout, `daemon: ${ctx.style.dim("not running")}`);
    writeLine(ctx.io.stdout, ctx.style.dim(`  socket ${paths.socket}`));
    // Non-zero so `u8 daemon status && …` means what it looks like it means.
    return EXIT_FAILURE;
  }

  try {
    const status = await client.request("daemon.status", {});
    writeLine(ctx.io.stdout, `daemon: ${ctx.style.green("running")}`);
    writeLines(
      ctx.io.stdout,
      renderTable(
        [
          ["version", `${status.version} ${ctx.style.dim(`(protocol ${status.protocolVersion})`)}`],
          ["pid", String(status.pid)],
          ["uptime", formatUptime(status.uptimeMs)],
          ["workspace", status.workspaceId],
          ["config", status.configPath],
          ["socket", paths.socket],
          ["services", `${status.runningServices} running`],
          ["clients", String(status.clients)],
          ["idle exit", idleExit(status.idleExitInMs)],
        ].map(([label, value]) => [ctx.style.dim(label ?? ""), value ?? ""]),
        { indent: "  " },
      ),
    );
    return 0;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function idleExit(inMs: number | null): string {
  return inMs === null ? "not armed" : `in ${formatDuration(inMs)}`;
}

export async function daemonStopCommand(ctx: CliContext): Promise<number> {
  const paths = statePathsOf(ctx);
  const client = await connectExisting(paths.socket);
  if (!client) {
    // Idempotent on purpose: "make sure it is stopped" is the actual intent, and
    // a script that runs it twice should not fail the second time.
    writeLine(ctx.io.stdout, ctx.style.dim("no daemon running for this workspace"));
    return 0;
  }

  let pid: number | undefined;
  try {
    pid = (await client.request("daemon.status", {})).pid;
    await client.request("daemon.stop", {});
  } finally {
    await client.close().catch(() => undefined);
  }

  const outcome = await waitForExit(paths.socket, ctx.io.signal);
  if (outcome === "interrupted") {
    // The stop was already accepted; only the waiting was cut short. Saying the
    // daemon "is still listening" here would blame it for the user's Ctrl-C.
    writeLine(ctx.io.stderr, ctx.style.dim("interrupted — the daemon was asked to stop and is shutting down"));
    return EXIT_INTERRUPTED;
  }
  if (outcome === "timeout") {
    writeLine(ctx.io.stderr, ctx.style.yellow(`the daemon is still listening after ${STOP_TIMEOUT_MS}ms`));
    return EXIT_FAILURE;
  }
  writeLine(ctx.io.stdout, `daemon stopped${pid === undefined ? "" : ctx.style.dim(` (pid ${pid})`)}`);
  return 0;
}

export interface DaemonLogsOptions {
  lines?: number;
  follow?: boolean;
}

export async function daemonLogsCommand(ctx: CliContext, opts: DaemonLogsOptions): Promise<number> {
  const paths = statePathsOf(ctx);
  // Resolves (and validates) the config the same way every other command does,
  // so a missing workspace fails with CONFIG_NOT_FOUND rather than an empty log.
  configPathOf(ctx);

  const lines = opts.lines ?? DEFAULT_DAEMON_LOG_LINES;
  if (!fs.existsSync(paths.daemonLog)) {
    writeLine(ctx.io.stderr, ctx.style.dim(`no daemon log yet at ${paths.daemonLog}`));
    return opts.follow === true ? 0 : EXIT_FAILURE;
  }

  for (const line of await readLastLines(paths.daemonLog, lines)) {
    writeLine(ctx.io.stdout, line);
  }
  if (opts.follow !== true) return 0;
  return tailFile(ctx, paths.daemonLog);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A client for a daemon that already exists, or `undefined` if nobody answers. */
async function connectExisting(socketPath: string): Promise<RpcClient | undefined> {
  const client = createRpcClient({ socketPath, timeoutMs: 5_000 });
  try {
    await client.connect();
    return client;
  } catch (err) {
    await client.close().catch(() => undefined);
    if (isU8Error(err) && err.code === "DAEMON_UNREACHABLE") return undefined;
    throw err;
  }
}

/** How the wait for the daemon's socket to go quiet ended. */
type ExitWait = "gone" | "timeout" | "interrupted";

async function waitForExit(socketPath: string, signal: AbortSignal | undefined): Promise<ExitWait> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted === true) return "interrupted";
    if ((await pingDaemon(socketPath, 1_000).catch(() => undefined)) === undefined) return "gone";
    if (Date.now() >= deadline) return "timeout";
    await sleep(STOP_POLL_MS);
  }
}

/**
 * `tail -f` over the daemon log by polling its size.
 *
 * Polling rather than `fs.watch`: the daemon appends with `writeSync` to a file
 * that a launch may also have open, and watch events for that pattern are
 * unreliable across platforms — the same reason the git plugin keeps a fallback
 * poll. The interval is cleared on every exit path.
 */
async function tailFile(ctx: CliContext, file: string): Promise<number> {
  let position = await fsp.stat(file).then(
    (s) => s.size,
    () => 0,
  );
  let reading = false;

  const drain = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      const size = await fsp.stat(file).then(
        (s) => s.size,
        () => 0,
      );
      // A rotated or truncated file restarts from the beginning rather than
      // reading past the end of a shorter one.
      if (size < position) position = 0;
      if (size === position) return;
      const handle = await fsp.open(file, "r");
      try {
        const buffer = Buffer.alloc(size - position);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        for (const line of text.split("\n")) {
          if (line.length > 0) writeLine(ctx.io.stdout, line);
        }
      } finally {
        await handle.close();
      }
    } finally {
      reading = false;
    }
  };

  const signal = ctx.io.signal;
  if (signal?.aborted === true) return EXIT_INTERRUPTED;

  return new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      void drain().catch(() => undefined);
    }, TAIL_POLL_MS);
    const stop = (): void => {
      clearInterval(timer);
      resolve(EXIT_INTERRUPTED);
    };
    if (signal === undefined) return; // nothing can end the follow; the signal is the exit
    signal.addEventListener("abort", stop, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
