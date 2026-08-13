/**
 * Public plugin API. Plugins are trusted code loaded into the daemon process
 * (the vite model), and may contribute indicators, commands, command hooks, and
 * a readiness signal used by `dependsOn` gating.
 */
import type { CommandKind, TargetId } from "../config/types.js";
import type { IndicatorTone, ServiceState } from "../ipc/protocol.js";
import type { ExecOptions, ExecResult } from "../process/types.js";
import type { Logger } from "../util/logger.js";

export type MaybePromise<T> = T | Promise<T>;

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootDir: string;
  configPath: string;
}

export interface AppInfo {
  name: string;
  /** Absolute repo root. */
  path: string;
}

export interface TargetInfo {
  id: TargetId;
  appName: string;
  name: string;
  implicit: boolean;
  /** Absolute working directory of the subapp. */
  cwd: string;
  scripts: Record<string, string>;
  env: Record<string, string>;
  dependsOn: TargetId[];
  hasHealth: boolean;
}

export interface PluginBaseContext {
  workspace: WorkspaceInfo;
  logger: Logger;
  /** Runs a shell command; defaults to the contextual cwd and merged env. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Per-plugin scratch space that survives across invocations. */
  store: Map<string, unknown>;
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export type IndicatorScope = "app" | "subapp";

export type IndicatorUpdate =
  | { mode: "poll"; intervalMs: number }
  | { mode: "event" }
  | { mode: "static" };

/** Return a bare string for the simple case, or an object to add tone/display. */
export type IndicatorResult =
  | string
  | { value: string; display?: string; tone?: IndicatorTone }
  | null
  | undefined;

export interface IndicatorContext extends PluginBaseContext {
  scope: IndicatorScope;
  app: AppInfo;
  /** Present for subapp-scoped indicators. */
  target?: TargetInfo;
  /** App path for app scope, subapp cwd for subapp scope. */
  cwd: string;
  /** Current supervisor state, for subapp scope. */
  service?: ServiceState;
}

export interface IndicatorDef {
  /** Defaults to `"subapp"`. */
  scope?: IndicatorScope;
  description?: string;
  /** Defaults to `{ mode: "poll", intervalMs: 5000 }` when `value` is defined. */
  update?: IndicatorUpdate;
  /** Pull mode: invoked on schedule (poll) or once (static). */
  value?(ctx: IndicatorContext): MaybePromise<IndicatorResult>;
  /**
   * Push mode: invoked once per owner when the provider activates. Call `emit`
   * whenever the value changes; return a disposer to release watchers.
   */
  subscribe?(
    ctx: IndicatorContext,
    emit: (value: IndicatorResult) => void,
  ): MaybePromise<(() => void) | void>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CommandContext extends PluginBaseContext {
  command: string;
  runId: string;
  app: AppInfo;
  target: TargetInfo;
  cwd: string;
  /** Appends a line to this target's run log (and streams it to clients). */
  log(text: string): void;
  /** Aborted when the run is cancelled or the daemon shuts down. */
  signal: AbortSignal;
}

export interface PluginCommandDef {
  /** Defaults to `"task"`. */
  kind?: CommandKind;
  description?: string;
  /** Filter targets this command applies to. Defaults to all selected targets. */
  appliesTo?(target: TargetInfo): boolean;
  /**
   * De-duplication granularity. `"app"` runs the command once per app even when
   * several of its subapps are selected — what `git:pull` wants.
   */
  groupBy?: "target" | "app";
  /** Throw, or return a non-zero number, to fail this target. */
  run(ctx: CommandContext): MaybePromise<void | number>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface HookContext extends PluginBaseContext {
  command: string;
  phase: "pre" | "post";
  runId: string;
  app: AppInfo;
  target: TargetInfo;
  cwd: string;
  /** Present in `post`: how the command fared for this target. */
  result?: HookResult;
}

export interface HookDef {
  /** Throwing aborts this target only; other targets continue. */
  pre?(ctx: HookContext): MaybePromise<void>;
  /** Always runs, including after failure or abort. */
  post?(ctx: HookContext): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// Readiness (dependsOn gating)
// ---------------------------------------------------------------------------

export type ReadinessVerdict = "ready" | "pending" | "n/a";

export interface ReadinessContext extends PluginBaseContext {
  target: TargetInfo;
  service: ServiceState;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export interface PluginSetupContext extends PluginBaseContext {
  /** Every subapp in the workspace, for plugins that pre-index by target. */
  targets: TargetInfo[];
  apps: AppInfo[];
}

export interface PluginDefinition {
  /** Also the reserved namespace for this plugin's commands and indicators. */
  name: string;
  indicators?: Record<string, IndicatorDef>;
  commands?: Record<string, PluginCommandDef>;
  /** Keyed by command name, or `"*"` to bind to every command. */
  hooks?: Record<string, HookDef>;
  /**
   * Contributes to `dependsOn` readiness. Returning `"n/a"` defers to other
   * plugins, and ultimately to the default rule (ready once `running`).
   */
  readiness?(ctx: ReadinessContext): MaybePromise<ReadinessVerdict>;
  setup?(ctx: PluginSetupContext): MaybePromise<void>;
  teardown?(): MaybePromise<void>;
}
