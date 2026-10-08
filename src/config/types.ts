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

/**
 * `"gateway"` (implicit app) or `"platform.shell"` (explicit app) in the base
 * instance; the same with an instance suffix — `"gateway@feat-x"` — anywhere else.
 */
export type TargetId = string;

/**
 * The instance every workspace has: the checkouts and ports `u8.jsonc` itself
 * declares. Its apps and repos carry no suffix, so a workspace that never
 * creates another instance sees exactly the ids it always did.
 */
export const BASE_INSTANCE = "base";

/**
 * Joins an app or repo to the instance it belongs to (`api@feat-x`). Config
 * names may not contain it (see `NAME_PATTERN`), so a qualified id never
 * collides with an authored one and splits unambiguously at its last `@`.
 */
export const INSTANCE_SEPARATOR = "@";

/** `api` + `feat-x` → `api@feat-x`; the base instance leaves the name bare. */
export function qualify(name: string, instance: string): string {
  return instance === BASE_INSTANCE ? name : `${name}${INSTANCE_SEPARATOR}${instance}`;
}

/** The inverse of {@link qualify}: a bare name belongs to the base instance. */
export function splitQualified(qualified: string): { name: string; instance: string } {
  const at = qualified.lastIndexOf(INSTANCE_SEPARATOR);
  if (at <= 0 || at === qualified.length - 1) return { name: qualified, instance: BASE_INSTANCE };
  return { name: qualified.slice(0, at), instance: qualified.slice(at + 1) };
}

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

/** Lifecycle steps of an instance checkout, in the order they run. */
export interface Lifecycle {
  init: string[];
  teardown: string[];
}

export interface RepoLifecycle extends Lifecycle {
  /** Repo-relative paths copied from the base checkout before `init`. */
  copy: string[];
}

export interface NormalizedApp {
  /** `repo` for implicit apps, `repo.app` otherwise — instance-qualified outside base. */
  id: TargetId;
  /** The id as `u8.jsonc` spells it, whichever instance this copy belongs to. */
  baseId: TargetId;
  /** {@link BASE_INSTANCE}, or the name of the instance this copy runs in. */
  instance: string;
  /** {@link NormalizedRepo.name} of the owning repo, so instance-qualified too. */
  repoName: string;
  /** App name; equals the repo name when implicit. */
  name: string;
  implicit: boolean;
  /** Absolute working directory. */
  cwd: string;
  /** Script name → shell string. `start`/`stop` feed the core commands. */
  scripts: Record<string, string>;
  /**
   * Fully merged and with every `${…}` reference resolved for this instance:
   * daemon env is applied at spawn time, not here.
   */
  env: Record<string, string>;
  /**
   * Named ports as this instance has them: the declared number in base, an
   * allocated one elsewhere. Declaration order is kept — the first is the one
   * `{app@port}` shows.
   */
  ports: Record<string, number>;
  /**
   * Resolved to concrete app ids (a repo dependency expands to its apps). In an
   * instance, a dependency the instance has a copy of points at that copy and
   * any other points at base — the same rule `${target.ports.x}` follows.
   */
  dependsOn: TargetId[];
  health?: HealthCheckDef;
  restart: RestartPolicy;
  /** Overrides `templates.app`. */
  template?: string;
  /** Max wait for this app to become ready when something depends on it. */
  readyTimeoutMs: number;
  /** SIGTERM → SIGKILL grace period. */
  stopTimeoutMs: number;
  /** Steps run in this app's directory, after its repo's own. */
  lifecycle: Lifecycle;
}

export interface NormalizedRepo {
  /** Unique across instances: `platform`, or `platform@feat-x`. */
  name: string;
  /** The repo's key in `u8.jsonc`. */
  baseName: string;
  instance: string;
  /** Absolute root of *this instance's* checkout. */
  path: string;
  /** Root of the base checkout; equal to {@link path} in the base instance. */
  basePath: string;
  /** Overrides `templates.repo`. */
  template?: string;
  /** Steps run once in the checkout root when an instance gains this repo. */
  lifecycle: RepoLifecycle;
  apps: NormalizedApp[];
}

/**
 * One checkout an instance was given. Persisted in the workspace's state dir
 * rather than in `u8.jsonc`: which worktrees exist on this machine is a local
 * fact, like the active profile.
 */
export interface InstanceRepoRecord {
  /** Absolute checkout root. */
  path: string;
  /**
   * Whether u8 created this checkout. Only an owned one is ever removed when
   * the instance is destroyed; an adopted worktree belongs to whoever made it.
   */
  owned: boolean;
  /** Branch u8 checked out, when it created the worktree. */
  branch?: string;
  /**
   * Whether u8 also created {@link branch}. Such a branch is deleted with the
   * instance if nothing was ever committed to it; a branch that existed before,
   * or that gained commits, is never touched.
   */
  createdBranch?: boolean;
  /**
   * Root of the git worktree this checkout lives in, when u8 created it. Not
   * always {@link path}: a repo may be a subdirectory of its git repository, and
   * several repos of one repository then share a single worktree.
   */
  worktree?: string;
}

/**
 * A parallel copy of part of the workspace, as stored. `normalize.ts` turns
 * these into apps and repos; nothing below it knows instances were ever a
 * separate input.
 */
export interface InstanceRecord {
  name: string;
  /** Epoch ms; also the order instances are listed in. */
  createdAt: number;
  /** Keyed by the repo's name in `u8.jsonc`. */
  repos: Record<string, InstanceRepoRecord>;
  /**
   * Base app ids this instance runs. Empty means every app of its repos, so a
   * record does not have to be rewritten when a repo grows an app.
   */
  apps: TargetId[];
  /** Allocated ports: base app id → port name → number. */
  ports: Record<TargetId, Record<string, number>>;
  /** Overrides for `${vars.<name>}`, above every level of the config. */
  vars: Record<string, string>;
  /** Epoch ms of the last init run that succeeded; absent until one has. */
  initializedAt?: number;
}

export interface NormalizedInstance {
  name: string;
  isBase: boolean;
  createdAt: number;
  /** Qualified names of the repos this instance has a checkout of. */
  repoNames: string[];
  /** Qualified ids of the apps this instance runs, in config order. */
  appIds: TargetId[];
  /** Checkout details by qualified repo name; empty for base. */
  checkouts: Record<string, InstanceRepoRecord>;
  /** Whether its init steps have completed. Base never needs them, so it is true. */
  initialized: boolean;
}

/** Where instances that are not base get their ports from, inclusive. */
export interface PortRange {
  from: number;
  to: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { from: 20_000, to: 20_999 };

/** Relative to the workspace root. */
export const DEFAULT_INSTANCES_DIR = ".u8/worktrees";

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

/** An indicator declared in config, rendered as a bare `{name}`: a shell command polled per target. */
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
  /**
   * Flat list of every app across every repo: base first in config order, then
   * each instance in creation order.
   */
  apps: NormalizedApp[];
  /** Base first, then the rest in creation order. Never empty. */
  instances: NormalizedInstance[];
  portRange: PortRange;
  /** Absolute directory u8 creates worktrees under: `<dir>/<instance>/<repo>`. */
  instancesDir: string;
  /** Base app ids, like the targets they were written as. */
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

/** Namespace of the core commands and app-row indicators; a config command or indicator name may not claim it. */
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

export function findInstance(ws: NormalizedWorkspace, name: string): NormalizedInstance | undefined {
  return ws.instances.find((i) => i.name === name);
}

export function findProfile(ws: NormalizedWorkspace, name: string): NormalizedProfile | undefined {
  return ws.profiles.find((p) => p.name === name);
}

export function findCommand(ws: NormalizedWorkspace, name: string): NormalizedCommand | undefined {
  return ws.commands.find((c) => c.name === name);
}
