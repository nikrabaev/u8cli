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
 *
 * And none of them require `u8.jsonc` to still exist: these are the commands a
 * user reaches for *because* the workspace changed under a running daemon, so
 * they resolve the state dir through {@link daemonLocationOf}.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";

import { BASE_INSTANCE } from "../config/index.js";
import { pingDaemon } from "../daemon/index.js";
import { createRpcClient, type RpcClient } from "../ipc/index.js";
import type { Snapshot } from "../ipc/protocol.js";
import { readLastLines } from "../process/index.js";
import { isU8Error } from "../util/errors.js";
import { CONFIG_FILENAME } from "../util/paths.js";
import { formatUptime } from "../indicators/index.js";
import { daemonLocationOf, scopeOf, type CliContext, type DaemonLocation } from "./context.js";
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
  const location = daemonLocationOf(ctx);
  const paths = location.paths;
  const client = await connectExisting(paths.socket);
  if (!client) {
    writeLine(ctx.io.stdout, `daemon: ${ctx.style.dim("not running")}`);
    writeLine(ctx.io.stdout, ctx.style.dim(`  socket ${paths.socket}`));
    explainMissingConfig(ctx, location);
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

export async function daemonStopCommand(ctx: CliContext, opts: { force?: boolean } = {}): Promise<number> {
  const location = daemonLocationOf(ctx);
  const paths = location.paths;
  const client = await connectExisting(paths.socket);
  if (!client) {
    // Idempotent on purpose: "make sure it is stopped" is the actual intent, and
    // a script that runs it twice should not fail the second time.
    writeLine(ctx.io.stdout, ctx.style.dim("no daemon running for this workspace"));
    explainMissingConfig(ctx, location);
    return 0;
  }

  let pid: number | undefined;
  try {
    if (opts.force !== true) {
      const refusal = collateralOf(ctx, await client.request("workspace.snapshot", {}));
      if (refusal !== undefined) {
        writeLine(ctx.io.stderr, ctx.style.red(refusal));
        return EXIT_FAILURE;
      }
    }
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

/**
 * Why stopping the daemon would stop more than its caller is looking at, or
 * `undefined` when it would not.
 *
 * One daemon runs every instance, so this command takes down work that belongs
 * to other tasks. Typed inside an instance it is almost certainly meant as
 * "stop mine"; typed in base while other instances run, it is at least worth a
 * second look. Either way the answer is the command that does what was meant.
 */
function collateralOf(ctx: CliContext, snapshot: Snapshot): string | undefined {
  let mine = BASE_INSTANCE;
  let outside = false;
  try {
    const scope = scopeOf(ctx);
    mine = scope.instance;
    outside = scope.unregistered !== undefined;
  } catch {
    // No config to place this directory by: it is treated as base.
  }

  const running = new Set(snapshot.services.filter((s) => s.status !== "stopped").map((s) => s.targetId));
  const busy = snapshot.instances
    .filter((i) => i.name !== mine)
    .map((i) => ({ name: i.name, count: i.appIds.filter((id) => running.has(id)).length }))
    .filter((i) => i.count > 0);

  if (mine !== BASE_INSTANCE || outside) {
    return (
      `\`u8 daemon stop\` stops every instance's services, not only this one's` +
      (busy.length > 0 ? ` (${busy.map((i) => `${i.name}: ${i.count} running`).join(", ")})` : "") +
      ` — use \`u8 stop\` for this instance, or \`u8 daemon stop --force\``
    );
  }
  if (busy.length === 0) return undefined;
  return (
    `other instances have services running (${busy.map((i) => `${i.name}: ${i.count}`).join(", ")}) and stopping the ` +
    `daemon stops them too — \`u8 stop\` stops only base, \`u8 daemon stop --force\` stops everything`
  );
}

export interface DaemonLogsOptions {
  lines?: number;
  follow?: boolean;
}

export async function daemonLogsCommand(ctx: CliContext, opts: DaemonLogsOptions): Promise<number> {
  const location = daemonLocationOf(ctx);
  const paths = location.paths;

  const lines = opts.lines ?? DEFAULT_DAEMON_LOG_LINES;
  if (!fs.existsSync(paths.daemonLog)) {
    writeLine(ctx.io.stderr, ctx.style.dim(`no daemon log yet at ${paths.daemonLog}`));
    explainMissingConfig(ctx, location);
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

/**
 * Says why there was nothing to report, when the reason is that this state dir
 * was derived from a config that is not there.
 *
 * Without it "no daemon running for this workspace" is indistinguishable from
 * "nothing to clean up" — and the daemon the user is after may well be alive
 * under the *old* path, since moving `u8.jsonc` moves the workspace id with it.
 */
function explainMissingConfig(ctx: CliContext, location: DaemonLocation): void {
  if (location.configFound) return;
  writeLine(
    ctx.io.stderr,
    ctx.style.dim(
      `no ${CONFIG_FILENAME} at ${location.configPath} — run \`u8 init\` to create one, or ` +
        `\`u8 daemon stop --config <path>\` naming the config the daemon was started with`,
    ),
  );
}

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
