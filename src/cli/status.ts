/**
 * `u8 status` — the same rows the TUI draws, printed once.
 *
 * The rows come from the template engine fed with the daemon's indicator cache
 * (SPEC §2.7: one source of truth), so text output here and the dashboard can
 * never disagree about what a target's state is. Layout follows §4: a repo
 * header row with its app rows beneath, and a single-app repo collapsed
 * into one merged row rendered with the app template.
 *
 * `--json` is the machine contract and is versioned separately from the wire
 * protocol: it reports the same cache in a shape a script can depend on, never
 * carries ANSI, and stays additive — new fields may appear, existing ones do not
 * change meaning without a `schemaVersion` bump.
 */
import { aggregateStatus, appStatus, type CoreStatus } from "../indicators/index.js";
import type {
  IndicatorValue,
  ServiceState,
  Snapshot,
  SnapshotApp,
  SnapshotInstance,
  SnapshotProfile,
  SnapshotRepo,
} from "../ipc/protocol.js";
import { renderTemplate, tokenLabel, type IndicatorLookup } from "../template/index.js";
import { describeDirectory } from "../util/dirs.js";
import { U8Error } from "../util/errors.js";
import { VERSION } from "../version.js";
import { instanceIn, scopeOf, warnUnregistered, withClient, type CliContext } from "./context.js";
import { writeLine, writeLines } from "./io.js";

/**
 * Bumped only on a breaking change to the `--json` shape. 3: target ids and
 * repo names are instance-qualified (`api@feat-x`) outside base, the document
 * says which instance it describes, and a config-declared indicator is keyed by
 * its bare name.
 */
export const STATUS_SCHEMA_VERSION = 3;

export interface StatusOptions {
  json?: boolean;
  /** Render this profile instead of the active one; does not switch it. */
  profile?: string;
}

// ---------------------------------------------------------------------------
// `--json`
// ---------------------------------------------------------------------------

/**
 * Indicator values keyed as a template spells them — `"app@status"`,
 * `"git@branch"`, a bare `"version"` for one declared in config — and raw
 * (never the pre-rendered `display`).
 */
export type IndicatorMap = Record<string, string>;

export interface StatusJsonApp {
  /** Instance-qualified outside base: `api@feat-x`. */
  id: string;
  /** The id as the config spells it. */
  baseId: string;
  instance: string;
  name: string;
  repoName: string;
  implicit: boolean;
  cwd: string;
  /** Named ports as this instance has them. */
  ports: Record<string, number>;
  /** `http://localhost:<port>` per named port — where to send a request to *this* copy. */
  urls: Record<string, string>;
  /** `stopped | starting | running | crashed | stopping | stale` (SPEC §3). */
  status: CoreStatus;
  stale: boolean;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number | null;
  exitCode: number | null;
  restartAttempts: number;
  error: string | null;
  hasHealth: boolean;
  dependsOn: string[];
  scripts: string[];
  indicators: IndicatorMap;
}

export interface StatusJsonRepo {
  name: string;
  /** The repo's key in the config. */
  baseName: string;
  instance: string;
  path: string;
  /** Aggregate of the repo's selected apps — worst state wins. */
  status: CoreStatus;
  indicators: IndicatorMap;
  apps: StatusJsonApp[];
}

export interface StatusJson {
  schemaVersion: number;
  /** Version of the `u8` that printed this. */
  version: string;
  daemonVersion: string;
  workspace: { id: string; name: string; rootDir: string; configPath: string };
  /** The instance `repos` describes. */
  instance: StatusJsonInstance;
  /** Every instance of the workspace, base first. */
  instances: StatusJsonInstance[];
  /**
   * `name` is what was rendered; `active` is the workspace's current profile.
   * Profiles select among base apps, so outside base `name` is the instance's
   * own and `targets` is everything it runs.
   */
  profile: { name: string; active: string; targets: string[] };
  profiles: Array<{ name: string; isDefault: boolean; targets: string[] }>;
  commands: Array<{ name: string; kind: string; source: string; appliesTo: string[] }>;
  repos: StatusJsonRepo[];
  plugins: Array<{ name: string; spec: string; ok: boolean; error: string | null }>;
  /** Formatted validation errors while last-good config is in use, else null. */
  configError: string | null;
}

export interface StatusJsonInstance {
  name: string;
  isBase: boolean;
  /** Whether its init steps have completed. */
  initialized: boolean;
  targets: string[];
  running: number;
  /** Checkout root per repo; empty for base, whose repos are where the config says. */
  checkouts: Record<string, { path: string; owned: boolean; branch: string | null }>;
}

function jsonInstance(snapshot: Snapshot, instance: SnapshotInstance): StatusJsonInstance {
  const own = new Set(instance.appIds);
  return {
    name: instance.name,
    isBase: instance.isBase,
    initialized: instance.initialized,
    targets: [...instance.appIds],
    running: snapshot.services.filter((s) => own.has(s.targetId) && s.status === "running").length,
    checkouts: Object.fromEntries(
      Object.entries(instance.checkouts).map(([repo, c]) => [
        repo,
        { path: c.path, owned: c.owned, branch: c.branch ?? null },
      ]),
    ),
  };
}

export function buildStatusJson(
  snapshot: Snapshot,
  profile: SnapshotProfile,
  now = Date.now(),
  instance: SnapshotInstance | undefined = snapshot.instances.find((i) => i.isBase),
): StatusJson {
  const services = new Map(snapshot.services.map((s) => [s.targetId, s]));
  const selected = new Set(profile.appIds);
  const values = indexIndicators(snapshot.indicators);

  const repos: StatusJsonRepo[] = [];
  for (const repo of snapshot.repos) {
    const apps = repo.apps.filter((a) => selected.has(a.id));
    if (apps.length === 0) continue;
    repos.push({
      name: repo.name,
      baseName: repo.baseName,
      instance: repo.instance,
      path: repo.path,
      status: aggregateStatus(apps.map((a) => services.get(a.id)).filter(isState)),
      indicators: values.map("repo", repo.name),
      apps: apps.map((app) => jsonApp(app, services.get(app.id), values, now)),
    });
  }

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    version: VERSION,
    daemonVersion: snapshot.daemonVersion,
    workspace: { ...snapshot.workspace },
    instance: jsonInstance(
      snapshot,
      instance ?? { name: "base", isBase: true, createdAt: 0, appIds: [], checkouts: {}, initialized: true },
    ),
    instances: snapshot.instances.map((i) => jsonInstance(snapshot, i)),
    profile: { name: profile.name, active: snapshot.activeProfile, targets: [...profile.appIds] },
    profiles: snapshot.profiles.map((p) => ({
      name: p.name,
      isDefault: p.isDefault,
      targets: [...p.appIds],
    })),
    commands: snapshot.commands.map((c) => ({
      name: c.name,
      kind: c.kind,
      source: c.source,
      appliesTo: [...c.appliesTo],
    })),
    repos,
    plugins: snapshot.plugins.map((p) => ({
      name: p.name,
      spec: p.spec,
      ok: p.ok,
      error: p.error ?? null,
    })),
    configError: snapshot.configError ?? null,
  };
}

function jsonApp(
  app: SnapshotApp,
  state: ServiceState | undefined,
  values: IndicatorIndex,
  now: number,
): StatusJsonApp {
  const running = state?.status === "running" && state.startedAt !== undefined;
  return {
    id: app.id,
    baseId: app.baseId,
    instance: app.instance,
    name: app.name,
    repoName: app.repoName,
    implicit: app.implicit,
    cwd: app.cwd,
    ports: { ...app.ports },
    urls: Object.fromEntries(
      Object.entries(app.ports)
        .filter(([, port]) => port > 0)
        .map(([name, port]) => [name, `http://localhost:${port}`]),
    ),
    status: appStatus(state),
    stale: state?.stale === true,
    pid: state?.pid ?? null,
    startedAt: state?.startedAt ?? null,
    uptimeMs: running && state?.startedAt !== undefined ? Math.max(0, now - state.startedAt) : null,
    exitCode: state?.exitCode ?? null,
    restartAttempts: state?.restartAttempts ?? 0,
    error: state?.lastError ?? null,
    hasHealth: app.hasHealth,
    dependsOn: [...app.dependsOn],
    scripts: [...app.scripts],
    indicators: values.map("app", app.id),
  };
}

function isState(state: ServiceState | undefined): state is ServiceState {
  return state !== undefined;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface IndicatorIndex {
  find(scope: "repo" | "app", owner: string, ns: string, name: string): IndicatorValue | undefined;
  map(scope: "repo" | "app", owner: string): IndicatorMap;
}

function indexIndicators(values: readonly IndicatorValue[]): IndicatorIndex {
  const byCell = new Map<string, IndicatorValue>();
  const byOwner = new Map<string, IndicatorMap>();
  for (const value of values) {
    byCell.set(`${value.scope} ${value.owner} ${value.ns} ${value.name}`, value);
    const key = `${value.scope} ${value.owner}`;
    const map = byOwner.get(key) ?? {};
    map[tokenLabel(value.ns, value.name)] = value.value;
    byOwner.set(key, map);
  }
  return {
    find: (scope, owner, ns, name) => byCell.get(`${scope} ${owner} ${ns} ${name}`),
    map: (scope, owner) => byOwner.get(`${scope} ${owner}`) ?? {},
  };
}

/**
 * Lookup for an app row, falling back to the repo's cells.
 *
 * The fallback is what lets an app template mention `{git@branch}`: git is
 * repo-scoped, and the merged row of a single-app repo is rendered with the
 * *app* template, so without it the most common one-repo workspace would show
 * `{git@branch!}` in red.
 */
function appLookup(values: IndicatorIndex, app: SnapshotApp, color: boolean): IndicatorLookup {
  return (ns, name) =>
    legible(values.find("app", app.id, ns, name) ?? values.find("repo", app.repoName, ns, name), color);
}

function repoLookup(values: IndicatorIndex, repo: SnapshotRepo, color: boolean): IndicatorLookup {
  return (ns, name) => legible(values.find("repo", repo.name, ns, name), color);
}

/**
 * Without colour, a glyph is not a status.
 *
 * `app@status` renders as a `●` coloured by state — SPEC §4's semantic default,
 * and exactly right in a terminal. Piped into a file it is a dot that means
 * nothing, identical for `running` and `crashed`. So when colour is off, a cell
 * whose meaning lives in its *tone* falls back to its raw value and the row
 * reads `running` / `crashed` instead. Modifiers still apply to what is left, so
 * a padded column stays aligned.
 */
function legible(value: IndicatorValue | undefined, color: boolean): IndicatorValue | undefined {
  if (color || value === undefined) return value;
  if (value.display === undefined || value.tone === undefined) return value;
  return { ...value, display: undefined };
}

/** One rendered line plus what it describes, so a caller can indent or filter. */
export interface StatusRow {
  kind: "repo" | "app" | "merged";
  /** Repo name for `repo` rows, target id otherwise. */
  id: string;
  text: string;
}

export function renderStatusRows(
  snapshot: Snapshot,
  profile: SnapshotProfile,
  color: boolean,
): StatusRow[] {
  const values = indexIndicators(snapshot.indicators);
  const selected = new Set(profile.appIds);
  const opts = { color };
  const rows: StatusRow[] = [];

  for (const repo of snapshot.repos) {
    const apps = repo.apps.filter((a) => selected.has(a.id));
    if (apps.length === 0) continue;

    // SPEC §4: a repo with one app is one row, not a header plus a child.
    const only = repo.apps.length === 1 ? apps[0] : undefined;
    if (only !== undefined) {
      const template = only.template ?? repo.template ?? snapshot.templates.app;
      rows.push({
        kind: "merged",
        id: only.id,
        text: renderTemplate(template, appLookup(values, only, color), opts).trimEnd(),
      });
      continue;
    }

    rows.push({
      kind: "repo",
      id: repo.name,
      text: renderTemplate(repo.template ?? snapshot.templates.repo, repoLookup(values, repo, color), opts).trimEnd(),
    });
    for (const app of apps) {
      rows.push({
        kind: "app",
        id: app.id,
        text: renderTemplate(
          app.template ?? snapshot.templates.app,
          appLookup(values, app, color),
          opts,
        ).trimEnd(),
      });
    }
  }
  return rows;
}

/**
 * `myworkspace · profile full · 2/3 running` — the TUI header, on one line.
 * Outside base it names the instance instead: an instance has no profile, and
 * which one this is matters more than anything else on the line.
 */
export function renderStatusHeader(
  ctx: CliContext,
  snapshot: Snapshot,
  profile: SnapshotProfile,
  instance?: SnapshotInstance,
): string {
  const selected = new Set(profile.appIds);
  const running = snapshot.services.filter((s) => selected.has(s.targetId) && s.status === "running").length;
  if (instance !== undefined && !instance.isBase) {
    const note = instance.initialized ? "" : " · not initialised";
    return ctx.style.dim(
      `${snapshot.workspace.name} · instance ${instance.name}${note} · ${running}/${selected.size} running`,
    );
  }
  const suffix = profile.name === snapshot.activeProfile ? "" : ` (active: ${snapshot.activeProfile})`;
  return ctx.style.dim(
    `${snapshot.workspace.name} · profile ${profile.name}${suffix} · ${running}/${selected.size} running`,
  );
}

/**
 * One line naming the workspace's other instances, so a status of one of them
 * never reads as the whole picture. Empty when there is only base.
 */
export function renderOtherInstances(ctx: CliContext, snapshot: Snapshot, current: string): string | undefined {
  const others = snapshot.instances.filter((i) => i.name !== current);
  if (others.length === 0) return undefined;
  const running = new Set(snapshot.services.filter((s) => s.status === "running").map((s) => s.targetId));
  const parts = others.map((i) => `${i.name} ${i.appIds.filter((id) => running.has(id)).length}/${i.appIds.length}`);
  return ctx.style.dim(`other instances: ${parts.join(", ")} — u8 -i <name> status`);
}

/**
 * What a status shows: a profile's apps in base, and every app of the instance
 * anywhere else. Shaped as a profile because that is what every renderer below
 * already selects by.
 */
export function selectionFor(
  snapshot: Snapshot,
  instance: SnapshotInstance,
  profileName: string | undefined,
): SnapshotProfile {
  if (instance.isBase) return selectProfile(snapshot, profileName);
  if (profileName !== undefined) {
    throw new U8Error(
      "UNKNOWN_PROFILE",
      `--profile selects among base's apps; instance "${instance.name}" always shows the apps it runs`,
      { profile: profileName, instance: instance.name },
    );
  }
  return { name: instance.name, isDefault: false, appIds: [...instance.appIds] };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function selectProfile(snapshot: Snapshot, name: string | undefined): SnapshotProfile {
  const wanted = name ?? snapshot.activeProfile;
  const profile = snapshot.profiles.find((p) => p.name === wanted);
  if (!profile) {
    throw new U8Error("UNKNOWN_PROFILE", `unknown profile "${wanted}"`, {
      profile: wanted,
      known: snapshot.profiles.map((p) => p.name),
    });
  }
  return profile;
}

export async function statusCommand(ctx: CliContext, opts: StatusOptions): Promise<number> {
  const scope = scopeOf(ctx);
  warnUnregistered(ctx, scope);
  return withClient(ctx, {}, async (client) => {
    const snapshot = await client.request("workspace.snapshot", {});
    const instance = instanceIn(snapshot, scope);
    const profile = selectionFor(snapshot, instance, opts.profile);

    if (opts.json === true) {
      writeLine(ctx.io.stdout, JSON.stringify(buildStatusJson(snapshot, profile, Date.now(), instance), null, 2));
      return 0;
    }

    writeLine(ctx.io.stdout, renderStatusHeader(ctx, snapshot, profile, instance));
    const rows = renderStatusRows(snapshot, profile, ctx.color);
    if (rows.length === 0) {
      const what = instance.isBase ? `profile "${profile.name}"` : `instance "${instance.name}"`;
      writeLine(ctx.io.stdout, ctx.style.dim(`  no targets in ${what}`));
    } else {
      writeLines(ctx.io.stdout, rows.map((r) => r.text));
    }
    const others = renderOtherInstances(ctx, snapshot, instance.name);
    if (others !== undefined) writeLine(ctx.io.stderr, others);
    warn(ctx, snapshot, profile);
    return 0;
  });
}

/**
 * Diagnostics go to stderr so `u8 status | …` stays rows-only, but they are
 * never silent: a stale last-good config, a directory that is not there or a
 * disabled plugin explains everything the rows are about to look wrong about.
 */
function warn(ctx: CliContext, snapshot: Snapshot, profile: SnapshotProfile): void {
  if (snapshot.configError !== undefined) {
    writeLine(ctx.io.stderr, ctx.style.red(`config error (using last-good config):\n${snapshot.configError}`));
  }
  for (const line of unusableDirectories(snapshot, profile)) {
    writeLine(ctx.io.stderr, ctx.style.yellow(line));
  }
  for (const plugin of snapshot.plugins) {
    if (plugin.ok) continue;
    writeLine(ctx.io.stderr, ctx.style.yellow(`plugin "${plugin.name}" is disabled: ${plugin.error ?? "unknown error"}`));
  }
}

/**
 * Targets the filesystem has already ruled out.
 *
 * `stopped` is how the table renders both "nobody has started it" and "it could
 * never start", and the row itself cannot tell them apart — the template belongs
 * to the user, and no indicator knows about directories. So the difference is
 * said here instead, in the words the config layer uses in `daemon.log` and the
 * process layer uses in a service log, and only for what the profile is actually
 * showing: a directory nobody is looking at is not this command's business.
 */
function unusableDirectories(snapshot: Snapshot, profile: SnapshotProfile): string[] {
  const selected = new Set(profile.appIds);
  const out: string[] = [];

  for (const repo of snapshot.repos) {
    const apps = repo.apps.filter((a) => selected.has(a.id));
    if (apps.length === 0) continue;

    // Nothing can exist under a directory that does not, so a repo whose own
    // `path` is broken is one line to act on, not one line per app beneath it.
    const repoProblem = describeDirectory(repo.path);
    if (repoProblem !== undefined) {
      out.push(`${repo.name} cannot start: ${repoProblem}`);
      continue;
    }
    for (const app of apps) {
      // An implicit app *is* the repo entry; the check above already covered it.
      if (app.cwd === repo.path) continue;
      const problem = describeDirectory(app.cwd);
      if (problem !== undefined) out.push(`${app.id} cannot start: ${problem}`);
    }
  }
  return out;
}
