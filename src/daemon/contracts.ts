/**
 * Internal seams between the daemon's moving parts.
 *
 * The daemon is four collaborators wired together: a supervisor owning service
 * processes, an indicator registry owning cached values, an engine owning
 * command runs, and a plugin host contributing to all three. They are defined as
 * interfaces here so each can be built and tested against a fake of the others.
 */
import type { NormalizedWorkspace, TargetId } from "../config/types.js";
import type {
  IndicatorValue,
  LogLine,
  ServiceState,
  SnapshotPlugin,
  TaskProgress,
  TaskResult,
} from "../ipc/protocol.js";
import type {
  HookDef,
  IndicatorDef,
  PluginCommandDef,
  ReadinessVerdict,
  TargetInfo,
} from "../plugin/types.js";
import type { StatePaths } from "../util/paths.js";
import type { Logger } from "../util/logger.js";

export type Unsubscribe = () => void;

/**
 * The workspace can be swapped by a hot reload, so collaborators must read it
 * through this holder rather than capturing it at construction.
 */
export interface WorkspaceHolder {
  current(): NormalizedWorkspace;
}

// ---------------------------------------------------------------------------
// Supervisor — owns service processes
// ---------------------------------------------------------------------------

export interface StartOptions {
  /** Bypasses the "already running" short-circuit (used by restart). */
  force?: boolean;
  /**
   * Supervises this script instead of the target's `start` script — how a
   * `kind: "service"` command (e.g. `start:debug`) takes over a target. A target
   * still owns exactly one process, so starting one replaces the other.
   */
  script?: string;
  /** Command that initiated the start; surfaces in log lines and fingerprints. */
  via?: string;
}

export interface StopOptions {
  timeoutMs?: number;
}

/**
 * Owns spawning, crash detection and restart backoff for one process per target.
 * It deliberately knows nothing about `dependsOn` ordering or readiness — that
 * sequencing belongs to the engine, which calls `start` in the right order.
 */
export interface Supervisor {
  state(id: TargetId): ServiceState;
  states(): ServiceState[];
  isRunning(id: TargetId): boolean;
  runningCount(): number;

  /** Spawns the target's start script. Resolves once the process is spawned. */
  start(id: TargetId, opts?: StartOptions): Promise<ServiceState>;
  /**
   * Resolves once the target has left `"starting"` — i.e. once the start grace
   * decided the spawn was real (`running`) or the process died inside it
   * (`crashed`/`stopped`).
   *
   * {@link start} deliberately returns while the status is still `"starting"`,
   * so its caller can report a run id without waiting. But SPEC §2.5 defines a
   * service as done when it is *running*, so anything that has to say whether a
   * start succeeded — the engine's start pass, and through it `u8 start`'s exit
   * code — must await this instead of reading what `start` returned.
   */
  waitForSettled(id: TargetId): Promise<ServiceState>;
  /** Runs a custom stop script if the app declares one, else signals the group. */
  stop(id: TargetId, opts?: StopOptions): Promise<ServiceState>;
  restart(id: TargetId): Promise<ServiceState>;
  stopAll(opts?: StopOptions): Promise<void>;

  /** Marks running targets whose spawn-time definition no longer matches config. */
  markStale(ids: readonly TargetId[]): void;

  onChange(cb: (state: ServiceState) => void): Unsubscribe;
  onLog(cb: (line: LogLine) => void): Unsubscribe;
  /** Backfill from the rotated log files, newest last. */
  readLog(id: TargetId, lines: number): Promise<LogLine[]>;
}

// ---------------------------------------------------------------------------
// Indicators — owns the value cache
// ---------------------------------------------------------------------------

export interface IndicatorRegistration {
  ns: string;
  name: string;
  def: IndicatorDef;
}

/**
 * Holds every provider and the current value per owner, pushing deltas outward.
 *
 * Implementations MUST sanitize provider output before caching it: values are
 * arbitrary command stdout, and a newline or control character would corrupt
 * every dashboard row. Collapse whitespace runs to a single space and strip
 * C0/C1 control characters.
 */
export interface IndicatorRegistry {
  register(reg: IndicatorRegistration): void;
  /** Drops every provider contributed by a namespace (plugin unload / reload). */
  unregisterNamespace(ns: string): void;

  values(): IndicatorValue[];
  get(ns: string, name: string, owner: string): IndicatorValue | undefined;

  /** Activates providers (starts polls and subscriptions) for the current workspace. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-binds providers to a reloaded workspace, preserving unchanged values. */
  rebind(): Promise<void>;
  /** Forces an immediate re-evaluation, e.g. right after a service state change. */
  refresh(ids?: readonly TargetId[]): void;

  onChange(cb: (values: IndicatorValue[]) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Engine — owns command runs and startup orchestration
// ---------------------------------------------------------------------------

export interface RunHandle {
  runId: string;
  done: Promise<TaskResult>;
}

/**
 * Where a run's target strings are read from. A bare name is that instance's
 * copy, and nothing in an instance ever resolves to base by accident — reaching
 * another instance takes an explicit `name@instance`.
 */
export interface TargetScope {
  /** Defaults to base. */
  instance?: string;
}

export interface StartScope extends TargetScope {
  /**
   * Hold each target's result until it is *ready* — healthy, when it declares a
   * health check — instead of merely running. What a caller that is about to
   * send it requests needs; an interactive start does not, since the dashboard
   * shows health arriving.
   */
  wait?: boolean;
}

export interface RunCommandOptions extends StartScope {
  command: string;
  /** Raw target strings; omitted means the scope's default selection. */
  targets?: string[];
  serial?: boolean;
  concurrency?: number;
}

export type LifecyclePhase = "init" | "teardown";

export interface LifecycleOptions {
  /**
   * Stop the instance's services before any step runs. Teardown undoes what
   * the apps are still using — a database, a compose project — so it must never
   * run underneath them.
   */
  stopFirst?: boolean;
  /**
   * Runs inside the run once every step has, and is told whether they all
   * succeeded. What it does is part of the run: a client awaiting the run id
   * sees it finished only after this resolves, and a rejection fails the run.
   */
  finalize?(ok: boolean): Promise<void>;
}

export interface Engine {
  /** Runs any command (core, config or plugin) across the resolved targets. */
  runCommand(opts: RunCommandOptions): RunHandle;
  /** dependsOn-ordered service start, gated on readiness of each dependency. */
  startTargets(targets?: string[], scope?: StartScope): RunHandle;
  /** Reverse-dependency-ordered stop. */
  stopTargets(targets?: string[], scope?: TargetScope): RunHandle;
  restartTargets(targets?: string[], scope?: StartScope): RunHandle;
  /**
   * Runs an instance's `init` or `teardown` steps as the command
   * `instance:<phase>`: a repo's own steps once in its checkout root, each
   * app's in its directory, with the same logs, progress and hooks as any run.
   */
  runLifecycle(phase: LifecyclePhase, instance: string, opts?: LifecycleOptions): RunHandle;

  /** Resolves for a finished run too — results are retained for a while. */
  awaitRun(runId: string): Promise<TaskResult>;
  cancelAll(reason: string): void;
  /**
   * Resolves once every run still in flight has closed, or after `timeoutMs`.
   *
   * `cancelAll` only *asks*: it signals the abort, and a script that traps
   * SIGTERM keeps running until the process layer escalates to SIGKILL. A
   * daemon that exits before then orphans it, so shutdown must call this after
   * `cancelAll` and before it tears the process down.
   */
  drain(timeoutMs: number): Promise<void>;

  onProgress(cb: (p: TaskProgress) => void): Unsubscribe;
  onFinished(cb: (r: TaskResult) => void): Unsubscribe;
  onLog(cb: (line: LogLine) => void): Unsubscribe;
  /** Backfill of a task run's captured output for a given target. */
  readRunLog(runId: string, targetId: TargetId, lines: number): Promise<LogLine[]>;
}

// ---------------------------------------------------------------------------
// Plugin host — implemented in Phase 8; the engine codes against it now
// ---------------------------------------------------------------------------

export interface BoundHook {
  plugin: string;
  def: HookDef;
}

export interface BoundCommand {
  plugin: string;
  /** Canonical namespaced name, e.g. `git:pull`. */
  name: string;
  def: PluginCommandDef;
}

export interface PluginHost {
  /** Hooks bound to this command name plus those bound to `"*"`, in load order. */
  hooksFor(command: string): BoundHook[];
  commands(): BoundCommand[];
  indicators(): IndicatorRegistration[];
  /** `"n/a"` from every plugin means "fall back to: ready once running". */
  readiness(target: TargetInfo, service: ServiceState): Promise<ReadinessVerdict>;
  list(): SnapshotPlugin[];
}

/** Stand-in used before plugins are loaded, and in tests. */
export const emptyPluginHost: PluginHost = {
  hooksFor: () => [],
  commands: () => [],
  indicators: () => [],
  readiness: async () => "n/a",
  list: () => [],
};

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface DaemonContext {
  workspace: WorkspaceHolder;
  paths: StatePaths;
  logger: Logger;
  supervisor: Supervisor;
  indicators: IndicatorRegistry;
  engine: Engine;
  plugins: PluginHost;
  /** Active profile name; changes via `profile.use`. */
  activeProfile(): string;
  setActiveProfile(name: string): void;
}

/** Converts a normalized app into the shape handed to plugin callbacks. */
export interface TargetInfoResolver {
  targetInfo(id: TargetId): TargetInfo | undefined;
}
