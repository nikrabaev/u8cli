/**
 * The normalized workspace model.
 *
 * Everything downstream of config loading consumes THIS, never the raw JSONC
 * shape. The two invariants that make the rest of the codebase simple:
 *
 *  1. Every runnable thing is a subapp. An app declared without `subapps` is
 *     normalized into an app holding a single *implicit* subapp whose target id
 *     is just the app name.
 *  2. Every path is absolute and every env map is fully merged
 *     (workspace → app → subapp) by the time it lands here.
 */

/** `"gateway"` (implicit subapp) or `"platform.shell"` (explicit subapp). */
export type TargetId = string;

export type RestartPolicy = "no" | "on-crash";

export type CommandKind = "service" | "task";

export type CommandSource = "core" | "plugin" | "config";

export interface HealthCheckDef {
  /** URL probed with GET; 2xx/3xx counts as healthy. */
  http?: string;
  /** Shell command; exit 0 counts as healthy. */
  cmd?: string;
  intervalMs: number;
  timeoutMs: number;
  /** Consecutive failures before flipping to `unhealthy`. */
  threshold: number;
}

export interface NormalizedSubapp {
  /** `app` for implicit subapps, `app.subapp` otherwise. */
  id: TargetId;
  appName: string;
  /** Subapp name; equals the app name when implicit. */
  name: string;
  implicit: boolean;
  /** Absolute working directory. */
  cwd: string;
  /** Script name → shell string. `start`/`stop` feed the core commands. */
  scripts: Record<string, string>;
  /** Fully merged: daemon env is applied at spawn time, not here. */
  env: Record<string, string>;
  /** Resolved to concrete subapp ids (an app dependency expands to its subapps). */
  dependsOn: TargetId[];
  health?: HealthCheckDef;
  restart: RestartPolicy;
  /** Overrides `templates.subapp`. */
  template?: string;
  /** Max wait for this subapp to become ready when something depends on it. */
  readyTimeoutMs: number;
  /** SIGTERM → SIGKILL grace period. */
  stopTimeoutMs: number;
}

export interface NormalizedApp {
  name: string;
  /** Absolute repo root. */
  path: string;
  /** Overrides `templates.app`. */
  template?: string;
  subapps: NormalizedSubapp[];
}

export interface NormalizedProfile {
  name: string;
  isDefault: boolean;
  /** Target strings as authored (apps and/or subapps). */
  targets: string[];
  /** Expanded, de-duplicated, config-order subapp ids. */
  subappIds: TargetId[];
}

export interface NormalizedCommand {
  /** Canonical name: `app:start`, `git:pull`, or a bare user name like `test`. */
  name: string;
  kind: CommandKind;
  source: CommandSource;
  /** Set when `source === "plugin"`. */
  pluginName?: string;
  description?: string;
  /** Shared script, run in each matched target's cwd. */
  script?: string;
  /** Per-target overrides. `null` explicitly excludes a target. */
  targetScripts: Record<TargetId, string | null>;
  /** Overrides the workspace-level task concurrency cap. */
  concurrency?: number;
  /** Shell hooks declared in config; plugin hooks are registered separately. */
  hooks: { pre: string[]; post: string[] };
}

/** A `{x@name}` indicator declared in config: a shell command polled per target. */
export interface CustomIndicatorDef {
  name: string;
  cmd: string;
  intervalMs: number;
  /** Whether the command runs once per subapp or once per app. */
  scope: "subapp" | "app";
}

export interface PluginRef {
  /** npm package name or a path relative to the workspace root. */
  spec: string;
  /** Resolved absolute path for local specs; undefined for bare package names. */
  resolved?: string;
}

export interface Limits {
  logMaxBytes: number;
  logKeep: number;
  taskRunsKeep: number;
  stopTimeoutMs: number;
  readyTimeoutMs: number;
  taskConcurrency: number;
  daemonIdleMs: number;
}

export interface Templates {
  app: string;
  subapp: string;
}

export interface NormalizedWorkspace {
  /** Real (symlink-resolved) path of `u8.jsonc`. */
  configPath: string;
  /** Directory containing the config; the base for all relative paths. */
  rootDir: string;
  name: string;
  /** Hash of `configPath`; also the state-dir name. */
  id: string;
  templates: Templates;
  apps: NormalizedApp[];
  /** Flat list of every subapp across every app, in config order. */
  subapps: NormalizedSubapp[];
  profiles: NormalizedProfile[];
  defaultProfile: string;
  /** Config-declared commands plus the three core `app:*` commands. */
  commands: NormalizedCommand[];
  indicators: CustomIndicatorDef[];
  plugins: PluginRef[];
  builtins: { git: boolean; health: boolean };
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  logMaxBytes: 10 * 1024 * 1024,
  logKeep: 3,
  taskRunsKeep: 20,
  stopTimeoutMs: 10_000,
  readyTimeoutMs: 60_000,
  taskConcurrency: 4,
  daemonIdleMs: 10 * 60_000,
};

/**
 * `max(n):pad(n)` rather than a bare `pad(n)`: padding alone only sets a minimum
 * width, so one long name would shift every column to its right on that row.
 */
export const DEFAULT_TEMPLATES: Templates = {
  app: "{app@name:max(24):pad(24)} {app@dirname:dim} {git@branch:color(yellow):max(20)} {git@dirty:color(red)}",
  subapp: "  {app@status} {app@name:max(22):pad(22)} {health@status}",
};

export const DEFAULT_HEALTH = {
  intervalMs: 5_000,
  timeoutMs: 2_000,
  threshold: 2,
} as const;

/** Namespaces users may not claim for bare command names or `x@` indicators. */
export const CORE_COMMAND_NAMESPACE = "app";

export const CORE_COMMANDS = ["app:start", "app:stop", "app:restart"] as const;

// ---------------------------------------------------------------------------
// Lookup helpers — pure functions over the normalized model.
// ---------------------------------------------------------------------------

export function findApp(ws: NormalizedWorkspace, name: string): NormalizedApp | undefined {
  return ws.apps.find((a) => a.name === name);
}

export function findSubapp(ws: NormalizedWorkspace, id: TargetId): NormalizedSubapp | undefined {
  return ws.subapps.find((s) => s.id === id);
}

export function findProfile(ws: NormalizedWorkspace, name: string): NormalizedProfile | undefined {
  return ws.profiles.find((p) => p.name === name);
}

export function findCommand(ws: NormalizedWorkspace, name: string): NormalizedCommand | undefined {
  return ws.commands.find((c) => c.name === name);
}
