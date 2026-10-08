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
// module but the name rules in `util/names.ts`, so reading it here checks
// templates against the one true grammar without coupling config to anything
// above it.
import { NO_NAMESPACE, parseTemplate, templateTokens, tokenLabel } from "../template/parse.js";
import { describeDirectory } from "../util/dirs.js";
import { ConfigError, type ConfigIssue } from "../util/errors.js";
import { resolvePath, workspaceId } from "../util/paths.js";
import {
  isLiteral,
  parseInterpolation,
  renderInterpolation,
  type Ref,
  type Resolution,
} from "./interpolate.js";
import {
  BARE_NAME_PATTERN,
  NAME_PATTERN,
  type RawBuiltins,
  type RawHealth,
  type RawLimits,
  type RawPlugin,
  type RawRunnable,
  type RawWorkspaceConfig,
} from "./schema.js";
import {
  BASE_INSTANCE,
  type BuiltinFlags,
  type CommandHooks,
  CORE_COMMAND_NAMESPACE,
  CORE_COMMANDS,
  type CustomIndicatorDef,
  DEFAULT_HEALTH,
  DEFAULT_INSTANCES_DIR,
  DEFAULT_LIMITS,
  DEFAULT_PORT_RANGE,
  DEFAULT_PROTOS_INTERVAL_MS,
  DEFAULT_TEMPLATES,
  type HealthCheckDef,
  type InstanceRecord,
  type InstanceRepoRecord,
  type Limits,
  type NormalizedApp,
  type NormalizedCommand,
  type NormalizedInstance,
  type NormalizedProfile,
  type NormalizedRepo,
  type NormalizedWorkspace,
  type PluginRef,
  type ProtosOptions,
  qualify,
  REPO_NAMESPACE,
  type TargetId,
  type Templates,
} from "./types.js";

/** Poll interval for a config indicator that does not set one. */
export const DEFAULT_INDICATOR_INTERVAL_MS = 5_000;

/** Profile synthesized when the config declares none. */
export const IMPLICIT_PROFILE_NAME = "all";

/**
 * `records` are the instances this machine has created (see `instances.ts`);
 * none is the common case and leaves exactly the base instance, whose apps and
 * repos are the document's own.
 */
export function normalizeWorkspace(
  raw: RawWorkspaceConfig,
  configPath: string,
  records: readonly InstanceRecord[] = [],
): NormalizedWorkspace {
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];
  const rootDir = path.dirname(configPath);
  const limits = mergeLimits(raw.limits);
  const workspaceName = raw.name ?? path.basename(rootDir);

  // --- repos & apps, once per instance ---------------------------------------
  const repos: NormalizedRepo[] = [];
  const apps: NormalizedApp[] = [];
  const instances: NormalizedInstance[] = [];
  const drafts: Draft[] = [];
  const dirChecks: DirectoryCheck[] = [];

  const seenInstances = new Set<string>([BASE_INSTANCE]);
  for (const record of [undefined, ...[...records].sort((a, b) => a.createdAt - b.createdAt)]) {
    if (record !== undefined) {
      const problem = instanceNameProblem(record.name);
      if (problem !== undefined || seenInstances.has(record.name)) {
        warnings.push(`instance "${record.name}": ${problem ?? "listed twice; the later one is ignored"}`);
        continue;
      }
      seenInstances.add(record.name);
    }
    const built = buildInstance({ raw, rootDir, limits, record, issues, warnings, dirChecks });
    instances.push(built.instance);
    repos.push(...built.repos);
    drafts.push(...built.drafts);
    for (const repo of built.repos) apps.push(...repo.apps);
  }

  // --- target index ---------------------------------------------------------
  // References in the document are always written against base: `dependsOn`,
  // profile targets, command targets and `${target.ports.x}` name what the
  // config declares, and each instance then maps them onto its own copies.
  const baseApps = apps.filter((a) => a.instance === BASE_INSTANCE);
  const baseRepos = repos.filter((r) => r.instance === BASE_INSTANCE);
  const byId = new Map<TargetId, NormalizedApp>(apps.map((a) => [a.id, a]));
  const knownIds = new Set<TargetId>(baseApps.map((a) => a.id));
  const idsByRepo = new Map<string, TargetId[]>(baseRepos.map((r) => [r.name, r.apps.map((a) => a.id)]));

  /** A repo name expands to all of its apps; an id matches exactly. */
  const expand = (spec: string): TargetId[] | undefined =>
    knownIds.has(spec) ? [spec] : idsByRepo.get(spec);

  /**
   * The copy of a base app that `instance` should talk to: its own when it has
   * one, base's otherwise. This one rule is what makes a partial instance work —
   * a worktree of the frontend alone still finds the api it was written against.
   */
  const inInstance = (baseId: TargetId, instance: string): NormalizedApp | undefined =>
    byId.get(qualify(baseId, instance)) ?? byId.get(baseId);

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

  // One repo-level `dependsOn` feeds every app of that repo, in every instance:
  // resolve it once so a bad reference is reported at the place it was authored,
  // not once per app.
  const resolvedDeps = new Map<string, TargetId[]>();
  for (const { app, depSpecs, depsAt } of drafts) {
    let ids = resolvedDeps.get(depsAt);
    if (!ids) {
      ids = resolveRefs(depSpecs, (i) => `${depsAt}[${i}]`);
      resolvedDeps.set(depsAt, ids);
    }
    const mapped = ids.map((id) => inInstance(id, app.instance)?.id ?? id);
    app.dependsOn = mapped.filter((id, index) => id !== app.id && mapped.indexOf(id) === index);
  }

  // --- references -----------------------------------------------------------
  // After every app exists: `${api.ports.http}` may name a repo declared later.
  const interpolationIssues: ConfigIssue[] = [];
  for (const draft of drafts) {
    const resolve = referenceResolver({ draft, workspaceName, rootDir, expand, inInstance });
    for (const [key, text] of Object.entries(draft.app.env)) {
      const parsed = parseInterpolation(text);
      if (isLiteral(parsed)) {
        // `$${` is the one thing a literal string still has to have undone.
        draft.app.env[key] = renderInterpolation(parsed, resolve).value;
        continue;
      }
      const rendered = renderInterpolation(parsed, resolve);
      draft.app.env[key] = rendered.value;
      const at = draft.envAt[key] ?? `env.${key}`;
      for (const message of rendered.errors) interpolationIssues.push({ path: at, message });
    }
    const health = draft.app.health;
    if (health?.http !== undefined) {
      const rendered = renderInterpolation(parseInterpolation(health.http), resolve);
      health.http = rendered.value;
      for (const message of rendered.errors) {
        interpolationIssues.push({ path: `${draft.healthAt ?? "health"}.http`, message });
      }
    }
  }
  // A workspace- or repo-level value is resolved once per app that inherits it,
  // and a mistake in it is the same mistake every time.
  issues.push(...dedupeIssues(interpolationIssues));

  // --- profiles -------------------------------------------------------------
  const profiles = normalizeProfiles(raw, baseApps, baseRepos, resolveRefs, issues);
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
    // An instance's copy of an app answers to the entry written for the app.
    for (const app of apps) {
      if (app.instance === BASE_INSTANCE) continue;
      if (Object.prototype.hasOwnProperty.call(targetScripts, app.baseId)) {
        targetScripts[app.id] = targetScripts[app.baseId] ?? null;
      }
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
  const hooks = normalizeHooks(raw.hooks, commands, issues);

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
    name: workspaceName,
    id: workspaceId(configPath),
    templates: mergeTemplates(raw.templates),
    repos,
    apps,
    instances,
    portRange: raw.instances?.ports ?? { ...DEFAULT_PORT_RANGE },
    instancesDir: resolvePath(raw.instances?.dir ?? DEFAULT_INSTANCES_DIR, rootDir),
    profiles,
    defaultProfile,
    commands,
    hooks,
    indicators,
    plugins,
    builtins,
    builtinOptions,
    limits,
    // Directories first: a `path` that points at nothing explains every other
    // odd thing about that repo, including a template token that never resolves.
    warnings: [
      ...directoryWarnings(dirChecks),
      ...warnings,
      ...portWarnings(baseApps),
      ...templateWarnings(raw, { plugins, builtins }, new Set(indicators.map((i) => i.name))),
    ],
  };
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * An app whose `${…}` references are still text. The extra fields are what
 * resolving them needs and nothing downstream should see: where each value was
 * written (so an error names a line of the document, not a merged map) and the
 * vars in scope.
 */
interface Draft {
  app: NormalizedApp;
  repo: NormalizedRepo;
  vars: Record<string, string>;
  /** Env key → dotted config path of the entry that set it. */
  envAt: Record<string, string>;
  healthAt?: string;
  depSpecs: string[];
  depsAt: string;
}

interface BuildInstanceArgs {
  raw: RawWorkspaceConfig;
  rootDir: string;
  limits: Limits;
  /** `undefined` builds base: every repo, where the document says it is. */
  record: InstanceRecord | undefined;
  issues: ConfigIssue[];
  warnings: string[];
  dirChecks: DirectoryCheck[];
}

/**
 * Builds one instance's repos and apps from the same document base is built
 * from. Nothing about an instance is authored separately: it is the config,
 * re-read with different checkout roots and different ports.
 *
 * Problems with the *document* are reported on the base pass only — they would
 * otherwise repeat once per instance. Problems with a *record* (a repo the
 * config has since dropped) are warnings: a stale record must never be what
 * stops a workspace from loading.
 */
function buildInstance(args: BuildInstanceArgs): {
  instance: NormalizedInstance;
  repos: NormalizedRepo[];
  drafts: Draft[];
} {
  const { raw, rootDir, limits, record, issues, warnings, dirChecks } = args;
  const instanceName = record?.name ?? BASE_INSTANCE;
  const isBase = record === undefined;
  const repos: NormalizedRepo[] = [];
  const drafts: Draft[] = [];
  const checkouts: Record<string, InstanceRepoRecord> = {};
  const selected = record !== undefined && record.apps.length > 0 ? new Set(record.apps) : undefined;
  const label = (what: string): string => (isBase ? what : `instance "${instanceName}": ${what}`);

  if (record !== undefined) {
    for (const repoName of Object.keys(record.repos)) {
      if (raw.repos[repoName] === undefined) {
        warnings.push(label(`repo "${repoName}" is no longer in the config and is ignored`));
      }
    }
  }

  const workspaceLayer = { at: "env", values: raw.env };

  for (const [repoName, entry] of Object.entries(raw.repos)) {
    const basePath = resolvePath(entry.path, rootDir);
    const checkout = record?.repos[repoName];
    if (record !== undefined && checkout === undefined) continue;
    const repoPath = checkout?.path ?? basePath;
    const repoAt = `repos.${repoName}`;
    const appEntries = Object.entries(entry.apps ?? {});

    const repo: NormalizedRepo = {
      name: qualify(repoName, instanceName),
      baseName: repoName,
      instance: instanceName,
      path: repoPath,
      basePath,
      template: entry.template,
      lifecycle: {
        copy: [...(entry.instance?.copy ?? [])],
        init: toArray(entry.instance?.init),
        teardown: toArray(entry.instance?.teardown),
      },
      apps: [],
    };
    if (checkout !== undefined) checkouts[repo.name] = { ...checkout };

    if (isBase && appEntries.length > 0 && entry.ports !== undefined) {
      issues.push({
        path: `${repoAt}.ports`,
        message:
          "a port belongs to one process, so it cannot be a default for several apps: " +
          `declare it on the app that listens on it (${repoAt}.apps.<app>.ports)`,
      });
    }

    const add = (spec: {
      baseId: TargetId;
      name: string;
      implicit: boolean;
      cwd: string;
      at: string;
      defaults?: RawRunnable;
      entry: RawRunnable;
      ports: Record<string, number> | undefined;
      lifecycle: { init?: string | string[]; teardown?: string | string[] } | undefined;
    }): void => {
      if (selected !== undefined && !selected.has(spec.baseId)) return;
      const repoLayer = spec.defaults === undefined ? undefined : { at: `${repoAt}.env`, values: spec.defaults.env };
      const env = mergeTracked([workspaceLayer, repoLayer, { at: `${spec.at}.env`, values: spec.entry.env }]);
      const health = spec.entry.health ?? spec.defaults?.health;
      const app: NormalizedApp = {
        id: qualify(spec.baseId, instanceName),
        baseId: spec.baseId,
        instance: instanceName,
        repoName: repo.name,
        name: spec.name,
        implicit: spec.implicit,
        cwd: spec.cwd,
        scripts: { ...spec.defaults?.scripts, ...spec.entry.scripts },
        env: env.values,
        ports: instancePorts(spec.baseId, spec.ports, record, warnings),
        // Left empty here and filled once every app is known, since a
        // dependency may name a repo declared later in the document.
        dependsOn: [],
        health: normalizeHealth(health),
        restart: spec.entry.restart ?? spec.defaults?.restart ?? "no",
        template: spec.entry.template,
        readyTimeoutMs: spec.entry.readyTimeout ?? spec.defaults?.readyTimeout ?? limits.readyTimeoutMs,
        stopTimeoutMs: spec.entry.stopTimeout ?? spec.defaults?.stopTimeout ?? limits.stopTimeoutMs,
        lifecycle: { init: toArray(spec.lifecycle?.init), teardown: toArray(spec.lifecycle?.teardown) },
      };
      repo.apps.push(app);
      const ownDeps = spec.entry.dependsOn !== undefined;
      drafts.push({
        app,
        repo,
        vars: { ...raw.vars, ...spec.defaults?.vars, ...spec.entry.vars, ...record?.vars },
        envAt: env.at,
        healthAt:
          health === undefined
            ? undefined
            : spec.entry.health !== undefined
              ? `${spec.at}.health`
              : `${repoAt}.health`,
        depSpecs: spec.entry.dependsOn ?? spec.defaults?.dependsOn ?? [],
        depsAt: ownDeps || spec.defaults === undefined ? `${spec.at}.dependsOn` : `${repoAt}.dependsOn`,
      });
    };

    if (appEntries.length === 0) {
      // Implicit app: the repo entry *is* the app definition, and its lifecycle
      // steps are the repo's — there is no second directory to run any in.
      add({
        baseId: repoName,
        name: repoName,
        implicit: true,
        cwd: repoPath,
        at: repoAt,
        entry,
        ports: entry.ports,
        lifecycle: undefined,
      });
    } else {
      for (const [appName, appEntry] of appEntries) {
        const appCwd = resolvePath(appEntry.path ?? ".", repoPath);
        add({
          baseId: `${repoName}.${appName}`,
          name: appName,
          implicit: false,
          cwd: appCwd,
          at: `${repoAt}.apps.${appName}`,
          defaults: entry,
          entry: appEntry,
          ports: appEntry.ports,
          lifecycle: appEntry.instance,
        });
      }
    }

    // A checkout none of whose apps this instance runs has nothing to show or
    // start; it stays in `checkouts`, which is what destroying the instance reads.
    if (repo.apps.length === 0) continue;

    dirChecks.push({ at: label(`${repoAt}.path`), dir: repoPath });
    for (const app of repo.apps) {
      // An app that inherits the repo directory is already covered by the
      // repo's own check; only a `path` of its own is a second place to be wrong.
      if (app.cwd !== repoPath) {
        dirChecks.push({ at: label(`${repoAt}.apps.${app.name}.path`), dir: app.cwd, under: repoPath });
      }
    }
    repos.push(repo);
  }

  if (selected !== undefined) {
    const built = new Set(drafts.map((d) => d.app.baseId));
    for (const id of selected) {
      if (!built.has(id)) warnings.push(label(`app "${id}" is not in the config or its repo has no checkout`));
    }
  }

  return {
    instance: {
      name: instanceName,
      isBase,
      createdAt: record?.createdAt ?? 0,
      repoNames: repos.map((r) => r.name),
      appIds: repos.flatMap((r) => r.apps.map((a) => a.id)),
      checkouts,
      initialized: isBase || record.initializedAt !== undefined,
    },
    repos,
    drafts,
  };
}

/**
 * Base listens where the document says. Any other instance uses what it was
 * allocated, and a port it has not been allocated yet is `0` with a warning:
 * falling back to the declared number would put a second process on base's
 * port, which is the one collision instances exist to prevent.
 */
function instancePorts(
  baseId: TargetId,
  declared: Record<string, number> | undefined,
  record: InstanceRecord | undefined,
  warnings: string[],
): Record<string, number> {
  if (record === undefined) return { ...declared };
  const allocated = record.ports[baseId] ?? {};
  const out: Record<string, number> = {};
  for (const name of Object.keys(declared ?? {})) {
    const port = allocated[name];
    if (port === undefined) {
      warnings.push(`instance "${record.name}": no port allocated yet for "${name}" of ${baseId}`);
    }
    out[name] = port ?? 0;
  }
  return out;
}

/** `undefined` when the name can be used for an instance. */
export function instanceNameProblem(name: string): string | undefined {
  if (name === BASE_INSTANCE) return `"${BASE_INSTANCE}" is the name of the instance the config itself describes`;
  if (!NAME_PATTERN.test(name)) {
    return 'invalid instance name: use letters, digits, "_" or "-", starting with a letter or digit';
  }
  return undefined;
}

/** Deepest layer wins, and each key remembers which layer that was. */
function mergeTracked(
  layers: ReadonlyArray<{ at: string; values: Record<string, string> | undefined } | undefined>,
): { values: Record<string, string>; at: Record<string, string> } {
  const values: Record<string, string> = {};
  const at: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer?.values ?? {})) {
      values[key] = value;
      at[key] = `${layer?.at ?? "env"}.${key}`;
    }
  }
  return { values, at };
}

/** Lowercase with everything but letters and digits folded to `_`: safe in a database name. */
function instanceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

interface ResolverArgs {
  draft: Draft;
  workspaceName: string;
  rootDir: string;
  expand: (spec: string) => TargetId[] | undefined;
  inInstance: (baseId: TargetId, instance: string) => NormalizedApp | undefined;
}

/** What each `${…}` is worth for one app. Errors are messages; the caller knows the path. */
function referenceResolver(args: ResolverArgs): (ref: Ref) => Resolution {
  const { draft, workspaceName, rootDir, expand, inInstance } = args;
  const { app, repo } = draft;
  const isBase = app.instance === BASE_INSTANCE;

  const portOf = (owner: NormalizedApp, name: string, written: string): Resolution => {
    const port = owner.ports[name];
    if (port !== undefined) return { value: String(port) };
    const declared = Object.keys(owner.ports);
    return {
      error:
        `\${${written}}: "${owner.baseId}" declares no port "${name}"` +
        (declared.length > 0 ? ` (it has ${declared.map((p) => `"${p}"`).join(", ")})` : ' — add it under "ports"'),
    };
  };

  return (ref) => {
    switch (ref.kind) {
      case "port": {
        if (ref.target === undefined) return portOf(app, ref.name, `ports.${ref.name}`);
        const written = `${ref.target}.ports.${ref.name}`;
        const ids = expand(ref.target);
        if (!ids) return { error: `\${${written}}: ${unknownTarget(ref.target)}` };
        const [only, ...rest] = ids;
        if (only === undefined || rest.length > 0) {
          return { error: `\${${written}}: "${ref.target}" has several apps — name one: ${ids.join(", ")}` };
        }
        const owner = inInstance(only, app.instance);
        return owner ? portOf(owner, ref.name, written) : { error: `\${${written}}: ${unknownTarget(ref.target)}` };
      }
      case "var": {
        const value = draft.vars[ref.name];
        if (value !== undefined) return { value };
        return { error: `\${vars.${ref.name}}: no var "${ref.name}" is declared under "vars"` };
      }
      case "builtin": {
        const slug = instanceSlug(app.instance);
        const values: Record<string, Record<string, string>> = {
          instance: { name: app.instance, slug, suffix: isBase ? "" : `_${slug}` },
          workspace: { name: workspaceName, root: rootDir },
          repo: { name: repo.baseName, path: repo.path },
          base: { path: repo.basePath },
          app: { id: app.id, name: app.name, path: app.cwd },
        };
        const value = values[ref.scope]?.[ref.field];
        return value === undefined ? { error: `unknown reference "\${${ref.scope}.${ref.field}}"` } : { value };
      }
    }
  };
}

/**
 * Two base apps declaring one port is almost always a copy-paste, and the
 * second of them to start fails with an EADDRINUSE that names neither. A
 * warning rather than an error: two apps that are never run together may share
 * a port on purpose.
 */
function portWarnings(baseApps: readonly NormalizedApp[]): string[] {
  const out: string[] = [];
  const owners = new Map<number, string>();
  for (const app of baseApps) {
    for (const [name, port] of Object.entries(app.ports)) {
      const owner = owners.get(port);
      if (owner !== undefined) out.push(`port ${port} is declared by both ${owner} and ${app.id} ("${name}")`);
      else owners.set(port, `${app.id} ("${name}")`);
    }
  }
  return out;
}

function dedupeIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * The top-level `hooks` map: shell hooks for a command by name, whatever
 * declared the command.
 *
 * A key is checked as far as this layer can know the answer. A bare name can
 * only be a config command and the `app` namespace is closed, so a miss on
 * either is a certain typo and an error. Any other namespace belongs to a
 * plugin, whose commands exist only once the daemon has loaded it — and a
 * plugin that fails to load must not make the config invalid — so those keys
 * pass here and the daemon warns about the ones nothing provides.
 */
function normalizeHooks(
  raw: RawWorkspaceConfig["hooks"],
  commands: readonly NormalizedCommand[],
  issues: ConfigIssue[],
): Record<string, CommandHooks> {
  const declared = commands.filter((c) => c.source === "config").map((c) => c.name);
  const out: Record<string, CommandHooks> = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    const problem = hookCommandProblem(name, declared);
    if (problem !== undefined) {
      issues.push({ path: `hooks.${name}`, message: problem });
      continue;
    }
    out[name] = { pre: toArray(entry.pre), post: toArray(entry.post) };
  }
  return out;
}

/** Why `name` cannot key a `hooks` entry, or `undefined` when it may. */
function hookCommandProblem(name: string, declared: readonly string[]): string | undefined {
  const segments = name.split(":");
  if (!segments.every((segment) => BARE_NAME_PATTERN.test(segment))) {
    return (
      `invalid command name "${name}": a hooks entry is keyed by the name of one command — ` +
      `"test", "app:stop", "git:pull"`
    );
  }
  if (segments.length === 1) {
    if (declared.includes(name)) return undefined;
    const known = declared.length === 0 ? "none are declared" : `expected ${quotedList(declared)}`;
    return (
      `unknown command "${name}" — a bare name is a command declared under "commands" (${known}); ` +
      `core and plugin commands carry their namespace: "app:stop", "git:pull"`
    );
  }
  if (segments[0] === CORE_COMMAND_NAMESPACE && !CORE_COMMANDS.some((core) => core === name)) {
    return `unknown core command "${name}" — expected ${quotedList(CORE_COMMANDS)}`;
  }
  return undefined;
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
      const token = `{${tokenLabel(ns, name)}}`;
      if (row === "repo" && ns === CORE_COMMAND_NAMESPACE) {
        // The fallback runs one way: an app row may read its repo's cells, but a
        // header row stands for several apps and has no single one to read.
        out.push(`${at}: ${token} is an app-row token — a repo header row reads ${REPO_ROW_TOKENS}`);
      } else if (ns === NO_NAMESPACE) {
        // A bare token is a config indicator, and those are the only ones whose
        // *names* this layer knows in full.
        if (!declaredIndicators.has(name)) {
          out.push(`${at}: ${token} names no indicator declared under "indicators"`);
        }
      } else if (!namespaces.has(ns)) {
        out.push(
          `${at}: ${token} uses unknown namespace "${ns}" — expected ${quotedList([...namespaces])}; ` +
            `an indicator declared under "indicators" is written without one`,
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
const REPO_ROW_TOKENS = "{repo@name}, {repo@dirname}, {repo@path}, {repo@instance} or {repo@status}";

/** `"a", "b" or "c"`. */
function quotedList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  const last = quoted.pop() ?? "";
  return quoted.length === 0 ? last : `${quoted.join(", ")} or ${last}`;
}

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
