/**
 * Raw `u8.jsonc` → {@link NormalizedWorkspace}.
 *
 * This is where the two invariants the rest of the codebase relies on are
 * established: every runnable thing is an app (a repo without `apps` grows
 * an implicit one), and every path/env/timeout is already resolved. It is also
 * the last place that understands the *document* — so every cross-field rule
 * (target references, dependency cycles, reserved names, profile defaults)
 * lives here, reported as `ConfigError` issues addressed by dotted path.
 *
 * Almost pure: the only filesystem access is one `stat` per resolved repo and
 * app directory ({@link directoryWarnings}). This is the single layer that
 * holds both halves of that diagnostic — the dotted config path and the
 * absolute directory it resolved to — so checking anywhere else would mean
 * duplicating the resolution. Everything else is path arithmetic, which keeps
 * the whole function cheap enough to re-run on every config reload.
 */
import path from "node:path";
// The grammar, not the renderer: `parse.ts` imports nothing outside its own
// module, so reading it here checks templates against the one true grammar
// without coupling config to anything above it.
import { parseTemplate, templateTokens } from "../template/parse.js";
import { describeDirectory } from "../util/dirs.js";
import { ConfigError, type ConfigIssue } from "../util/errors.js";
import { resolvePath, workspaceId } from "../util/paths.js";
import {
  BARE_NAME_PATTERN,
  type RawBuiltins,
  type RawHealth,
  type RawLimits,
  type RawPlugin,
  type RawRunnable,
  type RawWorkspaceConfig,
} from "./schema.js";
import {
  type BuiltinFlags,
  CORE_COMMAND_NAMESPACE,
  type CustomIndicatorDef,
  DEFAULT_HEALTH,
  DEFAULT_LIMITS,
  DEFAULT_PROTOS_INTERVAL_MS,
  DEFAULT_TEMPLATES,
  type HealthCheckDef,
  type Limits,
  type NormalizedApp,
  type NormalizedCommand,
  type NormalizedProfile,
  type NormalizedRepo,
  type NormalizedWorkspace,
  type PluginRef,
  type ProtosOptions,
  REPO_NAMESPACE,
  type TargetId,
  type Templates,
} from "./types.js";

/** Poll interval for a config `x@` indicator that does not set one. */
export const DEFAULT_INDICATOR_INTERVAL_MS = 5_000;

/** Profile synthesized when the config declares none. */
export const IMPLICIT_PROFILE_NAME = "all";

/**
 * The `x@` namespace, mirrored from `CUSTOM_NAMESPACE` in `src/indicators`:
 * config sits below the indicator layer and cannot import it, and the letter is
 * part of the config language (SPEC §2.7) rather than of the registry.
 */
const CUSTOM_INDICATOR_NAMESPACE = "x";

export function normalizeWorkspace(raw: RawWorkspaceConfig, configPath: string): NormalizedWorkspace {
  const issues: ConfigIssue[] = [];
  const rootDir = path.dirname(configPath);
  const limits = mergeLimits(raw.limits);
  const workspaceEnv = raw.env ?? {};

  // --- repos & apps -------------------------------------------------------
  const repos: NormalizedRepo[] = [];
  const apps: NormalizedApp[] = [];
  const pendingDeps: Array<{ app: NormalizedApp; specs: string[]; configPath: string }> = [];
  const dirChecks: DirectoryCheck[] = [];

  for (const [repoName, entry] of Object.entries(raw.repos)) {
    const repoPath = resolvePath(entry.path, rootDir);
    const repo: NormalizedRepo = { name: repoName, path: repoPath, template: entry.template, apps: [] };
    const appEntries = Object.entries(entry.apps ?? {});
    dirChecks.push({ at: `repos.${repoName}.path`, dir: repoPath });

    if (appEntries.length === 0) {
      // Implicit app: the repo entry *is* the app definition.
      const app = buildApp({
        id: repoName,
        repoName,
        name: repoName,
        implicit: true,
        cwd: repoPath,
        baseEnv: workspaceEnv,
        entry,
        limits,
      });
      repo.apps.push(app);
      pendingDeps.push({ app, specs: entry.dependsOn ?? [], configPath: `repos.${repoName}.dependsOn` });
    } else {
      for (const [appName, appEntry] of appEntries) {
        const appCwd = resolvePath(appEntry.path ?? ".", repoPath);
        // An app that inherits the repo directory is already covered by the
        // repo's own check; only a `path` of its own is a second place to be wrong.
        if (appCwd !== repoPath) {
          dirChecks.push({ at: `repos.${repoName}.apps.${appName}.path`, dir: appCwd, under: repoPath });
        }
        const app = buildApp({
          id: `${repoName}.${appName}`,
          repoName,
          name: appName,
          implicit: false,
          cwd: appCwd,
          baseEnv: workspaceEnv,
          defaults: entry,
          entry: appEntry,
          limits,
        });
        repo.apps.push(app);
        pendingDeps.push({
          app,
          specs: appEntry.dependsOn ?? entry.dependsOn ?? [],
          configPath: appEntry.dependsOn
            ? `repos.${repoName}.apps.${appName}.dependsOn`
            : `repos.${repoName}.dependsOn`,
        });
      }
    }

    repos.push(repo);
    apps.push(...repo.apps);
  }

  // --- target index ---------------------------------------------------------
  const knownIds = new Set<TargetId>(apps.map((a) => a.id));
  const idsByRepo = new Map<string, TargetId[]>(repos.map((r) => [r.name, r.apps.map((a) => a.id)]));

  /** A repo name expands to all of its apps; an id matches exactly. */
  const expand = (spec: string): TargetId[] | undefined =>
    knownIds.has(spec) ? [spec] : idsByRepo.get(spec);

  const resolveRefs = (specs: readonly string[], pathOf: (index: number) => string): TargetId[] => {
    const out: TargetId[] = [];
    specs.forEach((spec, index) => {
      const ids = expand(spec);
      if (!ids) {
        issues.push({ path: pathOf(index), message: unknownTarget(spec) });
        return;
      }
      for (const id of ids) if (!out.includes(id)) out.push(id);
    });
    return out;
  };

  // One repo-level `dependsOn` feeds every app of that repo: resolve it once so
  // a bad reference is reported at the place it was authored, not once per app.
  const resolvedDeps = new Map<string, TargetId[]>();
  for (const { app, specs, configPath: depPath } of pendingDeps) {
    let ids = resolvedDeps.get(depPath);
    if (!ids) {
      ids = resolveRefs(specs, (i) => `${depPath}[${i}]`);
      resolvedDeps.set(depPath, ids);
    }
    app.dependsOn = [...ids];
  }

  // --- profiles -------------------------------------------------------------
  const profiles = normalizeProfiles(raw, apps, repos, resolveRefs, issues);
  const defaultProfile = profiles.find((p) => p.isDefault)?.name ?? profiles[0]?.name ?? IMPLICIT_PROFILE_NAME;

  // --- commands -------------------------------------------------------------
  const commands: NormalizedCommand[] = [];
  for (const [name, entry] of Object.entries(raw.commands ?? {})) {
    const at = `commands.${name}`;
    checkBareName(name, "command", at, issues);
    // Repo-wide entries are applied first so an explicit `repo.app` entry always
    // wins, whatever order the two were written in.
    const entries = Object.entries(entry.targets ?? {});
    const targetScripts: Record<TargetId, string | null> = {};
    for (const [spec, script] of [
      ...entries.filter(([s]) => !knownIds.has(s)),
      ...entries.filter(([s]) => knownIds.has(s)),
    ]) {
      const ids = expand(spec);
      if (!ids) {
        issues.push({ path: `${at}.targets.${spec}`, message: unknownTarget(spec) });
        continue;
      }
      for (const id of ids) targetScripts[id] = script;
    }
    commands.push({
      name,
      kind: entry.kind ?? "task",
      source: "config",
      description: entry.description,
      script: entry.script,
      targetScripts,
      concurrency: entry.concurrency,
      hooks: { pre: toArray(entry.hooks?.pre), post: toArray(entry.hooks?.post) },
    });
  }
  commands.push(...coreCommands(apps));

  // --- indicators -----------------------------------------------------------
  const indicators: CustomIndicatorDef[] = [];
  for (const [name, entry] of Object.entries(raw.indicators ?? {})) {
    checkBareName(name, "indicator", `indicators.${name}`, issues);
    indicators.push({
      name,
      cmd: entry.cmd,
      intervalMs: entry.interval ?? DEFAULT_INDICATOR_INTERVAL_MS,
      scope: entry.scope ?? "app",
    });
  }

  // --- plugins & built-ins --------------------------------------------------
  const plugins = normalizePlugins(raw.plugins ?? [], rootDir);
  const { builtins, builtinOptions } = normalizeBuiltins(raw.builtins, issues);

  if (issues.length > 0) throw new ConfigError("invalid workspace config", issues, configPath);

  const cycle = findCycle(apps);
  if (cycle) {
    throw new ConfigError(
      "invalid workspace config",
      [{ path: "repos", message: `dependency cycle: ${cycle.join(" → ")}` }],
      configPath,
    );
  }

  return {
    configPath,
    rootDir,
    name: raw.name ?? path.basename(rootDir),
    id: workspaceId(configPath),
    templates: mergeTemplates(raw.templates),
    repos,
    apps,
    profiles,
    defaultProfile,
    commands,
    indicators,
    plugins,
    builtins,
    builtinOptions,
    limits,
    // Directories first: a `path` that points at nothing explains every other
    // odd thing about that repo, including a template token that never resolves.
    warnings: [
      ...directoryWarnings(dirChecks),
      ...templateWarnings(raw, { plugins, builtins }, new Set(indicators.map((i) => i.name))),
    ],
  };
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

interface DirectoryCheck {
  /** Dotted config path of the `path` entry that named this directory. */
  at: string;
  /** The resolved, absolute directory. */
  dir: string;
  /** The repo directory an app's `path` was resolved against, when there is one. */
  under?: string;
}

/**
 * Non-fatal diagnostics for a `path` that names nothing on disk — the likeliest
 * mistake in a first config, and one that is otherwise invisible until the
 * process layer reports it against the *shell's* name (see `spawn.ts`).
 *
 * Warnings and not `ConfigError` issues, and the choice is deliberate:
 *
 *  - A missing directory is a fact about the filesystem, not a defect in the
 *    document. The same config is right before and after `git clone`, so making
 *    the load fail would make `u8` refuse to run for a reason its author cannot
 *    fix in the config — a workspace with one repo not cloned yet (or one
 *    volume not mounted) would lose the other nine repos too.
 *  - The codebase already refuses to do that for the analogous case: a plugin
 *    that fails to load is disabled and reported, never fatal.
 *  - The blast radius is where it belongs. `spawn.ts` now fails that one target
 *    with `no such directory: <dir>`, so the missing directory costs exactly the
 *    target that needs it and nothing else.
 *
 * These reach `daemon.log`, addressed by dotted config path — the form that
 * says which line of `u8.jsonc` to edit. `u8 status` says the same thing again
 * addressed by *target*, because the row it is about to draw reads `stopped`
 * either way; it stats the directories the snapshot already carries rather than
 * plumbing these strings across the wire.
 */
function directoryWarnings(checks: readonly DirectoryCheck[]): string[] {
  const out: string[] = [];
  const broken = new Set<string>();

  for (const { at, dir, under } of checks) {
    // Nothing can exist under a directory that does not: reporting the app
    // too would bury the single line its author has to act on.
    if (under !== undefined && broken.has(under) && isInside(dir, under)) continue;
    const problem = describeDirectory(dir);
    if (problem === undefined) continue;
    broken.add(dir);
    out.push(`${at}: ${problem}`);
  }
  return out;
}

function isInside(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

interface BuildAppArgs {
  id: TargetId;
  repoName: string;
  name: string;
  implicit: boolean;
  cwd: string;
  /** Workspace-level env; the bottom of the merge order. */
  baseEnv: Record<string, string>;
  /** The repo entry, when it acts as a defaults layer for an explicit app. */
  defaults?: RawRunnable;
  entry: RawRunnable;
  limits: Limits;
}

/**
 * `dependsOn` is left empty here and filled once every app is known, since a
 * dependency may name a repo declared later in the document.
 */
function buildApp(args: BuildAppArgs): NormalizedApp {
  const { defaults, entry, limits } = args;
  return {
    id: args.id,
    repoName: args.repoName,
    name: args.name,
    implicit: args.implicit,
    cwd: args.cwd,
    scripts: { ...defaults?.scripts, ...entry.scripts },
    env: { ...args.baseEnv, ...defaults?.env, ...entry.env },
    dependsOn: [],
    health: normalizeHealth(entry.health ?? defaults?.health),
    restart: entry.restart ?? defaults?.restart ?? "no",
    template: entry.template,
    readyTimeoutMs: entry.readyTimeout ?? defaults?.readyTimeout ?? limits.readyTimeoutMs,
    stopTimeoutMs: entry.stopTimeout ?? defaults?.stopTimeout ?? limits.stopTimeoutMs,
  };
}

/** Replaced wholesale rather than merged: `http` and `cmd` are mutually exclusive. */
function normalizeHealth(health: RawHealth | undefined): HealthCheckDef | undefined {
  if (!health) return undefined;
  return {
    http: health.http,
    cmd: health.cmd,
    intervalMs: health.interval ?? DEFAULT_HEALTH.intervalMs,
    timeoutMs: health.timeout ?? DEFAULT_HEALTH.timeoutMs,
    threshold: health.threshold ?? DEFAULT_HEALTH.threshold,
  };
}

// ---------------------------------------------------------------------------
// Profiles & commands
// ---------------------------------------------------------------------------

function normalizeProfiles(
  raw: RawWorkspaceConfig,
  apps: readonly NormalizedApp[],
  repos: readonly NormalizedRepo[],
  resolveRefs: (specs: readonly string[], pathOf: (index: number) => string) => TargetId[],
  issues: ConfigIssue[],
): NormalizedProfile[] {
  const entries = Object.entries(raw.profiles ?? {});
  if (entries.length === 0) {
    return [
      {
        name: IMPLICIT_PROFILE_NAME,
        isDefault: true,
        targets: repos.map((r) => r.name),
        appIds: apps.map((a) => a.id),
      },
    ];
  }

  const declaredDefaults = entries.filter(([, p]) => p.default === true).map(([name]) => name);
  if (declaredDefaults.length > 1) {
    issues.push({
      path: "profiles",
      message: `only one profile may set "default": true (got ${declaredDefaults.join(", ")})`,
    });
  }

  const profiles = entries.map(([name, entry]) => ({
    name,
    isDefault: entry.default === true,
    targets: [...entry.targets],
    appIds: resolveRefs(entry.targets, (i) => `profiles.${name}.targets[${i}]`),
  }));

  // No explicit default: the first declared profile wins.
  const first = profiles[0];
  if (declaredDefaults.length === 0 && first) first.isDefault = true;
  return profiles;
}

/**
 * The three `app:*` commands every workspace has. A `null` entry means "no
 * script for this target" — the supervisor reads that as "signal the process
 * group" for stop, and as "nothing to start" for start.
 */
function coreCommands(apps: readonly NormalizedApp[]): NormalizedCommand[] {
  const scripts = (key: "start" | "stop" | null): Record<TargetId, string | null> =>
    Object.fromEntries(apps.map((a) => [a.id, key === null ? null : (a.scripts[key] ?? null)]));

  const make = (name: string, description: string, key: "start" | "stop" | null): NormalizedCommand => ({
    name,
    kind: "service",
    source: "core",
    description,
    targetScripts: scripts(key),
    hooks: { pre: [], post: [] },
  });

  return [
    make("app:start", "Start the selected services", "start"),
    make("app:stop", "Stop the selected services", "stop"),
    make("app:restart", "Restart the selected services", null),
  ];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Non-fatal template diagnostics — SPEC §4: an unknown token "warns at load".
 *
 * They are warnings and not `ConfigError` issues on purpose: a mistyped token
 * renders as a red `{ns@name!}` marker, and a dashboard that is otherwise fine
 * must keep loading. Until these were collected, the parser's warnings went
 * nowhere and a one-character typo was only discoverable by eye.
 *
 * Only *authored* templates are checked. The defaults reference `git@`/`health@`
 * and would light up the moment someone disabled a built-in they never asked for.
 */
function templateWarnings(
  raw: RawWorkspaceConfig,
  loaded: { plugins: readonly PluginRef[]; builtins: BuiltinFlags },
  declaredIndicators: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const namespaces = knownNamespaces(loaded);

  const check = (template: string | undefined, at: string, row: "repo" | "app"): void => {
    if (template === undefined) return;
    const parsed = parseTemplate(template);
    for (const warning of parsed.warnings) out.push(`${at}: ${warning.message}`);
    for (const { ns, name } of templateTokens(parsed)) {
      const token = `{${ns}@${name}}`;
      if (row === "repo" && ns === CORE_COMMAND_NAMESPACE) {
        // The fallback runs one way: an app row may read its repo's cells, but a
        // header row stands for several apps and has no single one to read.
        out.push(`${at}: ${token} is an app-row token — a repo header row reads ${REPO_ROW_TOKENS}`);
      } else if (ns === CUSTOM_INDICATOR_NAMESPACE) {
        // The only namespace whose *names* this layer knows in full.
        if (!declaredIndicators.has(name)) {
          out.push(`${at}: ${token} names no indicator declared under "indicators"`);
        }
      } else if (!namespaces.has(ns)) {
        out.push(
          `${at}: ${token} uses unknown namespace "${ns}" — expected ` +
            `${[...namespaces].map((n) => `"${n}"`).join(", ")} or "${CUSTOM_INDICATOR_NAMESPACE}"`,
        );
      }
    }
  };

  check(raw.templates?.repo, "templates.repo", "repo");
  check(raw.templates?.app, "templates.app", "app");
  for (const [repoName, repo] of Object.entries(raw.repos)) {
    const apps = Object.entries(repo.apps ?? {});
    // A repo's own template is a header row only above several apps; with one
    // (or none) it renders the merged row, which is an app row.
    check(repo.template, `repos.${repoName}.template`, apps.length > 1 ? "repo" : "app");
    for (const [appName, app] of apps) {
      check(app.template, `repos.${repoName}.apps.${appName}.template`, "app");
    }
  }
  return out;
}

/**
 * What `repo@` offers, spelled out because the author reached for `app@`
 * instead. A copy of the list in `src/indicators/core.ts`: config sits below
 * the indicator layer and cannot ask it.
 */
const REPO_ROW_TOKENS = "{repo@name}, {repo@dirname}, {repo@path} or {repo@status}";

/** Core, the enabled built-ins, and whatever the declared plugins are likely called. */
function knownNamespaces({
  plugins,
  builtins,
}: {
  plugins: readonly PluginRef[];
  builtins: BuiltinFlags;
}): Set<string> {
  const out = new Set<string>([CORE_COMMAND_NAMESPACE, REPO_NAMESPACE]);
  for (const [name, enabled] of Object.entries(builtins)) if (enabled) out.add(name);
  for (const { spec } of plugins) for (const guess of pluginNamespaces(spec)) out.add(guess);
  return out;
}

/**
 * What a declared plugin is *probably* called. Its real namespace is the `name`
 * its module exports, which only the daemon knows once it has loaded it, so this
 * guesses from the spec — file basename, package name, `index.ts`'s directory —
 * and guesses generously: this warning is advisory, and crying wolf over a
 * perfectly good plugin would be worse than staying quiet about a typo.
 */
function pluginNamespaces(spec: string): string[] {
  const segments = spec.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
  const last = segments.at(-1);
  if (last === undefined) return [];
  const base = last.replace(/\.[cm]?[jt]sx?$/i, "");
  const out = [base];
  // `./plugins/index.ts` and `@acme/metrics` are both named by the segment before.
  const parent = segments.at(-2);
  if (parent !== undefined && (base === "index" || parent.startsWith("@"))) {
    out.push(parent.slice(parent.startsWith("@") ? 1 : 0));
  }
  // The `<prefix>-plugin-<name>` package convention: `u8-plugin-git` is `git@`.
  const suffix = /-plugin-(.+)$/.exec(base)?.[1];
  if (suffix !== undefined) out.push(suffix);
  return out;
}

// ---------------------------------------------------------------------------
// Misc normalization
// ---------------------------------------------------------------------------

function mergeLimits(raw: RawLimits | undefined): Limits {
  return {
    logMaxBytes: raw?.logMaxBytes ?? DEFAULT_LIMITS.logMaxBytes,
    logKeep: raw?.logKeep ?? DEFAULT_LIMITS.logKeep,
    taskRunsKeep: raw?.taskRunsKeep ?? DEFAULT_LIMITS.taskRunsKeep,
    stopTimeoutMs: raw?.stopTimeout ?? DEFAULT_LIMITS.stopTimeoutMs,
    readyTimeoutMs: raw?.readyTimeout ?? DEFAULT_LIMITS.readyTimeoutMs,
    taskConcurrency: raw?.taskConcurrency ?? DEFAULT_LIMITS.taskConcurrency,
    daemonIdleMs: raw?.daemonIdle ?? DEFAULT_LIMITS.daemonIdleMs,
  };
}

function mergeTemplates(raw: RawWorkspaceConfig["templates"]): Templates {
  return {
    repo: raw?.repo ?? DEFAULT_TEMPLATES.repo,
    app: raw?.app ?? DEFAULT_TEMPLATES.app,
  };
}

/**
 * A plugin entry is either a bare spec or `{ spec, options }`; both land on the
 * same {@link PluginRef}. Options are carried through verbatim — this layer has
 * no idea what any given plugin's options mean, and guessing would be worse than
 * passing them on.
 */
function normalizePlugins(entries: readonly RawPlugin[], rootDir: string): PluginRef[] {
  return entries.map((entry) => {
    const { spec, options } = typeof entry === "string" ? { spec: entry, options: undefined } : entry;
    const ref: PluginRef = { spec };
    if (isLocalSpec(spec)) ref.resolved = resolvePath(spec, rootDir);
    if (options !== undefined) ref.options = options;
    return ref;
  });
}

/**
 * `builtins` carries two different things — whether a built-in is on, and how it
 * is configured — so they are separated here: an object entry means *enabled and
 * configured*, and the options are keyed by built-in name for the plugin host to
 * hand over the same way it hands a third-party plugin its `options`.
 *
 * `git` and `health` default to on: they cost nothing until a workspace has a
 * git repo or a healthcheck. `protos` defaults to off and cannot be switched on
 * with a bare `true`, because without `packages` there is nothing for it to
 * link, and registering commands that can only fail would be worse than staying
 * quiet.
 */
function normalizeBuiltins(
  raw: RawBuiltins | undefined,
  issues: ConfigIssue[],
): { builtins: BuiltinFlags; builtinOptions: Record<string, Record<string, unknown>> } {
  const builtinOptions: Record<string, Record<string, unknown>> = {};
  const protos = raw?.protos;

  if (protos === true) {
    issues.push({
      path: "builtins.protos",
      message:
        "the protos built-in has nothing to link until it is told which packages are shared: " +
        'replace true with { "packages": ["@myorg/protos"] }',
    });
  } else if (typeof protos === "object") {
    builtinOptions["protos"] = {
      packages: [...protos.packages],
      intervalMs: protos.interval ?? DEFAULT_PROTOS_INTERVAL_MS,
    } satisfies ProtosOptions;
  }

  return {
    builtins: {
      git: raw?.git ?? true,
      health: raw?.health ?? true,
      protos: builtinOptions["protos"] !== undefined,
    },
    builtinOptions,
  };
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return typeof v === "string" ? [v] : [...v];
}

function unknownTarget(spec: string): string {
  return `unknown target "${spec}" — expected a repo name or "repo.app"`;
}

function checkBareName(name: string, what: string, at: string, issues: ConfigIssue[]): void {
  if (name.includes(":") || name.includes("@")) {
    issues.push({
      path: at,
      message:
        `${what} names in config must be bare: "${name}" uses a namespace separator, ` +
        `and namespaces are reserved for core (app:start) and plugins (git:pull, git@branch)`,
    });
    return;
  }
  if (!BARE_NAME_PATTERN.test(name)) {
    issues.push({
      path: at,
      message:
        `invalid ${what} name "${name}": use letters, digits, ".", "_" or "-", ` +
        `starting with a letter or digit`,
    });
  }
}

/** Returns the offending path (`a → b → a`) or `undefined` when the DAG is clean. */
function findCycle(apps: readonly NormalizedApp[]): TargetId[] | undefined {
  const deps = new Map<TargetId, TargetId[]>(apps.map((a) => [a.id, a.dependsOn]));
  const state = new Map<TargetId, "open" | "done">();
  const stack: TargetId[] = [];

  const visit = (id: TargetId): TargetId[] | undefined => {
    const seen = state.get(id);
    if (seen === "done") return undefined;
    if (seen === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const { id } of apps) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}
