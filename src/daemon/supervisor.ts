/**
 * Service supervision: one child process per target, plus the crash/restart policy.
 *
 * The supervisor is the only component that owns a running child. It knows
 * nothing about `dependsOn` ordering or readiness — the engine sequences those —
 * so its whole job is: spawn, decide whether an exit was wanted, and bring the
 * process back on a backoff ladder when the config asks for it.
 *
 * Four rules drive the design:
 *  - **A target owns exactly one process.** Its definition is normally the
 *    subapp's `start` script, but a `kind: "service"` command (SPEC §2.5) may
 *    claim it through {@link StartOptions.script}/{@link StartOptions.via};
 *    starting a *different* definition therefore replaces what is running,
 *    while starting the same one again stays a no-op.
 *  - **A start is only real once it survives a grace period.** A service that
 *    dies in its first half second never reached `running`; reporting it as
 *    running and then instantly as crashed would make every dashboard row lie,
 *    and would reset the restart counter on every failed attempt.
 *  - **A stop is verified, never trusted.** A custom stop script runs first, but
 *    the process group is signalled afterwards regardless: a stop script that
 *    exits 0 without killing anything must not leave an orphan behind.
 *  - **Every timer is unref'd.** A pending restart backoff must never be the
 *    reason a daemon with nothing to do stays alive.
 */
import { commandTargets, coreStartScript, coreStopScript, findCommand, findSubapp } from "../config/index.js";
import type { NormalizedSubapp, NormalizedWorkspace, TargetId } from "../config/types.js";
import type { LogLine, LogStream, ServiceState } from "../ipc/protocol.js";
import {
  createLogWriter,
  exec,
  parseLogLine,
  readLastLines,
  serviceLogPath,
  spawnManaged,
  type LogWriter,
} from "../process/index.js";
import type { ProcessExit, ProcessHandle } from "../process/types.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { StatePaths } from "../util/paths.js";
import type { StartOptions, StopOptions, Supervisor, Unsubscribe, WorkspaceHolder } from "./contracts.js";

/** How long a freshly spawned process must survive before it counts as `running`. */
export const START_GRACE_MS = 500;

/** Capped exponential ladder (SPEC 5.3); the last entry repeats for later attempts. */
export const RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Consecutive auto-restarts before the supervisor gives up and stays `crashed`. */
export const MAX_RESTART_ATTEMPTS = 10;

export interface SupervisorTiming {
  startGraceMs: number;
  restartBackoffMs: readonly number[];
  maxRestartAttempts: number;
}

export interface SupervisorDeps {
  workspace: WorkspaceHolder;
  paths: StatePaths;
  logger: Logger;
  /**
   * Test seam. The production ladder starts at one second and gives up after ten
   * attempts, which no test can afford to wait through; nothing else overrides it.
   */
  timing?: Partial<SupervisorTiming>;
}

/** Backoff for the n-th consecutive restart (1-based), clamped to the ladder's tail. */
export function restartDelayMs(attempt: number, table: readonly number[] = RESTART_BACKOFF_MS): number {
  if (table.length === 0) return 0;
  const index = Math.min(Math.max(attempt, 1), table.length) - 1;
  return table[index] ?? 0;
}

interface Entry {
  readonly id: TargetId;
  state: ServiceState;
  handle?: ProcessHandle;
  offOutput?: () => void;
  writer?: LogWriter;
  /** Resolves once every line written so far is on disk; makes `readLog` deterministic. */
  flush: Promise<void>;
  graceTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  /**
   * Raised before a custom stop script runs. Such a script may kill the process
   * itself, so the exit arrives with `requested: false` and would otherwise be
   * misread as a crash — and auto-restarted.
   */
  stopRequested: boolean;
  /**
   * Callbacks waiting for this target to leave `"starting"`, one per pending
   * {@link Supervisor.waitForSettled}. Drained by {@link setState}, which is
   * the single place a status changes, so the grace timer and an early exit
   * both settle them without either having to know about the other.
   */
  settleWaiters: Set<(state: ServiceState) => void>;
  /**
   * The definition this process belongs to: the name of the `kind: "service"`
   * command that started it, or `undefined` for the target's own `start` script.
   * A start naming a *different* one replaces the process.
   */
  via?: string;
  /** Start script + cwd + env as of the spawn; compared by {@link Supervisor.markStale}. */
  fingerprint?: string;
  /** Serializes start/stop per target so the two can never interleave. */
  lock: Promise<void>;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { workspace, paths, logger } = deps;
  const timing: SupervisorTiming = {
    startGraceMs: deps.timing?.startGraceMs ?? START_GRACE_MS,
    restartBackoffMs: deps.timing?.restartBackoffMs ?? RESTART_BACKOFF_MS,
    maxRestartAttempts: deps.timing?.maxRestartAttempts ?? MAX_RESTART_ATTEMPTS,
  };

  const entries = new Map<TargetId, Entry>();
  const changeSubs = new Set<(s: ServiceState) => void>();
  const logSubs = new Set<(l: LogLine) => void>();

  // --- subscriber plumbing --------------------------------------------------

  /** A listener that throws is a bug in the listener, never a reason to lose a process. */
  const dispatchChange = (entry: Entry): void => {
    for (const cb of [...changeSubs]) {
      try {
        cb({ ...entry.state });
      } catch (err) {
        logger.warn(`service listener threw for ${entry.id}: ${errorMessage(err)}`);
      }
    }
  };

  const dispatchLog = (line: LogLine): void => {
    for (const cb of [...logSubs]) {
      try {
        cb({ ...line });
      } catch (err) {
        logger.warn(`log listener threw for ${line.targetId}: ${errorMessage(err)}`);
      }
    }
  };

  /** `starting` and `stopping` are journeys; these three are destinations. */
  const isSettled = (state: ServiceState): boolean =>
    state.status === "running" || state.status === "crashed" || state.status === "stopped";

  const setState = (entry: Entry, patch: Partial<ServiceState>): void => {
    entry.state = { ...entry.state, ...patch };
    if (isSettled(entry.state) && entry.settleWaiters.size > 0) {
      const waiters = [...entry.settleWaiters];
      entry.settleWaiters.clear();
      for (const resolve of waiters) resolve({ ...entry.state });
    }
    dispatchChange(entry);
  };

  const ensure = (id: TargetId): Entry => {
    const existing = entries.get(id);
    if (existing) return existing;
    const entry: Entry = {
      id,
      state: { targetId: id, status: "stopped", stale: false, restartAttempts: 0 },
      flush: Promise.resolve(),
      stopRequested: false,
      settleWaiters: new Set(),
      lock: Promise.resolve(),
    };
    entries.set(id, entry);
    return entry;
  };

  const exclusive = <T>(entry: Entry, fn: () => Promise<T>): Promise<T> => {
    const run = entry.lock.then(fn);
    entry.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // --- logs -----------------------------------------------------------------

  const writerFor = (entry: Entry): LogWriter => {
    if (entry.writer) return entry.writer;
    const { limits } = workspace.current();
    entry.writer = createLogWriter({
      path: serviceLogPath(paths.serviceLogDir, entry.id),
      maxBytes: limits.logMaxBytes,
      keep: limits.logKeep,
      logger,
    });
    return entry.writer;
  };

  const appendLog = (entry: Entry, stream: LogStream, text: string, ts: number = Date.now()): void => {
    entry.flush = writerFor(entry).write(text, ts);
    dispatchLog({ targetId: entry.id, stream, ts, text });
  };

  /** Lifecycle breadcrumbs — what makes a crash legible when reading the log later. */
  const notice = (entry: Entry, text: string): void => appendLog(entry, "u8", text);

  /** Released as soon as a target settles, so a stopped service holds no fd. */
  const closeLog = (entry: Entry): void => {
    const writer = entry.writer;
    if (!writer) return;
    entry.writer = undefined;
    entry.flush = writer.close();
  };

  // --- timers ---------------------------------------------------------------

  const clearGrace = (entry: Entry): void => {
    if (entry.graceTimer === undefined) return;
    clearTimeout(entry.graceTimer);
    entry.graceTimer = undefined;
  };

  const clearRestart = (entry: Entry): void => {
    if (entry.restartTimer === undefined) return;
    clearTimeout(entry.restartTimer);
    entry.restartTimer = undefined;
  };

  // --- spawn-time definition ------------------------------------------------

  /**
   * The script the current config would spawn this target from: the subapp's
   * `start` script normally, or the per-target script of the `kind: "service"`
   * command that owns the process. `null` means the config no longer defines
   * one — a dropped target, a command that lost the target, or a deleted command.
   */
  const definedScript = (ws: NormalizedWorkspace, id: TargetId, via: string | undefined): string | null => {
    if (via === undefined) return coreStartScript(ws, id);
    const command = findCommand(ws, via);
    if (!command) return null;
    // `null`/absent in the targets map is a skip, which reads the same here as
    // "this command no longer defines a process for this target".
    return commandTargets(ws, command, [id])[0]?.script ?? null;
  };

  /**
   * What `stale` compares (SPEC §8). At spawn time `script` is the one actually
   * handed to the shell; {@link Supervisor.markStale} re-resolves the same
   * definition against the current config and compares the two.
   *
   * The definition is per-process: for a command-started one it is the command's
   * script, so editing the subapp's own `start` script leaves a `start.debug`
   * process alone, and editing (or deleting) `start.debug` is what marks it
   * stale. Anything else would report every command-started target as
   * permanently stale.
   */
  const fingerprintOf = (
    ws: NormalizedWorkspace,
    id: TargetId,
    via: string | undefined,
    script: string | null,
  ): string => {
    const subapp = findSubapp(ws, id);
    const env = Object.entries(subapp?.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([via ?? null, script, subapp?.cwd ?? null, env]);
  };

  /**
   * The daemon's environment plus the subapp's overrides. The process layer uses
   * `env` verbatim, so this merge — and therefore what the fingerprint records —
   * happens exactly here (SPEC 5.3).
   */
  const spawnEnv = (subapp: NormalizedSubapp): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...subapp.env };
  };

  // --- lifecycle ------------------------------------------------------------

  const onExit = (entry: Entry, handle: ProcessHandle, exit: ProcessExit): void => {
    if (entry.handle !== handle) return; // superseded by a newer spawn
    clearGrace(entry);
    entry.offOutput?.();
    entry.offOutput = undefined;
    entry.handle = undefined;

    const requested = exit.requested || entry.stopRequested;
    notice(entry, exitNotice(exit));

    const common = { pid: undefined, exitCode: exit.code, signal: exit.signal, stale: false };

    if (requested) {
      entry.stopRequested = false;
      setState(entry, { ...common, status: "stopped", restartAttempts: 0, lastError: undefined });
      closeLog(entry);
      return;
    }

    const reason = crashReason(exit);
    const policy = findSubapp(workspace.current(), entry.id)?.restart ?? "no";
    if (policy !== "on-crash") {
      setState(entry, { ...common, status: "crashed", lastError: reason });
      closeLog(entry);
      return;
    }

    const attempt = entry.state.restartAttempts + 1;
    if (attempt > timing.maxRestartAttempts) {
      notice(entry, `gave up after ${timing.maxRestartAttempts} attempts`);
      setState(entry, {
        ...common,
        status: "crashed",
        lastError: `gave up after ${timing.maxRestartAttempts} restart attempts (${reason})`,
      });
      closeLog(entry);
      return;
    }

    const delay = restartDelayMs(attempt, timing.restartBackoffMs);
    setState(entry, { ...common, status: "crashed", lastError: reason, restartAttempts: attempt });
    notice(entry, `restarting in ${formatDelay(delay)} (attempt ${attempt}/${timing.maxRestartAttempts})`);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      void exclusive(entry, () => doStart(entry, { force: true }, true)).catch((err: unknown) => {
        // The config can change between the crash and the retry: a target that
        // lost its start script must fail loudly here rather than silently.
        const message = errorMessage(err);
        notice(entry, `restart failed: ${message}`);
        setState(entry, { status: "crashed", lastError: message });
        closeLog(entry);
      });
    }, delay);
    entry.restartTimer.unref();
  };

  /** Assumes the entry lock is held. `auto` marks a restart driven by the backoff timer. */
  const doStart = async (entry: Entry, opts: StartOptions, auto: boolean): Promise<ServiceState> => {
    clearRestart(entry);
    const ws = workspace.current();
    // The backoff ladder resurrects the process that crashed, so it inherits the
    // command that started it. An explicit start naming no command is a plain
    // `app:start` and returns the target to its own `start` script.
    const via = auto ? entry.via : opts.via;
    const script = opts.script ?? definedScript(ws, entry.id, via);

    if (entry.handle) {
      // One process per target, so a start on behalf of a *different* definition
      // — `app:start` over a `start.debug` process, or the other way round —
      // replaces what is running. Re-starting the same definition stays the
      // no-op it has always been, even when a reload has since edited its
      // script: SPEC §8 keeps that process untouched and marks it `stale`, and
      // silently killing it here would make `stale` unobservable. A definition
      // that no longer resolves never replaces anything either — it would tear
      // down a healthy process only to fail below.
      const replaces = script !== null && via !== entry.via;
      if (opts.force !== true && !replaces) return { ...entry.state };
      if (replaces) notice(entry, `replacing the running process${via === undefined ? "" : ` via ${via}`}`);
      await doStop(entry, {});
    }

    const subapp = findSubapp(ws, entry.id);
    if (!subapp) {
      throw new U8Error("UNKNOWN_TARGET", `unknown target "${entry.id}"`, { target: entry.id });
    }
    if (script === null) {
      throw new U8Error(
        "PROCESS_FAILED",
        via === undefined
          ? `target "${entry.id}" has no start script — add "scripts": { "start": ... } to it`
          : `command "${via}" has no script for target "${entry.id}"`,
        { target: entry.id, via },
      );
    }

    const handle = spawnManaged(
      { script, cwd: subapp.cwd, env: spawnEnv(subapp) },
      { stopTimeoutMs: subapp.stopTimeoutMs, logger },
    );

    entry.handle = handle;
    entry.stopRequested = false;
    entry.via = via;
    // The script as spawned, not as the config reads now: a reload landing
    // between the engine resolving it and this spawn must leave the process
    // reported as stale, which is exactly what it is.
    entry.fingerprint = fingerprintOf(ws, entry.id, via, script);
    entry.offOutput = handle.onOutput((stream, text, ts) => appendLog(entry, stream, text, ts));

    setState(entry, {
      status: "starting",
      pid: handle.pid,
      startedAt: handle.startedAt,
      exitCode: undefined,
      signal: undefined,
      lastError: undefined,
      stale: false,
      // A hand-driven start is a fresh lifecycle, including after a give-up;
      // an automatic one must carry the consecutive-failure count forward.
      restartAttempts: auto ? entry.state.restartAttempts : 0,
    });
    notice(entry, `spawned pid=${handle.pid}${via === undefined ? "" : ` via ${via}`}`);

    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined;
      if (entry.handle !== handle || entry.state.status !== "starting") return;
      setState(entry, { status: "running", restartAttempts: 0 });
    }, timing.startGraceMs);
    entry.graceTimer.unref();

    void handle.exited
      .then((exit) => {
        onExit(entry, handle, exit);
      })
      .catch((err: unknown) => {
        logger.error(`supervisor: exit handling failed for ${entry.id}: ${errorMessage(err)}`);
      });

    return { ...entry.state };
  };

  const runStopScript = async (
    entry: Entry,
    script: string,
    subapp: NormalizedSubapp,
    timeoutMs: number,
  ): Promise<void> => {
    try {
      const result = await exec(script, { cwd: subapp.cwd, env: subapp.env, timeoutMs });
      if (result.ok) {
        notice(entry, "stop script finished");
        return;
      }
      const detail = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "none"}`;
      notice(entry, `stop script failed (${detail})`);
      logger.warn(`stop script for ${entry.id} failed`, { detail, stderr: firstLine(result.stderr) });
    } catch (err) {
      // Only an unspawnable shell lands here; a non-zero exit is data, not a throw.
      notice(entry, `stop script failed: ${errorMessage(err)}`);
      logger.warn(`stop script for ${entry.id} could not run: ${errorMessage(err)}`);
    }
  };

  /** Assumes the entry lock is held. */
  const doStop = async (entry: Entry, opts: StopOptions): Promise<ServiceState> => {
    clearRestart(entry);
    const handle = entry.handle;
    if (!handle) {
      // Idempotent: stopping something already down (or crashed) is a no-op that
      // still parks it in `stopped`, because the user asked for it to be down.
      if (entry.state.status !== "stopped") {
        setState(entry, { status: "stopped", pid: undefined, restartAttempts: 0, stale: false });
      }
      closeLog(entry);
      return { ...entry.state };
    }

    const ws = workspace.current();
    const subapp = findSubapp(ws, entry.id);
    const timeoutMs = opts.timeoutMs ?? subapp?.stopTimeoutMs ?? ws.limits.stopTimeoutMs;

    entry.stopRequested = true;
    setState(entry, { status: "stopping" });

    const stopScript = coreStopScript(ws, entry.id);
    if (stopScript !== null && subapp) await runStopScript(entry, stopScript, subapp, timeoutMs);

    // Unconditional: the stop script may have done nothing, or only half the job.
    // `onExit` was subscribed to `exited` at spawn time, so it has already run by
    // the time this resolves and `entry.state` is settled.
    await handle.stop({ timeoutMs });
    return { ...entry.state };
  };

  // --- public surface -------------------------------------------------------

  const stateOf = (id: TargetId): ServiceState => {
    const entry = entries.get(id);
    // Unknown targets read as stopped rather than throwing: a client rendering a
    // row for every subapp must not have to know which ones were ever started.
    return entry ? { ...entry.state } : { targetId: id, status: "stopped", stale: false, restartAttempts: 0 };
  };

  const isRunning = (id: TargetId): boolean => {
    const status = entries.get(id)?.state.status;
    return status === "running" || status === "starting";
  };

  const stop = (id: TargetId, opts?: StopOptions): Promise<ServiceState> => {
    const entry = ensure(id);
    return exclusive(entry, () => doStop(entry, opts ?? {}));
  };

  const start = (id: TargetId, opts?: StartOptions): Promise<ServiceState> => {
    const entry = ensure(id);
    return exclusive(entry, () => doStart(entry, opts ?? {}, false));
  };

  /**
   * The two things that can end a `"starting"` state are the grace timer and
   * the process exiting, and both funnel through {@link setState} — so waiting
   * on the next settled state *is* the race between them, without a second
   * timer to own or a handle to keep a reference to.
   *
   * No timeout: `graceTimer` is always armed for a live spawn, so one of the
   * two always fires. A target that is not currently starting resolves at once.
   */
  const waitForSettled = (id: TargetId): Promise<ServiceState> => {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(stateOf(id));
    if (isSettled(entry.state)) return Promise.resolve({ ...entry.state });
    return new Promise<ServiceState>((resolve) => {
      entry.settleWaiters.add(resolve);
    });
  };

  return {
    state: stateOf,

    states(): ServiceState[] {
      const out: ServiceState[] = [];
      const seen = new Set<TargetId>();
      for (const subapp of workspace.current().subapps) {
        seen.add(subapp.id);
        out.push(stateOf(subapp.id));
      }
      // A target dropped from the config may still own a process; keep reporting
      // it until it settles. Merely *tracked* ids own nothing — `start` on an
      // unknown target creates an entry before it throws, and `stop` accepts any
      // id by design — so reporting those would put phantom rows in every
      // client's snapshot.
      for (const entry of entries.values()) {
        if (!seen.has(entry.id) && entry.state.status !== "stopped") out.push({ ...entry.state });
      }
      return out;
    },

    isRunning,

    runningCount(): number {
      let count = 0;
      for (const entry of entries.values()) if (isRunning(entry.id)) count++;
      return count;
    },

    start,
    waitForSettled,
    stop,

    /**
     * Explicit restart, so it names no command: the target comes back on its own
     * `start` script even if a `kind: "service"` command owned the last process.
     * Only the crash-restart ladder resurrects a command-started process as it
     * was — a user asking for a restart is asking for the target's default.
     */
    async restart(id: TargetId): Promise<ServiceState> {
      await stop(id);
      return start(id, { force: true });
    },

    async stopAll(opts?: StopOptions): Promise<void> {
      await Promise.all(
        [...entries.keys()].map((id) =>
          stop(id, opts).catch((err: unknown) => {
            logger.error(`failed to stop ${id}: ${errorMessage(err)}`);
          }),
        ),
      );
    },

    /**
     * Re-evaluates staleness for the given targets against the current workspace.
     * Pass every id the reload touched (or simply all of them): the comparison
     * both sets and clears the flag, and only a real change is broadcast.
     */
    markStale(ids: readonly TargetId[]): void {
      const ws = workspace.current();
      for (const id of ids) {
        const entry = entries.get(id);
        if (!entry) continue;
        const stale =
          entry.handle !== undefined &&
          entry.fingerprint !== undefined &&
          entry.fingerprint !== fingerprintOf(ws, id, entry.via, definedScript(ws, id, entry.via));
        if (entry.state.stale !== stale) setState(entry, { stale });
      }
    },

    onChange(cb: (state: ServiceState) => void): Unsubscribe {
      changeSubs.add(cb);
      return () => {
        changeSubs.delete(cb);
      };
    },

    onLog(cb: (line: LogLine) => void): Unsubscribe {
      logSubs.add(cb);
      return () => {
        logSubs.delete(cb);
      };
    },

    /**
     * Backfill from disk. The on-disk format (owned by the process layer) carries
     * a timestamp but no stream marker, so every backfilled line reports
     * `"stdout"` — including the `"u8"` lifecycle notices. Live lines from
     * {@link Supervisor.onLog} do carry the real stream.
     */
    async readLog(id: TargetId, lines: number): Promise<LogLine[]> {
      if (lines <= 0) return [];
      await entries.get(id)?.flush; // queued writes must land before we tail
      const raw = await readLastLines(serviceLogPath(paths.serviceLogDir, id), lines);
      return raw.map((line) => {
        const { ts, text } = parseLogLine(line);
        return { targetId: id, stream: "stdout", ts: ts ?? Date.now(), text };
      });
    },
  };
}

function exitNotice(exit: ProcessExit): string {
  if (exit.signal !== null) return `exited signal=${exit.signal}`;
  if (exit.code !== null) return `exited code=${exit.code}`;
  return "exited without a status";
}

function crashReason(exit: ProcessExit): string {
  if (exit.signal !== null) return `terminated by ${exit.signal}`;
  if (exit.code !== null) return `exited with code ${exit.code}`;
  return "exited without a status — the process could not be spawned";
}

function formatDelay(ms: number): string {
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line?.slice(0, 200) ?? "";
}
