/**
 * The normalized workspace model.
 *
 * Everything downstream of config loading consumes THIS, never the raw JSONC
 * shape. The two invariants that make the rest of the codebase simple:
 *
 *  1. Every runnable thing is an app. A repo declared without `apps` is
 *     normalized into a repo holding a single *implicit* app whose target id
 *     is just the repo name.
 *  2. Every path is absolute and every env map is fully merged
 *     (workspace → repo → app) by the time it lands here.
 */

/** `"gateway"` (implicit app) or `"platform.shell"` (explicit app). */
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

export interface NormalizedApp {
  /** `repo` for implicit apps, `repo.app` otherwise. */
  id: TargetId;
  repoName: string;
  /** App name; equals the repo name when implicit. */
  name: string;
  implicit: boolean;
  /** Absolute working directory. */
  cwd: string;
  /** Script name → shell string. `start`/`stop` feed the core commands. */
  scripts: Record<string, string>;
  /** Fully merged: daemon env is applied at spawn time, not here. */
  env: Record<string, string>;
  /** Resolved to concrete app ids (a repo dependency expands to its apps). */
  dependsOn: TargetId[];
  health?: HealthCheckDef;
  restart: RestartPolicy;
  /** Overrides `templates.app`. */
  template?: string;
  /** Max wait for this app to become ready when something depends on it. */
  readyTimeoutMs: number;
  /** SIGTERM → SIGKILL grace period. */
  stopTimeoutMs: number;
}

export interface NormalizedRepo {
  name: string;
  /** Absolute repo root. */
  path: string;
  /** Overrides `templates.repo`. */
  template?: string;
  apps: NormalizedApp[];
}

export interface NormalizedProfile {
  name: string;
  isDefault: boolean;
  /** Target strings as authored (repos and/or apps). */
  targets: string[];
  /** Expanded, de-duplicated, config-order app ids. */
  appIds: TargetId[];
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
  /** Whether the command runs once per app or once per repo. */
  scope: "app" | "repo";
}

export interface PluginRef {
  /** npm package name or a path relative to the workspace root. */
  spec: string;
  /** Resolved absolute path for local specs; undefined for bare package names. */
  resolved?: string;
  /**
   * Passed verbatim to the plugin's factory export. A plugin that needs
   * configuration exports a function taking these instead of a definition
   * object; options given to a plugin with no factory are a config error, since
   * silently ignoring them would look like the setting had taken effect.
   */
  options?: Record<string, unknown>;
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
  repo: string;
  app: string;
}

/** Which built-in plugins are active. All default to on except `protos`, which
 * has nothing to do until a workspace names the packages it shares. */
export interface BuiltinFlags {
  git: boolean;
  health: boolean;
  protos: boolean;
}

/**
 * `builtins.protos` — links locally-built shared packages into the apps that
 * consume them, so a contract change can be tried end to end before it is
 * published. Today that means yalc.
 */
export interface ProtosOptions {
  /** Shared package names, e.g. `["@myorg/protos", "@myorg/react-query"]`. */
  packages: string[];
  /** How often the installed/linked versions are re-read. */
  intervalMs: number;
}

export const DEFAULT_PROTOS_INTERVAL_MS = 10_000;

export interface NormalizedWorkspace {
  /** Real (symlink-resolved) path of `u8.jsonc`. */
  configPath: string;
  /** Directory containing the config; the base for all relative paths. */
  rootDir: string;
  name: string;
  /** Hash of `configPath`; also the state-dir name. */
  id: string;
  templates: Templates;
  repos: NormalizedRepo[];
  /** Flat list of every app across every repo, in config order. */
  apps: NormalizedApp[];
  profiles: NormalizedProfile[];
  defaultProfile: string;
  /** Config-declared commands plus the three core `app:*` commands. */
  commands: NormalizedCommand[];
  indicators: CustomIndicatorDef[];
  plugins: PluginRef[];
  builtins: BuiltinFlags;
  /**
   * Options for the built-ins, keyed by built-in name. Separate from the enable
   * flags so `builtins.protos: false` and "configured but disabled" stay
   * distinguishable, and so the host can hand a built-in its options the same
   * way it hands a third-party plugin {@link PluginRef.options}.
   */
  builtinOptions: Record<string, Record<string, unknown>>;
  limits: Limits;
  /**
   * Non-fatal load diagnostics, `path: message` per line — today, template
   * typos (SPEC §4). Deliberately *not* `ConfigError` issues: a bad token
   * renders as a red `{ns@name!}` marker and must never stop a workspace
   * loading, so these are carried for the daemon and CLI to surface instead of
   * thrown. Empty when the config is clean.
   */
  warnings: string[];
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
  repo: "{repo@name:max(24):pad(24)} {repo@dirname:dim} {git@branch:color(yellow):max(20)} {git@dirty:color(red)}",
  app: "  {app@status:pad(8)} {app@name:max(22):pad(22)} {health@status:pad(9)}",
};

export const DEFAULT_HEALTH = {
  intervalMs: 5_000,
  timeoutMs: 2_000,
  threshold: 2,
} as const;

/** Namespaces users may not claim for bare command names or `x@` indicators. */
export const CORE_COMMAND_NAMESPACE = "app";

/**
 * Namespace of the repo-scope core indicators (`{repo@name}`, `{repo@status}`) —
 * the header row's counterpart to `app@`. Reserved like `app`, so a plugin
 * cannot shadow the tokens every repo template is written with.
 */
export const REPO_NAMESPACE = "repo";

export const CORE_COMMANDS = ["app:start", "app:stop", "app:restart"] as const;

// ---------------------------------------------------------------------------
// Lookup helpers — pure functions over the normalized model.
// ---------------------------------------------------------------------------

export function findRepo(ws: NormalizedWorkspace, name: string): NormalizedRepo | undefined {
  return ws.repos.find((r) => r.name === name);
}

export function findApp(ws: NormalizedWorkspace, id: TargetId): NormalizedApp | undefined {
  return ws.apps.find((a) => a.id === id);
}

export function findProfile(ws: NormalizedWorkspace, name: string): NormalizedProfile | undefined {
  return ws.profiles.find((p) => p.name === name);
}

export function findCommand(ws: NormalizedWorkspace, name: string): NormalizedCommand | undefined {
  return ws.commands.find((c) => c.name === name);
}
