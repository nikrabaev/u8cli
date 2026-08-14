/**
 * The built-in `protos` plugin — link locally-built shared packages into the
 * subapps that consume them.
 *
 * A team that generates client libraries from a `.proto` repo publishes them as
 * ordinary npm packages, but tries a new contract locally first: build the
 * shared repo, `yalc publish` it, then `yalc add` it in each consumer. This
 * plugin owns the third step and the visibility around it — nothing else. The
 * build and the publish stay with the user, so there is no watcher here, no
 * guessed package manager, and no install run behind anyone's back.
 *
 * Four decisions shape the file:
 *
 *  - **Zero cost until configured.** With no `packages` the factory returns a
 *    plugin that contributes nothing: no indicators, no commands, no reads. A
 *    workspace that shares no contracts must not pay for this file existing.
 *  - **Commands are generated from the configured list.** u8 commands take no
 *    arguments, so "link @myorg/protos" cannot be spelled at invocation time.
 *    Each configured package therefore gets its own `protos:link:<alias>` at
 *    load, alongside the `protos:link` that does every package a target
 *    consumes.
 *  - **Everything is decided from files, synchronously and cached.**
 *    `appliesTo` is synchronous by contract, and it is the only way a command
 *    can report a target as *skipped* rather than failed — which is what
 *    unlinking a target with nothing linked has to be. So consumption and
 *    linkage are read from `package.json`, `.yalc/` and `node_modules/` through
 *    a stat-stamped cache, and the indicators read the same cache.
 *  - **A malformed manifest is a blank cell.** `package.json` is rewritten in
 *    place by every install and by yalc itself, so a poll landing on a
 *    half-written file is normal. It yields nothing and the next poll picks the
 *    file up again; it never throws into the registry.
 */
import fs from "node:fs";
import path from "node:path";

import { BARE_NAME_PATTERN, DEFAULT_PROTOS_INTERVAL_MS } from "../../config/index.js";
import type { ProtosOptions } from "../../config/types.js";
import { definePlugin } from "../../plugin/index.js";
import type {
  CommandContext,
  IndicatorDef,
  IndicatorResult,
  PluginCommandDef,
  PluginDefinition,
  TargetInfo,
} from "../../plugin/types.js";
import type { ExecResult } from "../../process/types.js";
import { errorMessage } from "../../util/errors.js";

/** Also the reserved namespace: `{protos@react-query}`, `protos:link`. */
export const PLUGIN_NAME = "protos";

/** The rollup cell, and therefore an alias no package may take. */
export const LINKED_INDICATOR = "linked";

/** The tool this plugin drives. Never bundled — the user installs it. */
export const YALC = "yalc";

/** Where `yalc add` puts its copy of a package, relative to the consumer. */
export const YALC_DIR = ".yalc";

/**
 * How a linked dependency is spelled in the consumer's `package.json` after
 * `yalc add`. Checked together with the `.yalc/<pkg>` directory: the rewrite
 * survives a deleted `.yalc`, and the directory survives a hand-edited
 * `package.json`, so either one alone can be a lie.
 */
export const LINK_PREFIX = "file:.yalc";

/** Rendered after the version of a linked package: `1.4.2 local`. */
export const LOCAL_SUFFIX = "local";

/**
 * Ceiling on one `yalc` invocation. It copies a package tree, so it is not
 * instant, but a command that has not finished in two minutes is wedged rather
 * than working.
 */
export const YALC_TIMEOUT_MS = 120_000;

/** Longest yalc diagnostic carried into a task result; the run log has the rest. */
const MAX_DIAGNOSTIC_CHARS = 300;

/** Diagnostic lines kept from a failing yalc: enough to explain, not to bury. */
const MAX_DIAGNOSTIC_LINES = 4;

/** Manifest fields a shared package can legitimately be declared in. */
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/**
 * Every shell reports a command it cannot find as exit 127, and yalc itself
 * never uses that code — so 127 means "this machine has no yalc", which is a
 * different conversation from "yalc refused".
 */
const NOT_FOUND_EXIT = 127;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** One configured package plus the name its command and indicator are spelled with. */
export interface ProtosPackage {
  /** The npm package name, e.g. `@myorg/react-query`. */
  name: string;
  /** `react-query` — the last segment, unless that would collide. */
  alias: string;
}

interface Settings {
  packages: ProtosPackage[];
  intervalMs: number;
}

/**
 * Options reach here straight from `u8.jsonc`, so they are validated again
 * rather than trusted: a plugin that throws while being constructed is a
 * disabled plugin, and "your interval is not a number" is not worth that.
 */
function settingsOf(options: ProtosOptions): Settings {
  const raw: Partial<ProtosOptions> = options ?? {};
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of Array.isArray(raw.packages) ? raw.packages : []) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const intervalMs =
    typeof raw.intervalMs === "number" && Number.isFinite(raw.intervalMs) && raw.intervalMs > 0
      ? raw.intervalMs
      : DEFAULT_PROTOS_INTERVAL_MS;
  const aliases = deriveAliases(names);
  return {
    packages: names.map((name) => ({ name, alias: aliases.get(name) ?? name })),
    intervalMs,
  };
}

/**
 * `@myorg/react-query` → `react-query`: the last segment is what a human calls
 * the package, and it is what `protos:link:<alias>` and `{protos@<alias>}` are
 * spelled with.
 *
 * It has to be unique, and it has to be a legal command/indicator name, so
 * three things force the fallback to the flattened full name: two packages
 * sharing a last segment (`@a/protos` and `@b/protos`), a segment that would
 * shadow the {@link LINKED_INDICATOR} rollup, and a segment that is not a bare
 * name. Uniqueness is resolved deterministically in config order, so the same
 * config always produces the same command names.
 */
export function deriveAliases(names: readonly string[]): Map<string, string> {
  const shared = new Map<string, number>();
  for (const name of names) {
    const last = lastSegment(name);
    shared.set(last, (shared.get(last) ?? 0) + 1);
  }

  const taken = new Set<string>([LINKED_INDICATOR]);
  const out = new Map<string, string>();
  names.forEach((name, index) => {
    const last = lastSegment(name);
    const ambiguous = (shared.get(last) ?? 0) > 1 || taken.has(last) || !BARE_NAME_PATTERN.test(last);
    let base = ambiguous ? flatten(name) : last;
    // Nothing in a package name survived sanitising — position is all that is left.
    if (!BARE_NAME_PATTERN.test(base)) base = `pkg${index + 1}`;
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    taken.add(alias);
    out.set(name, alias);
  });
  return out;
}

function lastSegment(name: string): string {
  return name.split("/").pop() ?? name;
}

/** `@myorg/react-query` → `myorg-react-query`, i.e. a bare name that is still readable. */
function flatten(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
}

// ---------------------------------------------------------------------------
// Manifest reads
// ---------------------------------------------------------------------------

interface Manifest {
  /** Empty when the file declares none. */
  version: string;
  /** Dependency name → declared range, `dependencies` winning over the rest. */
  deps: ReadonlyMap<string, string>;
}

/**
 * Reads `package.json` files and remembers each one against its stat stamp.
 *
 * Both callers need this. `appliesTo` is synchronous and is called for every
 * selected target on every run, and the indicators re-read the same three files
 * per package per poll — so the parse happens once per actual change, while the
 * `stat` behind it is what makes a change visible at all. Nanosecond mtime plus
 * size is used rather than mtime alone: an install can rewrite a manifest twice
 * inside one millisecond clock tick.
 */
class ManifestCache {
  private readonly entries = new Map<string, { stamp: string; manifest: Manifest | undefined }>();

  read(file: string): Manifest | undefined {
    let stamp: string;
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) {
        this.entries.delete(file);
        return undefined;
      }
      stamp = `${stat.mtimeNs}:${stat.size}`;
    } catch {
      // Absent, or unreadable: plenty of repos are not node projects at all.
      this.entries.delete(file);
      return undefined;
    }

    const hit = this.entries.get(file);
    if (hit !== undefined && hit.stamp === stamp) return hit.manifest;
    const manifest = parseManifest(file);
    this.entries.set(file, { stamp, manifest });
    return manifest;
  }
}

/**
 * Never throws. A `package.json` caught mid-write by an install is invalid JSON
 * for a few milliseconds, and that is a blank cell, not an error — the stamp
 * moves again when the writer finishes, and the next read picks it up.
 */
function parseManifest(file: string): Manifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;

  const deps = new Map<string, string>();
  for (const field of DEP_FIELDS) {
    const section = record[field];
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
    for (const [name, range] of Object.entries(section as Record<string, unknown>)) {
      // First field wins: a package in both `dependencies` and `peerDependencies`
      // is installed as the former, which is the one yalc rewrites.
      if (typeof range === "string" && !deps.has(name)) deps.set(name, range);
    }
  }
  const version = record["version"];
  return { version: typeof version === "string" ? version : "", deps };
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The state of one package in one subapp
// ---------------------------------------------------------------------------

/**
 * - `absent` — this subapp does not consume the package at all;
 * - `linked` — a yalc link is in place and in use;
 * - `installed` — a real copy is in `node_modules`;
 * - `declared` — depended on, but nothing is installed yet.
 */
type PackageState = "absent" | "linked" | "installed" | "declared";

interface PackageStatus {
  state: PackageState;
  /** The version or range to render; empty when nothing could be read. */
  text: string;
}

const ABSENT: PackageStatus = { state: "absent", text: "" };

/**
 * What `pkg` currently is, for the consumer rooted at `cwd`.
 *
 * The subapp's *own* `node_modules` is what is inspected, deliberately: it is
 * the tree its dev server resolves from, and walking up to a hoisted root would
 * report a copy this subapp may not be using.
 */
function statusOf(cache: ManifestCache, cwd: string, pkg: string): PackageStatus {
  const consumer = cache.read(path.join(cwd, "package.json"));
  const range = consumer?.deps.get(pkg);
  if (range === undefined) return ABSENT;

  if (range.startsWith(LINK_PREFIX) && isDirectory(path.join(cwd, YALC_DIR, pkg))) {
    const local = cache.read(path.join(cwd, YALC_DIR, pkg, "package.json"));
    return { state: "linked", text: local?.version ?? "" };
  }

  const installed = cache.read(path.join(cwd, "node_modules", pkg, "package.json"));
  if (installed !== undefined && installed.version !== "") {
    return { state: "installed", text: installed.version };
  }
  return { state: "declared", text: range };
}

/** Tone is a suggestion; a template's own `color()` modifier overrides it. */
function cellOf(status: PackageStatus): IndicatorResult {
  switch (status.state) {
    // Empty, not "n/a": a subapp that consumes nothing should render a blank
    // cell rather than a column of noise on every row that is not a consumer.
    case "absent":
      return "";
    // Being on a local link is a state you want to see from across the room —
    // it is why a build works here and nowhere else.
    case "linked":
      return { value: status.text === "" ? LOCAL_SUFFIX : `${status.text} ${LOCAL_SUFFIX}`, tone: "warn" };
    case "installed":
      return { value: status.text, tone: "ok" };
    default:
      return { value: status.text, tone: "muted" };
  }
}

// ---------------------------------------------------------------------------
// Running yalc
// ---------------------------------------------------------------------------

type YalcOutcome = { kind: "ok" } | { kind: "missing" } | { kind: "failed"; detail: string };

/**
 * What to tell someone whose machine has no yalc. ENOENT would tell them nothing.
 *
 * Two things decide the wording. The CLI renders a failed target's error as one
 * ~80-column table cell, so anything after the first line's worth of text is
 * read only by someone who opens the run log — the instruction goes first and
 * the explanation second, not the other way round.
 *
 * And the instruction has to be the one that actually works. The daemon runs
 * these commands, and it inherits its PATH once, when it is spawned; a user who
 * installs yalc and re-runs is still talking to the old daemon and gets this
 * same error back, with `which yalc` succeeding in their shell the whole time.
 * Anyone reading this message therefore has a daemon that needs restarting, so
 * naming that step is not a caveat — it is half the fix.
 */
function missingYalcMessage(): string {
  return (
    `${YALC} is not on PATH — install it ("npm i -g ${YALC}"), then "u8 daemon stop". ` +
    `A running daemon keeps the PATH it started with, so a fresh install stays invisible ` +
    `to it until it restarts. The protos commands shell out to ${YALC} to link local packages`
  );
}

/**
 * Runs one yalc invocation in the subapp, mirroring its output into the run log.
 *
 * `ctx.exec` buffers rather than streams — the SDK has no streaming exec — so
 * the lines land when the command finishes.
 */
async function runYalc(ctx: CommandContext, args: readonly string[]): Promise<YalcOutcome> {
  const cmd = [YALC, ...args.map(shellArg)].join(" ");
  ctx.log(`$ ${cmd}`);

  let res: ExecResult;
  try {
    res = await ctx.exec(cmd, { timeoutMs: YALC_TIMEOUT_MS });
  } catch (err) {
    // `exec` only rejects when the shell itself cannot start.
    return { kind: "failed", detail: errorMessage(err) };
  }

  for (const line of outputLines(res)) ctx.log(line);
  if (res.ok) return { kind: "ok" };
  if (res.exitCode === NOT_FOUND_EXIT) return { kind: "missing" };
  return { kind: "failed", detail: diagnostic(res) };
}

/**
 * Package names need no quoting, but they come from a config file rather than
 * from npm, so anything that is not plainly a package name is quoted before it
 * reaches a shell. Plain names stay bare, because the `$ yalc add …` line in
 * the run log is meant to be copy-pasteable.
 */
function shellArg(value: string): string {
  if (/^[A-Za-z0-9@._/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function outputLines(res: ExecResult): string[] {
  return `${res.stdout}\n${res.stderr}`.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Head-biased, like the git built-in: what a failing command says first is what
 * explains it. yalc has no `fatal:` convention to key off, so the opening lines
 * are carried verbatim — cryptic or not, they are the only evidence the user
 * has, and the whole output is still in the run log.
 */
function diagnostic(res: ExecResult): string {
  const lines = `${res.stderr}\n${res.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > 0) return lines.slice(0, MAX_DIAGNOSTIC_LINES).join("; ").slice(0, MAX_DIAGNOSTIC_CHARS);
  if (res.timedOut) return `timed out after ${YALC_TIMEOUT_MS}ms`;
  if (res.signal !== null) return `killed by ${res.signal}`;
  return `exit ${res.exitCode ?? "none"}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Links every named package that this subapp actually consumes.
 *
 * Every package is attempted even after one fails: a partial link is a state
 * the user can finish by hand, whereas stopping at the first failure hides the
 * second one behind another round trip.
 */
async function link(ctx: CommandContext, cache: ManifestCache, packages: readonly ProtosPackage[]): Promise<void> {
  const wanted = packages.filter((pkg) => statusOf(cache, ctx.cwd, pkg.name).state !== "absent");
  if (wanted.length === 0) {
    // Only reachable if the manifest changed between `appliesTo` and here.
    ctx.log(`nothing to link: ${ctx.target.id} does not depend on ${names(packages)}`);
    return;
  }

  const failures: string[] = [];
  for (const pkg of wanted) {
    const outcome = await runYalc(ctx, ["add", pkg.name]);
    // One missing binary is every package's failure; there is nothing to retry.
    if (outcome.kind === "missing") throw new Error(missingYalcMessage());
    if (outcome.kind === "failed") failures.push(`${pkg.name}: ${outcome.detail}`);
  }
  if (failures.length === 0) return;

  // The store miss is the failure this design invites: linking is deliberately
  // all this plugin does, so the publish that fills the store is the user's
  // step — and yalc's own words for "it is not in the store" are not enough to
  // work that out from. Hence the question first and yalc's words after it: the
  // CLI truncates this to one ~80-column cell, and of the two halves the one
  // worth spending that budget on is the one that says what to do next.
  throw new Error(
    `${YALC} add failed — is the package built and "${YALC} publish"ed? Do that in the ` +
      `shared-contracts repo, then link again. ${YALC} said: ${failures.join("; ")}`,
  );
}

/**
 * Removes the yalc links this subapp currently has.
 *
 * A target with nothing linked never gets here: `appliesTo` reports it as
 * skipped, which is the honest answer — there was nothing to do, and nothing
 * went wrong.
 */
async function unlink(ctx: CommandContext, cache: ManifestCache, packages: readonly ProtosPackage[]): Promise<void> {
  const linked = packages.filter((pkg) => statusOf(cache, ctx.cwd, pkg.name).state === "linked");
  if (linked.length === 0) {
    ctx.log(`nothing to unlink: no ${YALC} link for ${names(packages)} in ${ctx.target.id}`);
    return;
  }

  const failures: string[] = [];
  const removed: string[] = [];
  for (const pkg of linked) {
    const outcome = await runYalc(ctx, ["remove", pkg.name]);
    if (outcome.kind === "missing") throw new Error(missingYalcMessage());
    if (outcome.kind === "failed") failures.push(`${pkg.name}: ${outcome.detail}`);
    else removed.push(pkg.name);
  }

  // `yalc remove` restores the dependency range but never touches node_modules,
  // so the code that runs is still the linked copy. Which installer to run is
  // the user's business: guessing between npm, pnpm and yarn — and running it
  // uninvited — is how a dashboard command eats a lockfile.
  for (const name of removed) {
    if (!isDirectory(path.join(ctx.cwd, "node_modules", name))) continue;
    ctx.log(
      `node_modules/${name} still holds the linked copy — run your package manager's install ` +
        `in ${ctx.cwd} to restore the published version`,
    );
  }

  if (failures.length > 0) throw new Error(`${YALC} remove failed — ${failures.join("; ")}`);
}

function names(packages: readonly ProtosPackage[]): string {
  return packages.map((pkg) => pkg.name).join(", ");
}

/**
 * `packages` is the whole configured list for `protos:link` and a single
 * element for `protos:link:<alias>` — the two differ only in what they act on,
 * so they share every rule about how.
 */
function linkCommand(
  cache: ManifestCache,
  packages: readonly ProtosPackage[],
  description: string,
): PluginCommandDef {
  return {
    kind: "task",
    description,
    // Per target, never per app: each subapp has its own node_modules and its
    // own .yalc, so two subapps of one repo are two independent links.
    groupBy: "target",
    appliesTo: (target: TargetInfo) =>
      packages.some((pkg) => statusOf(cache, target.cwd, pkg.name).state !== "absent"),
    run: (ctx) => link(ctx, cache, packages),
  };
}

function unlinkCommand(
  cache: ManifestCache,
  packages: readonly ProtosPackage[],
  description: string,
): PluginCommandDef {
  return {
    kind: "task",
    description,
    groupBy: "target",
    // Nothing linked means nothing to undo. Reporting that through `appliesTo`
    // is what makes such a target *skipped* rather than failed — `run` has no
    // way to say "not applicable".
    appliesTo: (target: TargetInfo) =>
      packages.some((pkg) => statusOf(cache, target.cwd, pkg.name).state === "linked"),
    run: (ctx) => unlink(ctx, cache, packages),
  };
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

function packageIndicator(cache: ManifestCache, pkg: ProtosPackage, intervalMs: number): IndicatorDef {
  return {
    scope: "subapp",
    description: `Effective version of ${pkg.name} here: installed, declared, or the linked local build`,
    update: { mode: "poll", intervalMs },
    value: (ctx) => cellOf(statusOf(cache, ctx.cwd, pkg.name)),
  };
}

function rollupIndicator(cache: ManifestCache, packages: readonly ProtosPackage[], intervalMs: number): IndicatorDef {
  return {
    scope: "subapp",
    description: "How many shared packages are currently linked to a local build here",
    update: { mode: "poll", intervalMs },
    value(ctx) {
      const count = packages.filter((pkg) => statusOf(cache, ctx.cwd, pkg.name).state === "linked").length;
      return count === 0 ? "" : { value: `${count} ${LOCAL_SUFFIX}`, tone: "warn" };
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * Builds the plugin from its configured options.
 *
 * With no packages configured the result is inert by construction — an empty
 * definition contributes no providers to poll and no commands to list, which is
 * what "a built-in that costs nothing until a workspace wants it" has to mean.
 */
export function createProtosPlugin(options: ProtosOptions): PluginDefinition {
  const { packages, intervalMs } = settingsOf(options);
  if (packages.length === 0) return definePlugin({ name: PLUGIN_NAME });

  const cache = new ManifestCache();

  const indicators: Record<string, IndicatorDef> = {
    [LINKED_INDICATOR]: rollupIndicator(cache, packages, intervalMs),
  };
  const commands: Record<string, PluginCommandDef> = {
    link: linkCommand(cache, packages, "Link every configured shared package this subapp consumes"),
    unlink: unlinkCommand(cache, packages, "Remove every local shared-package link from this subapp"),
  };
  for (const pkg of packages) {
    indicators[pkg.alias] = packageIndicator(cache, pkg, intervalMs);
    commands[`link:${pkg.alias}`] = linkCommand(cache, [pkg], `Link the local build of ${pkg.name} here`);
    commands[`unlink:${pkg.alias}`] = unlinkCommand(cache, [pkg], `Remove the local ${pkg.name} link from here`);
  }

  return definePlugin({ name: PLUGIN_NAME, indicators, commands });
}

/**
 * The plugin host's factory hook for a built-in: `protos` has nothing to
 * contribute until it is told which packages are shared, so unlike `git` it has
 * no useful unwired instance to export.
 */
export const createPlugin = createProtosPlugin;

export default createProtosPlugin;
