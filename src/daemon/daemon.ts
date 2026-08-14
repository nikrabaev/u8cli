/**
 * The workspace daemon — SPEC §5.1, §5.2.
 *
 * `createDaemon` is the wiring: it owns the four collaborators from
 * `contracts.ts` (supervisor, indicator registry, engine, plugin host), the RPC
 * server that exposes them, and the lifecycle rules that make a background
 * process tolerable.
 *
 * Four rules shape it:
 *  - **Everything that is subscribed is disposed.** Every `onChange`/`onLog`
 *    bridge is kept in one list that `shutdown` drains, so a daemon that stops
 *    leaves no callback pointing at a closed socket.
 *  - **Idle means idle.** No clients, no running services and no in-flight run
 *    for `idleMs` and the daemon exits. Its timer is unref'd — it may never be
 *    the reason the process is alive, and the listening socket already is.
 *  - **Log pushes are bounded.** The transport queues writes without limit, so
 *    a client that stops reading would otherwise grow the daemon's heap for as
 *    long as a chatty service runs. Each connection gets a byte budget per
 *    window; overflow is dropped, counted, and reported on the `u8` stream.
 *  - **Shutdown is idempotent.** It is reachable from an RPC, a signal and the
 *    idle timer at once; the first caller owns the sequence, the rest await it.
 */
import { mkdir, readFile, rm } from "node:fs/promises";

import { findProfile, loadWorkspaceFrom } from "../config/index.js";
import type { NormalizedWorkspace, TargetId } from "../config/types.js";
import { createEngine } from "../engine/index.js";
import { createIndicatorRegistry } from "../indicators/index.js";
import { createRpcServer, type RpcConnection, type RpcServer } from "../ipc/index.js";
import { PROTOCOL_VERSION, type DaemonStatus, type LogLine, type Snapshot } from "../ipc/protocol.js";
import { ConfigError, errorMessage } from "../util/errors.js";
import { createLogger, type Logger } from "../util/logger.js";
import { statePaths, type StatePaths } from "../util/paths.js";
import { VERSION } from "../version.js";
import {
  emptyPluginHost,
  type DaemonContext,
  type PluginHost,
  type RunHandle,
  type Unsubscribe,
  type WorkspaceHolder,
} from "./contracts.js";
import { buildSnapshot, createHandlers, type HandlerDeps, type ReloadOutcome } from "./handlers.js";
import { createStateStore } from "./state.js";
import { createSupervisor } from "./supervisor.js";

/** Window over which one connection's log-push budget is measured. */
export const LOG_WINDOW_MS = 1_000;

/**
 * Bytes of log text one connection may be sent per window. A TUI rendering more
 * than this is already dropping frames; the lines stay on disk either way.
 */
export const LOG_BYTES_PER_WINDOW = 256 * 1024;

/** Per-notification overhead charged against the budget (envelope + metadata). */
const LOG_LINE_OVERHEAD = 120;

export interface DaemonOptions {
  /** Path to `u8.jsonc`. Symlink-resolved before the state dir is derived. */
  configPath: string;
  logger?: Logger;
  /** Overrides `limits.daemonIdle` and `U8_IDLE_MS`. `0` disables idle exit. */
  idleMs?: number;
  /**
   * Phase 8 seam: the loaded plugin host. Until plugins land, the daemon runs
   * against {@link emptyPluginHost}, which contributes nothing to any registry.
   */
  plugins?: PluginHost;
}

export interface Daemon {
  readonly paths: StatePaths;
  /** The shared context handed to collaborators (and, later, to plugins). */
  readonly context: DaemonContext;
  /** Resolves with the reason once the daemon has fully stopped. */
  readonly stopped: Promise<string>;
  /** Activates indicators and binds the socket. */
  start(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  snapshot(): Snapshot;
  status(): DaemonStatus;
}

export function createDaemon(opts: DaemonOptions): Daemon {
  const logger = opts.logger ?? createLogger("daemon");

  // Throws for an unreadable or invalid config: a daemon without a workspace has
  // nothing to serve, and the caller (entry.ts) reports it before forking off.
  let ws = loadWorkspaceFrom(opts.configPath);
  /** Symlink-resolved: the workspace id, the state dir and every reload use it. */
  const configPath = ws.configPath;
  const paths = statePaths(configPath);
  const workspace: WorkspaceHolder = { current: () => ws };
  const plugins = opts.plugins ?? emptyPluginHost;

  const store = createStateStore({ file: paths.stateFile, logger });
  let activeProfile = pickProfile(ws, store.current().activeProfile);
  let configError: string | undefined;

  const supervisor = createSupervisor({ workspace, paths, logger });
  const indicators = createIndicatorRegistry({ workspace, services: supervisor, logger });
  const engine = createEngine({
    workspace,
    paths,
    logger,
    supervisor,
    plugins,
    activeProfile: () => activeProfile,
  });

  const idleMs = resolveIdleMs(opts.idleMs, ws.limits.daemonIdleMs, logger);
  const startedAt = Date.now();

  const disposers: Unsubscribe[] = [];
  const budgets = new WeakMap<RpcConnection, LogBudget>();

  let server: RpcServer | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleDeadline: number | undefined;
  let activeRuns = 0;
  let listening = false;
  let shutdownPromise: Promise<void> | undefined;

  let resolveStopped!: (reason: string) => void;
  const stopped = new Promise<string>((resolve) => {
    resolveStopped = resolve;
  });

  // --- idle exit ------------------------------------------------------------

  const idle = (): boolean =>
    (server?.connectionCount ?? 0) === 0 && supervisor.runningCount() === 0 && activeRuns === 0;

  /**
   * Re-arms the idle timer from scratch. Called on every event that could change
   * the answer: a connection opening or closing, a service transition, a run
   * starting or finishing.
   *
   * Idleness counts *connections*, not just attached ones (SPEC §5.1 says
   * "attached clients"): a headless `u8 status` never attaches, and exiting
   * underneath it would be indistinguishable from a crash.
   */
  const resetIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    idleDeadline = undefined;
    if (idleMs <= 0 || !listening || shutdownPromise !== undefined || !idle()) return;

    idleDeadline = Date.now() + idleMs;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      idleDeadline = undefined;
      if (!idle()) {
        resetIdle();
        return;
      }
      logger.info(`idle for ${idleMs}ms with no clients and no services — exiting`);
      void shutdown("idle timeout");
    }, idleMs);
    // Indicators, backoffs and this timer are all "background": the listening
    // socket is what keeps the daemon alive, and it is closed on shutdown.
    idleTimer.unref();
  };

  const track = (handle: RunHandle): void => {
    activeRuns += 1;
    resetIdle();
    const settle = (): void => {
      activeRuns -= 1;
      resetIdle();
    };
    handle.done.then(settle, settle);
  };

  // --- log fan-out ----------------------------------------------------------

  /**
   * Pushes a log line to the connections that asked for that target — never to
   * every client. A dashboard with one open log view must not pay for the
   * output of twenty services.
   *
   * The subscription set is the whole gate: `attached` is about the snapshot
   * broadcast stream, and `u8 logs -f` follows a target without ever asking for
   * a snapshot. Requiring both would make `logs.subscribe` silently do nothing.
   */
  const emitLog = (line: LogLine): void => {
    const current = server;
    if (!current) return;
    for (const conn of current.connections) {
      if (!conn.subscriptions.has(line.targetId)) continue;
      if (!allowLogLine(conn, line)) continue;
      conn.notify("log.line", { line });
    }
  };

  const allowLogLine = (conn: RpcConnection, line: LogLine): boolean => {
    const now = Date.now();
    let budget = budgets.get(conn);
    if (!budget) {
      budget = { windowStart: now, bytes: 0, dropped: new Map() };
      budgets.set(conn, budget);
    }
    if (now - budget.windowStart >= LOG_WINDOW_MS) {
      for (const [targetId, count] of budget.dropped) {
        notice(conn, targetId, `dropped ${count} log line${count === 1 ? "" : "s"} — client fell behind`);
      }
      budget.dropped.clear();
      budget.windowStart = now;
      budget.bytes = 0;
    }

    const size = Buffer.byteLength(line.text, "utf8") + LOG_LINE_OVERHEAD;
    if (budget.bytes + size <= LOG_BYTES_PER_WINDOW) {
      budget.bytes += size;
      return true;
    }
    const dropped = (budget.dropped.get(line.targetId) ?? 0) + 1;
    budget.dropped.set(line.targetId, dropped);
    // Announce the throttling once per window per target; the tally follows when
    // the window rolls, so a client always knows its stream has a hole in it.
    if (dropped === 1) notice(conn, line.targetId, "log stream throttled — dropping lines");
    return false;
  };

  /** A `u8`-stream line addressed to one client: daemon commentary, not output. */
  const notice = (conn: RpcConnection, targetId: TargetId, text: string): void => {
    conn.notify("log.line", { line: { targetId, stream: "u8", ts: Date.now(), text } });
  };

  // --- reload ---------------------------------------------------------------

  /**
   * Manual reload (`workspace.reload`). Phase 12 adds the file watcher; the
   * semantics are already the ones it will use: swap the workspace, re-bind
   * indicators, re-evaluate staleness, and on failure keep the last-good config
   * while surfacing the error.
   */
  const reload = async (): Promise<ReloadOutcome> => {
    let next: NormalizedWorkspace;
    try {
      next = loadWorkspaceFrom(configPath);
    } catch (err) {
      configError = err instanceof ConfigError ? err.format() : errorMessage(err);
      logger.warn(`config reload failed, keeping last-good config: ${configError}`);
      server?.broadcast("config.reloaded", { ok: false, error: configError, stale: staleIds() });
      return { ok: false, error: configError };
    }

    ws = next;
    configError = undefined;
    if (!findProfile(ws, activeProfile)) {
      const fallback = ws.defaultProfile;
      logger.warn(`active profile "${activeProfile}" is gone; falling back to "${fallback}"`);
      activeProfile = fallback;
    }

    await indicators.rebind();
    // Every tracked id, so the comparison both sets and clears the flag.
    supervisor.markStale(supervisor.states().map((s) => s.targetId));

    server?.broadcast("config.reloaded", {
      ok: true,
      stale: staleIds(),
      snapshot: buildSnapshot(handlerDeps),
    });
    return { ok: true };
  };

  const staleIds = (): TargetId[] => supervisor.states().filter((s) => s.stale).map((s) => s.targetId);

  // --- context & handlers ---------------------------------------------------

  const context: DaemonContext = {
    workspace,
    paths,
    logger,
    supervisor,
    indicators,
    engine,
    plugins,
    activeProfile: () => activeProfile,
    setActiveProfile: (name: string) => {
      activeProfile = name;
    },
  };

  const handlerDeps: HandlerDeps = {
    ...context,
    version: VERSION,
    startedAt,
    stats: () => ({
      clients: server?.connectionCount ?? 0,
      runningServices: supervisor.runningCount(),
      idleExitInMs: idleDeadline === undefined ? null : Math.max(0, idleDeadline - Date.now()),
    }),
    configError: () => configError,
    reload,
    // Persist first: a daemon left running a profile it could not remember
    // would answer the RPC with a failure and then act on the new selection
    // anyway, and the next untargeted start would hit the wrong targets.
    saveProfile: async (name: string) => {
      await store.setActiveProfile(name);
      activeProfile = name;
    },
    track,
    requestShutdown: (reason: string) => {
      // After the current turn, so the `{ ok: true }` response is written before
      // the server starts closing connections.
      setImmediate(() => {
        void shutdown(reason);
      });
    },
  };

  // --- shutdown -------------------------------------------------------------

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= doShutdown(reason);
    return shutdownPromise;
  };

  const doShutdown = async (reason: string): Promise<void> => {
    logger.info(`shutting down: ${reason}`);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    idleDeadline = undefined;

    // Tell clients first: `end()` flushes what is queued, so this notification
    // still reaches them even though the socket closes moments later.
    server?.broadcast("daemon.shutdown", { reason });

    engine.cancelAll(`daemon is shutting down (${reason})`);
    await Promise.all([
      supervisor.stopAll().catch((err: unknown) => {
        logger.error(`stopping services failed: ${errorMessage(err)}`);
      }),
      indicators.stop().catch((err: unknown) => {
        logger.error(`stopping indicators failed: ${errorMessage(err)}`);
      }),
    ]);

    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        logger.warn(`disposing a subscription threw: ${errorMessage(err)}`);
      }
    }

    listening = false;
    if (server) await server.close().catch(() => undefined);
    await removeOwnPidFile(paths.pidFile, logger);
    logger.info("stopped");
    resolveStopped(reason);
  };

  // --- start ----------------------------------------------------------------

  const start = async (): Promise<void> => {
    if (listening) return;
    await mkdir(paths.dir, { recursive: true });

    for (const registration of plugins.indicators()) indicators.register(registration);
    // Core `app@` providers are registered by the registry itself, and `x@` ones
    // are derived from the workspace on every start/rebind — only plugin
    // contributions have to be pushed in from here.
    await indicators.start();

    disposers.push(
      supervisor.onChange((state) => {
        server?.broadcast("service.changed", { state });
        // `app@status`, `app@pid` and `app@exitcode` are event-mode providers:
        // this call is the event.
        indicators.refresh([state.targetId]);
        resetIdle();
      }),
      supervisor.onLog(emitLog),
      engine.onLog(emitLog),
      engine.onProgress((progress) => server?.broadcast("task.progress", { progress })),
      engine.onFinished((result) => server?.broadcast("task.finished", { result })),
      indicators.onChange((values) => server?.broadcast("indicator.changed", { values })),
    );

    const rpc = createRpcServer({
      socketPath: paths.socket,
      handlers: createHandlers(handlerDeps),
      logger,
      version: VERSION,
      onConnection: (conn) => {
        logger.debug(`client ${conn.id} connected`);
        resetIdle();
      },
      onDisconnect: (conn) => {
        logger.debug(`client ${conn.id} disconnected`);
        resetIdle();
      },
    });
    server = rpc;
    await rpc.listen();
    listening = true;
    logger.info(`listening on ${paths.socket}`, {
      workspace: ws.name,
      profile: activeProfile,
      pid: process.pid,
    });
    resetIdle();
  };

  return {
    paths,
    context,
    stopped,
    start,
    shutdown,
    snapshot: () => buildSnapshot(handlerDeps),
    status: () => {
      const stats = handlerDeps.stats();
      return {
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        workspaceId: ws.id,
        configPath,
        runningServices: stats.runningServices,
        clients: stats.clients,
        idleExitInMs: stats.idleExitInMs,
      };
    },
  };
}

/**
 * Removes the pid file only if it still names *this* process.
 *
 * Two clients can cold-start a workspace at the same time: one daemon wins the
 * socket and writes the pid file, the other fails to bind and shuts down. An
 * unconditional delete there would strip the live daemon of the very file
 * `u8 daemon stop` uses to find it.
 */
async function removeOwnPidFile(file: string, logger: Logger): Promise<void> {
  try {
    const owner = Number((await readFile(file, "utf8")).trim());
    if (owner !== process.pid) {
      logger.debug(`leaving ${file}: it belongs to pid ${owner}`);
      return;
    }
  } catch (err) {
    // Never written (a programmatic daemon), or already gone.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.debug(`could not read ${file}: ${errorMessage(err)}`);
    return;
  }
  await rm(file, { force: true }).catch(() => undefined);
}

interface LogBudget {
  windowStart: number;
  bytes: number;
  /** Undelivered lines per target since the window opened. */
  dropped: Map<TargetId, number>;
}

/** The profile a fresh daemon starts on: the persisted one if it still exists. */
function pickProfile(ws: NormalizedWorkspace, saved: string | undefined): string {
  if (saved !== undefined && findProfile(ws, saved)) return saved;
  return ws.defaultProfile;
}

/**
 * `opts.idleMs` (a test or an embedder) beats `U8_IDLE_MS` (a shell), which
 * beats `limits.daemonIdle` (the workspace). A non-positive value disables idle
 * exit entirely, which is what a long-lived demo daemon wants.
 */
export function resolveIdleMs(override: number | undefined, fromLimits: number, logger: Logger): number {
  if (override !== undefined) return Math.max(0, Math.floor(override));
  const raw = process.env.U8_IDLE_MS;
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    logger.warn(`ignoring U8_IDLE_MS="${raw}": not a number`);
  }
  return Math.max(0, fromLimits);
}
