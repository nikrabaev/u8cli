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
 *  - **Reloads are serial.** The file watcher, `workspace.reload` and a burst of
 *    saves all drive the same sequence, which swaps the workspace, the plugin
 *    host and every indicator binding — two of them at once would interleave
 *    over that state. One runs, the rest collapse into a single follow-up.
 *  - **The state dir is the daemon's licence to run.** It holds the socket
 *    clients reach us on, the pid file `u8 daemon stop` finds us by, and the
 *    journal that makes a crash recoverable. Losing it means nothing can talk to
 *    this daemon, address it, or clean up after it — so a watchdog notices and
 *    shuts it down rather than leaving a process tree nobody can reach.
 */
import { statSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";

import { findProfile, loadWorkspaceFrom } from "../config/index.js";
import type { NormalizedWorkspace, TargetId } from "../config/types.js";
import { createEngine } from "../engine/index.js";
import { createIndicatorRegistry } from "../indicators/index.js";
import { createRpcServer, type RpcConnection, type RpcServer } from "../ipc/index.js";
import { PROTOCOL_VERSION, type DaemonStatus, type LogLine, type Snapshot } from "../ipc/protocol.js";
import { createPluginHost, pluginSources, type LoadablePluginHost } from "../plugins/index.js";
import { ConfigError, errorMessage } from "../util/errors.js";
import { createLogger, type Logger } from "../util/logger.js";
import { statePaths, type StatePaths } from "../util/paths.js";
import { VERSION } from "../version.js";
import type {
  DaemonContext,
  PluginHost,
  RunHandle,
  Unsubscribe,
  WorkspaceHolder,
} from "./contracts.js";
import { buildSnapshot, createHandlers, type HandlerDeps, type ReloadOutcome } from "./handlers.js";
import { createStateStore, createSupervisedJournal, supervisedFile } from "./state.js";
import { createSupervisor, type ReconcileReport } from "./supervisor.js";
import { configSignature, watchConfig } from "./watch.js";

/** Window over which one connection's log-push budget is measured. */
export const LOG_WINDOW_MS = 1_000;

/**
 * Bytes of log text one connection may be sent per window. A TUI rendering more
 * than this is already dropping frames; the lines stay on disk either way.
 */
export const LOG_BYTES_PER_WINDOW = 256 * 1024;

/** Per-notification overhead charged against the budget (envelope + metadata). */
const LOG_LINE_OVERHEAD = 120;

/**
 * How long one in-flight run may keep the daemon out of idle.
 *
 * A run that can never settle — a plugin command that ignores its abort signal,
 * a script waiting on something that will not come — would otherwise hold
 * `activeRuns` above zero forever and make SPEC §5.1's self-exit unreachable
 * for the life of the process. It is deliberately far longer than any idle
 * window: a legitimate long task must never be the reason a daemon exits
 * underneath it, and a client waiting on a run is connected anyway.
 */
export const RUN_IDLE_CEILING_MS = 60 * 60_000;

/**
 * Headroom over the stop timeout when draining runs at shutdown. The process
 * layer's own SIGTERM → SIGKILL escalation takes the whole stop timeout, so a
 * cap of exactly that would give up in the instant the kill lands.
 */
const DRAIN_GRACE_MS = 2_000;

/**
 * How often the daemon checks that its state dir and socket are still there.
 *
 * A `stat` of two paths twice a second is nothing next to what it buys: a
 * workspace whose state dir was deleted (`rm -rf ~/.u8/<id>`, a cleanup script,
 * a tmp reaper) otherwise leaves a daemon listening on a socket no client can
 * find, owning services no `u8` command can reach, while the next command
 * cheerfully starts a second daemon and a second copy of every service.
 */
export const STATE_WATCH_MS = 500;

export interface DaemonOptions {
  /** Path to `u8.jsonc`. Symlink-resolved before the state dir is derived. */
  configPath: string;
  logger?: Logger;
  /** Overrides `limits.daemonIdle` and `U8_IDLE_MS`. `0` disables idle exit. */
  idleMs?: number;
  /** Overrides {@link RUN_IDLE_CEILING_MS}; a test shrinks it to milliseconds. */
  runCeilingMs?: number;
  /**
   * Replaces the host built from `ws.plugins` and the built-ins. A test passes
   * a fake (`emptyPluginHost` in `contracts.ts`) to keep a workspace's real
   * plugins out of the way; a host that has `load`/`dispose` is driven through
   * its lifecycle exactly like the real one.
   */
  plugins?: PluginHost | LoadablePluginHost;
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

  /**
   * SPEC §4: an unknown or malformed template token "warns at load". The
   * workspace only *collects* those warnings — this is the one place a load
   * happens, at cold start and again on every reload, so it is where they are
   * said out loud (`u8 daemon logs`). Non-fatal by design: the token still
   * renders as a red `{ns@name!}` marker and the workspace still serves.
   */
  const reportConfigWarnings = (loaded: NormalizedWorkspace): void => {
    for (const warning of loaded.warnings) logger.warn(`config: ${warning}`);
  };
  reportConfigWarnings(ws);

  /** Symlink-resolved: the workspace id, the state dir and every reload use it. */
  const configPath = ws.configPath;
  /**
   * The config as it was when it was read, for the watch `start()` arms much
   * later — loading plugins alone can take seconds. Without it a save landing
   * in that window is lost for good: the watch and its poll would both baseline
   * on the *post-save* file and see nothing to report.
   */
  const loadedSignature = configSignature(configPath);
  const paths = statePaths(configPath);
  const workspace: WorkspaceHolder = { current: () => ws };

  /**
   * What this daemon owns, on disk. Built before the supervisor because the
   * supervisor writes to it from its very first spawn, and read before anything
   * is spawned so `reconcile` sees the *previous* daemon's set.
   */
  const journal = createSupervisedJournal({ file: supervisedFile(paths.dir), logger });

  // Before the plugin host, which hands it to the `health` built-in: the host is
  // built (and rebuilt on reload) from here, and a supervisor declared below it
  // would still be in its temporal dead zone at cold start.
  const supervisor = createSupervisor({ workspace, paths, logger, journal });

  /**
   * Plugin failures are pushed as they happen so a connected client can banner
   * them; the cold-start ones land before anyone can be listening, which is why
   * `Snapshot.plugins` carries the same information for whoever attaches next.
   * A failure during a *reload* is the one that really travels — by then there
   * is a socket, and clients are on it.
   */
  const buildPluginHost = (): LoadablePluginHost =>
    createPluginHost({
      workspace,
      logger,
      onError: (plugin, error) => {
        server?.broadcast("plugin.error", { plugin, error });
      },
      builtinOptions: {
        // The supervisor is the only source of the lifecycle edges the plugin
        // SDK cannot report — a crash, and an automatic restart. Without it a
        // crashed service keeps its last verdict and is probed for the life of
        // the daemon, against SPEC §7.2 on both counts.
        health: { services: supervisor, workspace },
      },
    });

  /**
   * Only a host the daemon built is a host the daemon may replace: an injected
   * one belongs to whoever passed it, and rebuilding it would hand back
   * something the caller never provided.
   */
  const ownsPlugins = opts.plugins === undefined;
  let host: PluginHost | LoadablePluginHost = opts.plugins ?? buildPluginHost();
  /** Plugin specs the live host was built from; a reload compares against it. */
  let pluginSpecs = pluginKey(ws);

  /**
   * The stable facade every collaborator holds. The engine and the handlers
   * capture `plugins` once at construction, so a reload that rebuilds the host
   * has to be invisible from the outside — this indirection is what makes the
   * swap possible without re-wiring anything.
   */
  const plugins: PluginHost = {
    hooksFor: (command) => host.hooksFor(command),
    commands: () => host.commands(),
    indicators: () => host.indicators(),
    readiness: (target, service) => host.readiness(target, service),
    list: () => host.list(),
  };

  const store = createStateStore({ file: paths.stateFile, logger });
  let activeProfile = pickProfile(ws, store.current().activeProfile);
  let configError: string | undefined;

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
  const runCeilingMs = Math.max(0, opts.runCeilingMs ?? RUN_IDLE_CEILING_MS);
  const startedAt = Date.now();

  const disposers: Unsubscribe[] = [];
  const budgets = new WeakMap<RpcConnection, LogBudget>();

  let server: RpcServer | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleDeadline: number | undefined;
  let stateTimer: NodeJS.Timeout | undefined;
  let activeRuns = 0;
  let listening = false;
  let shutdownPromise: Promise<void> | undefined;
  let stopWatching: Unsubscribe | undefined;
  /** The reload in flight, and the single follow-up everything else collapses into. */
  let reloading: Promise<ReloadOutcome> | undefined;
  let queuedReload: Promise<ReloadOutcome> | undefined;

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

  // --- state-dir watchdog ---------------------------------------------------

  /**
   * Identity of the socket this daemon bound, captured at `listen()`.
   *
   * The path alone is not enough: a second daemon that binds it (after the file
   * was removed) leaves the path present but pointing at *its* socket, and this
   * daemon would go on listening to a socket nobody can dial.
   */
  let socketId: string | undefined;

  const identify = (file: string): string | undefined => {
    try {
      const st = statSync(file);
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };

  /**
   * Why this exists rather than trusting the filesystem: a daemon whose state
   * dir has been deleted is unreachable *and* unrecorded — clients cannot find
   * its socket, `u8 daemon stop` cannot find its pid, and the journal that would
   * let the next daemon adopt its services is gone. The next `u8` command
   * therefore starts a second daemon and a second copy of every service, while
   * this one keeps its process tree alive with no way to address it.
   *
   * Shutting down is the honest response: it stops the services it owns, the way
   * `u8 daemon stop` would have, and leaves the workspace clean for the daemon
   * that replaces it.
   */
  const watchState = (): void => {
    if (shutdownPromise !== undefined) return;
    const gone =
      identify(paths.dir) === undefined
        ? `its state directory ${paths.dir} was removed`
        : identify(paths.socket) !== socketId
          ? `its socket ${paths.socket} was removed or replaced`
          : undefined;
    if (gone === undefined) return;
    logger.error(`${gone}; stopping the services it owns and exiting so nothing is left stranded`);
    void shutdown("the state directory was removed").catch((err: unknown) => {
      logger.error(`shutdown after losing the state directory failed: ${errorMessage(err)}`);
    });
  };

  const track = (handle: RunHandle): void => {
    activeRuns += 1;
    resetIdle();
    /**
     * Released exactly once. A run that outstayed the ceiling and settles later
     * would otherwise decrement a second time, and a negative `activeRuns`
     * reads as idle while real work is in flight.
     */
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      activeRuns -= 1;
      resetIdle();
    };
    const ceiling = setTimeout(() => {
      logger.warn(
        `run ${handle.runId} has been in flight for ${runCeilingMs}ms; it no longer holds off idle exit`,
      );
      release();
    }, runCeilingMs);
    // Background, like every other daemon timer: the listening socket is what
    // keeps the process alive.
    ceiling.unref();
    const settle = (): void => {
      clearTimeout(ceiling);
      release();
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
   * Re-loads the plugin host when the workspace's plugin list changed (SPEC §8).
   *
   * Only when it changed. Tearing every plugin down on an unrelated template
   * edit would drop the git watchers and health probes and re-run every
   * `setup()` for nothing — and re-importing the same specs could not pick up an
   * edited plugin *file* anyway, because the module is already in the loader's
   * cache. Changing the list is how a user asks for that work.
   *
   * A plugin that now fails to load is recorded and pushed as `plugin.error`;
   * it never aborts the reload, exactly as at cold start.
   */
  const syncPlugins = async (): Promise<void> => {
    if (!ownsPlugins) return;
    const next = pluginKey(ws);
    if (next === pluginSpecs) return;
    pluginSpecs = next;

    const previous = host;
    // Providers first, then the plugins that own them: a namespace left
    // registered would keep evaluating through a torn-down plugin's context,
    // and its subscriptions would never be released.
    for (const ns of new Set(previous.indicators().map((reg) => reg.ns))) {
      indicators.unregisterNamespace(ns);
    }
    if (isLoadable(previous)) {
      await previous.dispose().catch((err: unknown) => {
        logger.error(`disposing plugins failed: ${errorMessage(err)}`);
      });
    }

    const replacement = buildPluginHost();
    host = replacement;
    // `load()` never rejects — a plugin's own failure is data by then.
    await replacement.load();
    for (const registration of replacement.indicators()) indicators.register(registration);
  };

  /**
   * One reload: swap the workspace, re-load plugins if the list moved, re-bind
   * indicators, re-evaluate staleness. Running processes are never touched —
   * they keep their spawn-time definition and are reported `stale` instead
   * (SPEC §8). On failure the last-good workspace stays in service and the error
   * is surfaced through `Snapshot.configError` and the notification.
   *
   * It never rejects: its callers are a file watcher and an RPC, and neither has
   * anywhere to put a rejection except the daemon's unhandled-rejection handler.
   */
  const reload = async (): Promise<ReloadOutcome> => {
    if (shutdownPromise !== undefined) return { ok: false, error: "the daemon is shutting down" };

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
    reportConfigWarnings(ws);
    if (!findProfile(ws, activeProfile)) {
      const fallback = ws.defaultProfile;
      logger.warn(`active profile "${activeProfile}" is gone; falling back to "${fallback}"`);
      activeProfile = fallback;
    }

    try {
      await syncPlugins();
      await indicators.rebind();
    } catch (err) {
      // The workspace is already swapped, so there is no going back: report it
      // and serve the new config with whatever re-bound successfully.
      logger.error(`applying the reloaded config failed: ${errorMessage(err)}`);
    }
    // Every tracked id, so the comparison both sets and clears the flag.
    supervisor.markStale(supervisor.states().map((s) => s.targetId));

    server?.broadcast("config.reloaded", {
      ok: true,
      stale: staleIds(),
      snapshot: buildSnapshot(handlerDeps),
    });
    return { ok: true };
  };

  /** Resumes after the in-flight reload, so a burst ends on the last save. */
  const followUp = (): Promise<ReloadOutcome> => {
    queuedReload = undefined;
    return requestReload();
  };

  /**
   * The only way a reload starts. Two of them must never overlap — they write
   * `ws`, the plugin host and every indicator binding — and a save arriving
   * mid-reload must not be lost, because the reload in flight read the file
   * *before* it. So: one runs, and everything that arrives meanwhile becomes a
   * single follow-up rather than one reload per event.
   */
  const requestReload = (): Promise<ReloadOutcome> => {
    const inFlight = reloading;
    if (inFlight !== undefined) {
      queuedReload ??= inFlight.then(followUp, followUp);
      return queuedReload;
    }
    const work = reload().finally(() => {
      reloading = undefined;
    });
    reloading = work;
    return work;
  };

  const staleIds = (): TargetId[] => supervisor.states().filter((s) => s.stale).map((s) => s.targetId);

  // --- recovery -------------------------------------------------------------

  /**
   * Says out loud what the recovery pass did.
   *
   * A daemon that quietly adopts or kills processes it did not start is
   * indistinguishable from one that lost them: whoever reads `u8 daemon logs`
   * after an unclean stop has to be able to see, per target, which processes
   * came back under supervision and which were stopped because nothing could
   * supervise them again. The adopted ones additionally carry the log caveat in
   * their own service log, where `u8 logs <target>` shows it.
   */
  const reportRecovery = (report: ReconcileReport): void => {
    for (const proc of report.adopted) {
      logger.info(
        `adopted ${proc.targetId} (pid ${proc.pid}) from a previous daemon: ${proc.reason} — ` +
          "live log capture is not available for it until it is restarted",
      );
    }
    for (const proc of report.reaped) {
      logger.warn(`stopped ${proc.targetId} (pid ${proc.pid}) left by a previous daemon: ${proc.reason}`);
    }
    for (const proc of report.dropped) {
      logger.debug(`ignoring the record of ${proc.targetId} (pid ${proc.pid}): ${proc.reason}`);
    }
  };

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
    // Through the same gate as the watcher: a `workspace.reload` racing a save
    // would otherwise be the one pair of reloads that *can* overlap.
    reload: requestReload,
    // Persist first: a daemon left running a profile it could not remember
    // would answer the RPC with a failure and then act on the new selection
    // anyway, and the next untargeted start would hit the wrong targets.
    saveProfile: async (name: string) => {
      await store.setActiveProfile(name);
      activeProfile = name;
    },
    track,
    shuttingDown: () => shutdownPromise !== undefined,
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
    // Before the socket is closed and unlinked, which is otherwise exactly the
    // change the watchdog exists to notice.
    if (stateTimer !== undefined) clearInterval(stateTimer);
    stateTimer = undefined;
    // Before anything is torn down: a save landing mid-shutdown must not start
    // re-binding indicators that are on their way out.
    stopWatching?.();
    stopWatching = undefined;

    // Tell clients first: `end()` flushes what is queued, so this notification
    // still reaches them even though the socket closes moments later.
    server?.broadcast("daemon.shutdown", { reason });

    engine.cancelAll(`daemon is shutting down (${reason})`);
    await Promise.all([
      supervisor.stopAll().catch((err: unknown) => {
        logger.error(`stopping services failed: ${errorMessage(err)}`);
      }),
      // `cancelAll` only *asks*: a task or hook that traps SIGTERM keeps running
      // until the process layer escalates, and a daemon that exits before then
      // leaves it behind with nothing left to reap it. Bounded, because that is
      // exactly the case that may never finish.
      engine.drain(ws.limits.stopTimeoutMs + DRAIN_GRACE_MS).catch((err: unknown) => {
        logger.error(`draining runs failed: ${errorMessage(err)}`);
      }),
      // Providers first, then the plugins that own them: a teardown releasing
      // what a poll still in flight is reading would be the one race worth
      // avoiding here.
      indicators
        .stop()
        .catch((err: unknown) => {
          logger.error(`stopping indicators failed: ${errorMessage(err)}`);
        })
        .then(async () => {
          const current = host;
          if (!isLoadable(current)) return;
          await current.dispose().catch((err: unknown) => {
            logger.error(`disposing plugins failed: ${errorMessage(err)}`);
          });
        }),
    ]);

    // A second pass, over the set as it stands *now*: the first one worked from
    // the targets the supervisor knew about when it began, and a run still in
    // flight can have spawned a service after that. Nothing else would ever own
    // that process — the next daemon reports the target `stopped`.
    await supervisor.stopAll().catch((err: unknown) => {
      logger.error(`the final stop pass failed: ${errorMessage(err)}`);
    });

    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        logger.warn(`disposing a subscription threw: ${errorMessage(err)}`);
      }
    }

    listening = false;
    if (server) await server.close().catch(() => undefined);
    // After the last stop pass, so what it flushes is the empty set: a record
    // left behind here would send the next daemon hunting for a pid that this
    // one has just stopped.
    await journal.dispose().catch((err: unknown) => {
      logger.warn(`flushing the supervised-process journal failed: ${errorMessage(err)}`);
    });
    await removeOwnPidFile(paths.pidFile, logger);
    logger.info("stopped");
    resolveStopped(reason);
  };

  // --- start ----------------------------------------------------------------

  const start = async (): Promise<void> => {
    if (listening) return;
    await mkdir(paths.dir, { recursive: true });

    // First of all, and before anything can be spawned: services a previous
    // daemon left running are either taken back or stopped here, so no plugin,
    // indicator or client ever sees a target reported `stopped` while its
    // process is alive — and `u8 start` cannot double it.
    reportRecovery(await supervisor.reconcile());

    // Before the registry starts: plugin providers have to be in place for the
    // first activation pass, or every plugin cell would sit empty until the
    // next rebind. `load()` swallows a plugin's failure by contract.
    const initial = host;
    if (isLoadable(initial)) await initial.load();
    for (const registration of initial.indicators()) indicators.register(registration);
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
    socketId = identify(paths.socket);
    stateTimer = setInterval(watchState, STATE_WATCH_MS);
    // Background, like every other daemon timer: the listening socket is what
    // keeps the process alive, and `doShutdown` clears this one first.
    stateTimer.unref();

    // Last: a reload that ran before the socket was bound would have nobody to
    // tell, and `config.reloaded` is how a client learns its snapshot moved.
    stopWatching = watchConfig({
      configPath,
      baseline: loadedSignature,
      logger,
      onChange: () => {
        void requestReload().catch((err: unknown) => {
          logger.error(`config reload failed: ${errorMessage(err)}`);
        });
      },
    });

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
 * Identifies the set of plugins a workspace asks for, in load order — built-in
 * toggles included, since disabling `git` is as much a change to the host as
 * dropping a local plugin file. Comparing it is what keeps an unrelated edit
 * from tearing every plugin down and setting it back up.
 */
function pluginKey(ws: NormalizedWorkspace): string {
  return pluginSources(ws)
    .map((source) => source.spec)
    .join("\n");
}

/**
 * True for a host the daemon owns the lifecycle of. A test may inject a plain
 * {@link PluginHost} (nothing to load, nothing to dispose), so the two are told
 * apart here rather than forced into one shape.
 *
 * Both halves are checked: a host with only one of them would otherwise pass
 * here and throw a `TypeError` from inside `Promise.all` during shutdown, which
 * is the one place a throw leaves `stopped` unresolved forever.
 */
function isLoadable(host: PluginHost | LoadablePluginHost): host is LoadablePluginHost {
  const candidate = host as LoadablePluginHost;
  return typeof candidate.load === "function" && typeof candidate.dispose === "function";
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
