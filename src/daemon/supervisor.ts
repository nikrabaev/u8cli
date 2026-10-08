/**
 * Service supervision: one child process per target, plus the crash/restart policy.
 *
 * The supervisor is the only component that owns a running child. It knows
 * nothing about `dependsOn` ordering or readiness — the engine sequences those —
 * so its whole job is: spawn, decide whether an exit was wanted, and bring the
 * process back on a backoff ladder when the config asks for it.
 *
 * Five rules drive the design:
 *  - **A target owns exactly one process.** Its definition is normally the
 *    app's `start` script, but a `kind: "service"` command (SPEC §2.5) may
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
 *  - **Ownership outlives the daemon.** Every spawn and every exit is written to
 *    the journal in `state.ts`, and {@link ManagedSupervisor.reconcile} reads it
 *    back at startup: a daemon that was SIGKILLed leaves its services running,
 *    and the next one adopts them instead of reporting them stopped and
 *    starting a second copy.
 *  - **Every timer is unref'd.** A pending restart backoff must never be the
 *    reason a daemon with nothing to do stays alive.
 */
import { commandTargets, coreStartScript, coreStopScript, findApp, findCommand } from "../config/index.js";
import type { NormalizedApp, NormalizedWorkspace, TargetId } from "../config/types.js";
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
import type { ProcessExit, ProcessHandle, StopOptions as ProcessStopOptions } from "../process/types.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { StatePaths } from "../util/paths.js";
import type { StartOptions, StopOptions, Supervisor, Unsubscribe, WorkspaceHolder } from "./contracts.js";
import {
  inspectProcesses,
  pidAlive,
  processGroupState,
  PID_IDENTITY_SLACK_MS,
  type SupervisedJournal,
  type SupervisedProcess,
} from "./state.js";

/** How long a freshly spawned process must survive before it counts as `running`. */
export const START_GRACE_MS = 500;

/** Capped exponential ladder (SPEC 5.3); the last entry repeats for later attempts. */
export const RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Consecutive auto-restarts before the supervisor gives up and stays `crashed`. */
export const MAX_RESTART_ATTEMPTS = 10;

/**
 * How often an adopted process is checked for liveness.
 *
 * A re-parented process gives us no `exited` event to wait on — the only honest
 * substitute is asking the kernel. It is a `kill(pid, 0)`, so the cost is a
 * syscall per adopted service per quarter second, and it doubles as the resolution
 * of the stop path.
 */
export const ADOPT_POLL_MS = 250;

/**
 * Grace between the SIGTERM and the SIGKILL sent to an orphaned process group
 * during recovery.
 *
 * Deliberately far below `limits.stopTimeoutMs`: this runs before the daemon
 * binds its socket, and every `u8` command is waiting on it. What is being
 * signalled is a group whose leader is already dead, so there is nothing left to
 * shut itself down gracefully.
 */
export const REAP_GRACE_MS = 1_000;

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
   * Where spawns are recorded so they survive this process. Optional so a unit
   * test can build a supervisor without a state dir; a daemon always passes one,
   * because without it a `kill -9` strands every service it owns.
   */
  journal?: SupervisedJournal;
  /**
   * Test seam. The production ladder starts at one second and gives up after ten
   * attempts, which no test can afford to wait through; nothing else overrides it.
   */
  timing?: Partial<SupervisorTiming>;
}

/** What became of one process the previous daemon left behind. */
export interface RecoveredProcess {
  targetId: TargetId;
  pid: number;
  /** Human-readable justification — logged, and worth reading in an incident. */
  reason: string;
}

export interface ReconcileReport {
  /** Back under supervision: status, stop and restart all work; live logs do not. */
  adopted: RecoveredProcess[];
  /** Signalled out of existence, because nothing could supervise them again. */
  reaped: RecoveredProcess[];
  /** Records that named nothing worth acting on (already dead, or a reused pid). */
  dropped: RecoveredProcess[];
}

/**
 * The supervisor plus the recovery pass, which is daemon-internal: it is called
 * exactly once, by `createDaemon`, before the socket is bound. Keeping it off
 * {@link Supervisor} is what lets every other collaborator go on coding against
 * the frozen contract.
 */
export interface ManagedSupervisor extends Supervisor {
  /**
   * Re-establishes ownership of the processes the previous daemon recorded.
   * Resolves once every survivor has been adopted or reaped, so whatever a
   * client sees next is the truth.
   */
  reconcile(): Promise<ReconcileReport>;
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
   * True while the live process is one this daemon inherited rather than
   * spawned. It changes two things and nothing else: there is no output pipe to
   * stream, and an exit carries no status the kernel would tell us about — so
   * both are worded differently rather than reported as something they are not.
   */
  adopted: boolean;
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

export function createSupervisor(deps: SupervisorDeps): ManagedSupervisor {
  const { workspace, paths, logger, journal } = deps;
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
      adopted: false,
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
   * The script the current config would spawn this target from: the app's
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
   * script, so editing the app's own `start` script leaves a `start.debug`
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
    const app = findApp(ws, id);
    const env = Object.entries(app?.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify([via ?? null, script, app?.cwd ?? null, env]);
  };

  /**
   * The daemon's environment plus the app's overrides. The process layer uses
   * `env` verbatim, so this merge — and therefore what the fingerprint records —
   * happens exactly here (SPEC 5.3).
   */
  const spawnEnv = (app: NormalizedApp): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...app.env };
  };

  // --- durable ownership ----------------------------------------------------

  /**
   * Writes the process into the journal so the next daemon can find it.
   *
   * `pgid` is the leader's own pid: `spawnManaged` spawns detached, so the
   * leader is the group leader, and that is the id every signal is addressed to.
   * A handle whose spawn failed reports `-1` and is not worth recording — there
   * is nothing running to recover.
   */
  const remember = (entry: Entry, handle: ProcessHandle, script: string, cwd: string): void => {
    if (handle.pid <= 0 || entry.fingerprint === undefined) return;
    journal?.record({
      targetId: entry.id,
      pid: handle.pid,
      pgid: handle.pid,
      startedAt: handle.startedAt,
      via: entry.via,
      script,
      cwd,
      fingerprint: entry.fingerprint,
    });
  };

  // --- lifecycle ------------------------------------------------------------

  const onExit = (entry: Entry, handle: ProcessHandle, exit: ProcessExit): void => {
    if (entry.handle !== handle) return; // superseded by a newer spawn
    clearGrace(entry);
    entry.offOutput?.();
    entry.offOutput = undefined;
    entry.handle = undefined;
    // Before anything that can throw: what is on disk must never claim to own a
    // process that has already gone.
    journal?.forget(entry.id, handle.pid);

    const adopted = entry.adopted;
    entry.adopted = false;
    const requested = exit.requested || entry.stopRequested;
    notice(entry, exitNotice(exit, adopted));

    const common = { pid: undefined, exitCode: exit.code, signal: exit.signal, stale: false };

    if (requested) {
      entry.stopRequested = false;
      setState(entry, { ...common, status: "stopped", restartAttempts: 0, lastError: undefined });
      closeLog(entry);
      return;
    }

    const reason = crashReason(exit, adopted);
    const policy = findApp(workspace.current(), entry.id)?.restart ?? "no";
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

    const app = findApp(ws, entry.id);
    if (!app) {
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

    let handle: ProcessHandle;
    try {
      handle = spawnManaged(
        { script, cwd: app.cwd, env: spawnEnv(app) },
        { stopTimeoutMs: app.stopTimeoutMs, logger },
      );
    } catch (err) {
      // `spawnManaged` throws only when there was no process to attach a
      // lifecycle to, so this failure never reaches `onExit` — and everything
      // `onExit` is *for* has to happen here instead, or the target ends up
      // reported `stopped`, indistinguishable from one nobody has started, with
      // an empty log behind the `u8 logs <target>` the CLI is about to print.
      // No restart ladder: a `path` that names a file will not become a
      // directory by being retried a second later.
      const message = errorMessage(err);
      notice(entry, `spawn failed: ${message}`);
      setState(entry, {
        status: "crashed",
        pid: undefined,
        startedAt: undefined,
        exitCode: undefined,
        signal: undefined,
        lastError: message,
        stale: false,
        restartAttempts: auto ? entry.state.restartAttempts : 0,
      });
      closeLog(entry);
      throw err;
    }

    entry.handle = handle;
    entry.stopRequested = false;
    entry.adopted = false;
    entry.via = via;
    // The script as spawned, not as the config reads now: a reload landing
    // between the engine resolving it and this spawn must leave the process
    // reported as stale, which is exactly what it is.
    entry.fingerprint = fingerprintOf(ws, entry.id, via, script);
    entry.offOutput = handle.onOutput((stream, text, ts) => appendLog(entry, stream, text, ts));
    // Immediately, and before the state is published: from here on the process
    // exists, and a daemon that dies in the next millisecond must still leave
    // behind something that names it.
    remember(entry, handle, script, app.cwd);

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
    app: NormalizedApp,
    timeoutMs: number,
  ): Promise<void> => {
    try {
      const result = await exec(script, { cwd: app.cwd, env: app.env, timeoutMs });
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
    const app = findApp(ws, entry.id);
    const timeoutMs = opts.timeoutMs ?? app?.stopTimeoutMs ?? ws.limits.stopTimeoutMs;

    entry.stopRequested = true;
    setState(entry, { status: "stopping" });

    const stopScript = coreStopScript(ws, entry.id);
    if (stopScript !== null && app) await runStopScript(entry, stopScript, app, timeoutMs);

    // Unconditional: the stop script may have done nothing, or only half the job.
    // `onExit` was subscribed to `exited` at spawn time, so it has already run by
    // the time this resolves and `entry.state` is settled.
    await handle.stop({ timeoutMs });
    return { ...entry.state };
  };

  // --- recovery -------------------------------------------------------------

  /**
   * Re-establishes ownership of a process this daemon did not spawn.
   *
   * Everything a supervisor needs is still reachable through the kernel: the pid
   * says whether it lives, and the process group says how to stop it. The one
   * thing that is gone for good is the stdout pipe — it belonged to a process
   * that no longer exists — so {@link ProcessHandle.onOutput} accepts listeners
   * and never calls them, and the caller says so out loud in the service log
   * rather than leaving `u8 logs -f` looking merely quiet.
   */
  const adoptHandle = (rec: SupervisedProcess): ProcessHandle => {
    const listeners = new Set<(stream: LogStream, text: string, ts: number) => void>();
    let exit: ProcessExit | null = null;
    let requested = false;
    let poll: NodeJS.Timeout | undefined;
    let resolveExited!: (e: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExited = resolve;
    });

    const settle = (): void => {
      if (exit) return;
      if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
      }
      // The leader is gone; sweep whatever it left in its group, exactly as
      // `spawnManaged` does — the pid is still reserved while the group has
      // members, so this addresses our survivors or nobody.
      signalGroup("SIGKILL");
      // No wait status: nothing in this process ever wait()ed on it, and
      // inventing one would be a lie a dashboard would print.
      exit = { code: null, signal: null, durationMs: Date.now() - rec.startedAt, requested };
      resolveExited(exit);
    };

    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-rec.pgid, sig);
      } catch {
        // ESRCH (gone) and EPERM (not ours to signal) are both answers the
        // liveness poll reports on its own terms.
      }
    };

    poll = setInterval(() => {
      if (!pidAlive(rec.pid)) settle();
    }, ADOPT_POLL_MS);
    // Background, like every supervisor timer: an adopted service must not be
    // the reason a daemon with nothing to do stays alive.
    poll.unref();

    return {
      pid: rec.pid,
      startedAt: rec.startedAt,
      exited,
      async stop(o?: ProcessStopOptions): Promise<ProcessExit> {
        if (exit) return exit;
        requested = true;
        const grace = o?.timeoutMs ?? workspace.current().limits.stopTimeoutMs;
        signalGroup(o?.signal ?? "SIGTERM");
        const escalate = setTimeout(() => signalGroup("SIGKILL"), grace);
        escalate.unref();
        try {
          return await exited;
        } finally {
          clearTimeout(escalate);
        }
      },
      kill(signal: NodeJS.Signals = "SIGTERM"): void {
        if (exit) return;
        signalGroup(signal);
      },
      onOutput(cb): () => void {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    };
  };

  /** Puts an inherited process back under supervision, log caveat and all. */
  const adopt = (entry: Entry, rec: SupervisedProcess): void => {
    const ws = workspace.current();
    const handle = adoptHandle(rec);
    entry.handle = handle;
    entry.adopted = true;
    entry.stopRequested = false;
    entry.via = rec.via;
    entry.fingerprint = rec.fingerprint;
    entry.offOutput = handle.onOutput((stream, text, ts) => appendLog(entry, stream, text, ts));

    // Re-recorded under this daemon: the journal has to describe *this*
    // process's owner, or a second crash would find nothing to adopt.
    remember(entry, handle, rec.script, rec.cwd);

    notice(
      entry,
      `adopted pid=${rec.pid} from a previous daemon${rec.via === undefined ? "" : ` via ${rec.via}`} — ` +
        "it is supervised again (status, stop and restart all work), but its output pipe died with that " +
        "daemon: no further live log lines will be captured until the target is restarted",
    );

    setState(entry, {
      // It outlived its start grace under the previous daemon; there is nothing
      // left to decide, and reporting `starting` would restart that clock for a
      // process that has been up for hours.
      status: "running",
      pid: rec.pid,
      startedAt: rec.startedAt,
      exitCode: undefined,
      signal: undefined,
      lastError: undefined,
      restartAttempts: 0,
      stale: rec.fingerprint !== fingerprintOf(ws, entry.id, rec.via, definedScript(ws, entry.id, rec.via)),
    });

    void handle.exited
      .then((result) => {
        onExit(entry, handle, result);
      })
      .catch((err: unknown) => {
        logger.error(`supervisor: exit handling failed for ${entry.id}: ${errorMessage(err)}`);
      });
  };

  /**
   * SIGTERM then SIGKILL to a group whose leader is already dead.
   *
   * Nothing can adopt a leaderless group: there is no process whose identity can
   * be confirmed and no lifecycle to hang a status on. Leaving it would be
   * worse than killing it — the next `u8 start` would run a second copy beside
   * it, which is the failure this whole pass exists to prevent.
   */
  const reapGroup = async (pgid: number): Promise<boolean> => {
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pgid, sig);
      } catch {
        // Gone between the check and the signal; the poll below is the truth.
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + REAP_GRACE_MS;
    while (Date.now() < deadline) {
      if (processGroupState(pgid) !== "alive") return true;
      await sleep(25);
    }
    signal("SIGKILL");
    const hard = Date.now() + REAP_GRACE_MS;
    while (Date.now() < hard) {
      if (processGroupState(pgid) !== "alive") return true;
      await sleep(25);
    }
    return processGroupState(pgid) !== "alive";
  };

  /**
   * Decides what one inherited record still describes.
   *
   * The pid alone is not identity — pid reuse is real, and signalling a
   * stranger's process group is the one mistake here that cannot be taken back —
   * so a live pid is believed only when its real start time matches the one
   * recorded at spawn. When the leader is gone, the *group* is asked instead:
   * the kernel keeps a pid reserved for as long as a group still carries it, so
   * a group that answers under a dead leader can only be the one we spawned.
   */
  const recover = async (
    rec: SupervisedProcess,
    live: Map<number, { startedAt: number }>,
    report: ReconcileReport,
  ): Promise<void> => {
    const found = live.get(rec.pid);
    if (found !== undefined) {
      const drift = Math.abs(found.startedAt - rec.startedAt);
      if (drift <= PID_IDENTITY_SLACK_MS) {
        adopt(ensure(rec.targetId), rec);
        report.adopted.push({ targetId: rec.targetId, pid: rec.pid, reason: "still running" });
        return;
      }
      report.dropped.push({
        targetId: rec.targetId,
        pid: rec.pid,
        reason: `pid ${rec.pid} now belongs to an unrelated process (started ${drift}ms from the record)`,
      });
      return;
    }

    const group = processGroupState(rec.pgid);
    if (group === "gone") {
      report.dropped.push({ targetId: rec.targetId, pid: rec.pid, reason: "already gone" });
      return;
    }
    if (group === "foreign") {
      report.dropped.push({
        targetId: rec.targetId,
        pid: rec.pid,
        reason: `process group ${rec.pgid} is owned by another user and was left alone`,
      });
      return;
    }

    const done = await reapGroup(rec.pgid);
    report.reaped.push({
      targetId: rec.targetId,
      pid: rec.pid,
      reason: done
        ? `its leader had exited, leaving process group ${rec.pgid} behind with nothing able to supervise it`
        : `process group ${rec.pgid} survived SIGKILL; check it by hand`,
    });
    const entry = ensure(rec.targetId);
    notice(
      entry,
      `stopped an orphaned process group (pgid=${rec.pgid}) left by a previous daemon: ` +
        "its leader was already gone, so it could not be supervised again",
    );
    closeLog(entry);
  };

  const reconcile = async (): Promise<ReconcileReport> => {
    const report: ReconcileReport = { adopted: [], reaped: [], dropped: [] };
    const inherited = journal?.inherited() ?? [];
    if (inherited.length === 0) return report;

    let live: Map<number, { startedAt: number }>;
    try {
      live = await inspectProcesses(inherited.map((rec) => rec.pid));
    } catch (err) {
      // Without identities nothing may be adopted *or* killed: both decisions
      // would be guesses about processes that may not be ours. Say exactly what
      // is unaccounted for, and leave it to the person reading the log.
      logger.error(
        `cannot identify the ${inherited.length} process(es) a previous daemon left behind ` +
          `(${errorMessage(err)}); not adopting or stopping any of them: ` +
          inherited.map((rec) => `${rec.targetId}=pid ${rec.pid}`).join(", "),
      );
      for (const rec of inherited) {
        report.dropped.push({
          targetId: rec.targetId,
          pid: rec.pid,
          reason: "could not be identified; left running and unsupervised",
        });
      }
      return report;
    }

    // Serially: reaping waits on signals, and one target's orphan tree has
    // nothing to do with another's — but a startup that fans out kills is far
    // harder to read in a log than one that does them in order.
    for (const rec of inherited) {
      await recover(rec, live, report).catch((err: unknown) => {
        logger.error(`recovering ${rec.targetId} (pid ${rec.pid}) failed: ${errorMessage(err)}`);
        report.dropped.push({ targetId: rec.targetId, pid: rec.pid, reason: errorMessage(err) });
      });
    }
    return report;
  };

  // --- public surface -------------------------------------------------------

  const stateOf = (id: TargetId): ServiceState => {
    const entry = entries.get(id);
    // Unknown targets read as stopped rather than throwing: a client rendering a
    // row for every app must not have to know which ones were ever started.
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
    reconcile,

    states(): ServiceState[] {
      const out: ServiceState[] = [];
      const seen = new Set<TargetId>();
      for (const app of workspace.current().apps) {
        seen.add(app.id);
        out.push(stateOf(app.id));
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

/**
 * An adopted process is reported differently for one reason: nothing in this
 * daemon ever wait()ed on it, so "no status" is a fact about who was watching
 * rather than a failed spawn — and printing the spawn diagnosis would send a
 * reader looking for a problem that is not there.
 */
function exitNotice(exit: ProcessExit, adopted = false): string {
  if (exit.signal !== null) return `exited signal=${exit.signal}`;
  if (exit.code !== null) return `exited code=${exit.code}`;
  return adopted ? "the adopted process is gone (no exit status was available)" : "exited without a status";
}

function crashReason(exit: ProcessExit, adopted = false): string {
  if (exit.signal !== null) return `terminated by ${exit.signal}`;
  if (exit.code !== null) return `exited with code ${exit.code}`;
  return adopted
    ? "the adopted process disappeared; its exit status was not observable"
    : "exited without a status — the process could not be spawned";
}

/** Ref'd on purpose: recovery runs before the socket is bound, with nothing else pending. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDelay(ms: number): string {
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line?.slice(0, 200) ?? "";
}
