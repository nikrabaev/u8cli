/**
 * What the dashboard knows about an instance, read off a snapshot.
 *
 * Pure functions on purpose, like `present.ts`: with ten instances on screen
 * the questions worth answering at a glance — is it initialised, is something
 * running against a wiring that has since changed, is it leaning on a base app
 * that is down — are all derivations, and a derivation is a unit test. Nothing
 * here decides what an instance may do; the daemon does, and says so.
 */
import { formatDuration } from "../cli/format.js";
import { explicitTarget, externalDependenciesDown, urlsOf } from "../cli/instance-report.js";
import { BASE_INSTANCE, splitQualified, type TargetId } from "../config/types.js";
import type { Snapshot, SnapshotApp, SnapshotInstance } from "../ipc/protocol.js";
import type { SectionFlag } from "./rows.js";
import type { ToneLine } from "./types.js";

/** One indicator cell's raw value, or `undefined` when nothing publishes it. */
export type IndicatorReader = (scope: "repo" | "app", owner: string, ns: string, name: string) => string | undefined;

export function findInstance(snapshot: Snapshot, name: string): SnapshotInstance | undefined {
  return snapshot.instances.find((i) => i.name === name);
}

/** An instance's apps, in the order the config declares them. */
export function instanceApps(snapshot: Snapshot, name: string): SnapshotApp[] {
  const own = new Set(findInstance(snapshot, name)?.appIds ?? []);
  return snapshot.repos.flatMap((r) => r.apps).filter((a) => own.has(a.id));
}

/** Base's apps the instance has no copy of — what `add` can give it. */
export function addableApps(snapshot: Snapshot, name: string): SnapshotApp[] {
  const has = new Set(instanceApps(snapshot, name).map((a) => a.baseId));
  return snapshot.repos
    .filter((r) => r.instance === BASE_INSTANCE)
    .flatMap((r) => r.apps)
    .filter((a) => !has.has(a.id));
}

export interface KeptCheckout {
  /** The repo as the config names it. */
  repo: string;
  path: string;
  owned: boolean;
}

/**
 * Checkouts an earlier remove left in place: still the instance's, with no app
 * running from them. Their repo is absent from `snapshot.repos`, which only
 * lists repos that have apps.
 */
export function keptCheckouts(snapshot: Snapshot, name: string): KeptCheckout[] {
  const instance = findInstance(snapshot, name);
  if (!instance) return [];
  const inUse = new Set(snapshot.repos.filter((r) => r.apps.length > 0).map((r) => r.name));
  return Object.entries(instance.checkouts)
    .filter(([qualified]) => !inUse.has(qualified))
    .map(([qualified, c]) => ({ repo: splitQualified(qualified).name, path: c.path, owned: c.owned }));
}

/** Running apps of `appIds` whose definition has moved on since they were spawned. */
export function staleApps(snapshot: Snapshot, appIds: readonly TargetId[]): TargetId[] {
  const own = new Set(appIds);
  return snapshot.services.filter((s) => s.stale && own.has(s.targetId)).map((s) => s.targetId);
}

export function runningCount(snapshot: Snapshot, appIds: readonly TargetId[]): number {
  const own = new Set(appIds);
  return snapshot.services.filter((s) => s.status === "running" && own.has(s.targetId)).length;
}

export interface SectionFacts {
  initialized: boolean;
  /** The command of a run in flight on one of its apps. */
  busy?: string;
  stale: readonly TargetId[];
  /** Apps of another instance it depends on that are not running. */
  down: readonly string[];
}

/**
 * What a heading says after the running count, worst last so it sits where
 * the eye ends up. Empty for an instance with nothing to report, which is what
 * makes the ones that have something stand out in a list of ten.
 */
export function sectionFlags(facts: SectionFacts): SectionFlag[] {
  const flags: SectionFlag[] = [];
  if (facts.busy !== undefined) flags.push({ text: `… ${facts.busy}`, tone: "info" });
  if (!facts.initialized) flags.push({ text: "not initialised", tone: "warn" });
  if (facts.stale.length > 0) flags.push({ text: `${facts.stale.length} stale`, tone: "warn" });
  if (facts.down.length > 0) {
    const names = facts.down.map(explicitTarget).join(", ");
    flags.push({ text: `${names} ${facts.down.length === 1 ? "is" : "are"} down`, tone: "error" });
  }
  return flags;
}

export function sectionFacts(snapshot: Snapshot, instance: SnapshotInstance, appIds: readonly TargetId[], busy?: string): SectionFacts {
  return {
    initialized: instance.initialized,
    busy,
    stale: staleApps(snapshot, appIds),
    down: externalDependenciesDown(snapshot, instance.name),
  };
}

/** `2/3 running · 1 stale` — a heading's facts as one plain line. */
export function sectionSummary(running: number, total: number, flags: readonly SectionFlag[]): string {
  return [`${running}/${total} running`, ...flags.map((f) => f.text)].join(" · ");
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

/**
 * What a reload did to the instances, in words.
 *
 * Every instance mutation is a workspace reload in the daemon, so without this
 * a user who adds an app is told "config reloaded" — true, and beside the
 * point. It also covers the changes somebody else made: an agent running
 * `u8 up` in its worktree shows up here as the instance appearing.
 */
export function instanceChanges(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = [];
  const before = new Map(prev.instances.map((i) => [i.name, i]));
  const after = new Map(next.instances.map((i) => [i.name, i]));
  const bare = (ids: readonly TargetId[]): string => ids.map((id) => splitQualified(id).name).join(", ");

  for (const [name, now] of after) {
    const was = before.get(name);
    if (was === undefined) {
      out.push(`instance ${name} created`);
      continue;
    }
    if (now.isBase) continue;
    const gained = now.appIds.filter((id) => !was.appIds.includes(id));
    const lost = was.appIds.filter((id) => !now.appIds.includes(id));
    if (gained.length > 0) out.push(`${name} gained ${bare(gained)}`);
    if (lost.length > 0) out.push(`${name} lost ${bare(lost)}`);
    // Only when that is all that happened: a repo's entry leaves with its last
    // app whenever the app is pruned, and "lost api" has already said so —
    // whether the worktree itself went is the report's to say, not a notice's.
    const gaveUp = Object.keys(was.checkouts).filter((repo) => now.checkouts[repo] === undefined);
    if (gaveUp.length > 0 && lost.length === 0) out.push(`${name} gave up its checkout of ${bare(gaveUp)}`);
    // An add drops the flag for the length of its steps; that is the gain above.
    if (!was.initialized && now.initialized) out.push(`${name} is initialised`);
  }
  for (const name of before.keys()) if (!after.has(name)) out.push(`instance ${name} destroyed`);
  return out;
}

/** Whether some instance already runs from `dir` — an adopted worktree stops being unregistered. */
export function worktreeCovered(snapshot: Snapshot, dir: string): boolean {
  const within = (child: string): boolean => child === dir || child.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
  return snapshot.instances.some((i) => Object.values(i.checkouts).some((c) => within(c.path)));
}

// ---------------------------------------------------------------------------
// The detail view
// ---------------------------------------------------------------------------

export interface ExternalDependency {
  /** The app outside the instance, as the snapshot names it. */
  id: TargetId;
  status: string;
  /** The instance's own apps that depend on it. */
  neededBy: TargetId[];
}

/** What the instance's apps depend on outside it, and whether each is up. */
export function externalDependencies(snapshot: Snapshot, name: string): ExternalDependency[] {
  const apps = instanceApps(snapshot, name);
  const own = new Set(apps.map((a) => a.id));
  const status = new Map(snapshot.services.map((s) => [s.targetId, s.status]));
  const out = new Map<TargetId, ExternalDependency>();
  for (const app of apps) {
    for (const dep of app.dependsOn) {
      if (own.has(dep)) continue;
      const entry = out.get(dep) ?? { id: dep, status: status.get(dep) ?? "stopped", neededBy: [] };
      entry.neededBy.push(app.id);
      out.set(dep, entry);
    }
  }
  return [...out.values()];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/** `3 uncommitted` when the git plugin says the checkout is not clean; nothing when it is, or cannot say. */
function uncommitted(read: IndicatorReader, qualifiedRepo: string): string | undefined {
  const dirty = read("repo", qualifiedRepo, "git", "dirty");
  return dirty === undefined || dirty === "" || dirty === "0" ? undefined : `${dirty} uncommitted`;
}

export interface DetailInput {
  snapshot: Snapshot;
  instance: string;
  read: IndicatorReader;
  /** Epoch ms; injected so "created 2h ago" is testable. */
  now: number;
}

/**
 * What an instance is made of: each checkout and whose it is, each app and
 * where it listens, and what it borrows from base.
 *
 * Lines rather than a structure because that is all the view does with them —
 * scroll — and a line carries one tone, which is what makes "this checkout is
 * not yours to lose" or "this dependency is down" readable without a legend.
 */
export function detailLines(input: DetailInput): ToneLine[] {
  const { snapshot, read } = input;
  const instance = findInstance(snapshot, input.instance);
  if (!instance) return [{ text: `instance "${input.instance}" no longer exists`, tone: "warn" }];

  const lines: ToneLine[] = [];
  const apps = instanceApps(snapshot, instance.name);
  const services = new Map(snapshot.services.map((s) => [s.targetId, s]));
  const facts = [
    `${runningCount(snapshot, instance.appIds)}/${instance.appIds.length} running`,
    instance.initialized ? "initialised" : "not initialised — run init before starting it",
    ...(instance.isBase ? [] : [`created ${formatDuration(Math.max(0, input.now - instance.createdAt))} ago`]),
  ];
  lines.push({ text: `instance ${instance.name} · ${facts.join(" · ")}`, tone: instance.initialized ? "title" : "warn" });

  // --- checkouts ---
  // Two lines each: what it is, then where. A worktree's path is longer than
  // most terminals are wide, and sharing a line with it is how the part that
  // matters — whose it is — ends up wrapped out of sight.
  lines.push({ text: "", tone: "plain" }, { text: "checkouts", tone: "title" });
  const checkout = (name: string, width: number, notes: Array<string | undefined>, dir: string, tone: ToneLine["tone"]): void => {
    lines.push(
      { text: `  ${pad(name, width)}  ${notes.filter(isString).join(" · ")}`.trimEnd(), tone },
      { text: `  ${" ".repeat(width)}  ${dir}`, tone: "dim" },
    );
  };
  if (instance.isBase) {
    const repos = snapshot.repos.filter((r) => r.instance === BASE_INSTANCE);
    const width = widest(repos.map((r) => r.baseName));
    for (const repo of repos) {
      const branch = read("repo", repo.name, "git", "branch");
      checkout(
        repo.baseName,
        width,
        [
          branch === undefined || branch === "" ? undefined : `branch ${branch}`,
          "the path u8.jsonc declares — never created or removed by u8",
          uncommitted(read, repo.name),
        ],
        repo.path,
        "plain",
      );
    }
  } else {
    const inUse = new Set(snapshot.repos.filter((r) => r.apps.length > 0).map((r) => r.name));
    const entries = Object.entries(instance.checkouts);
    const width = widest(entries.map(([qualified]) => splitQualified(qualified).name));
    for (const [qualified, record] of entries) {
      const live = read("repo", qualified, "git", "branch");
      const branch = live !== undefined && live !== "" ? live : record.branch;
      const kept = !inUse.has(qualified);
      checkout(
        splitQualified(qualified).name,
        width,
        [
          branch === undefined ? undefined : `branch ${branch}`,
          record.owned
            ? `created by u8${record.createdBranch === true ? " (the branch too)" : ""}`
            : "adopted — u8 never removes it",
          kept ? "no apps (kept)" : undefined,
          uncommitted(read, qualified),
        ],
        record.path,
        kept ? "warn" : "plain",
      );
    }
    if (entries.length === 0) lines.push({ text: "  none", tone: "dim" });
  }

  // --- apps ---
  lines.push({ text: "", tone: "plain" }, { text: "apps", tone: "title" });
  const idWidth = widest(apps.map((a) => a.baseId));
  const states = apps.map((app) => {
    const service = services.get(app.id);
    return `${service?.status ?? "stopped"}${service?.stale === true ? " · stale" : ""}`;
  });
  const stateWidth = widest(states);
  apps.forEach((app, index) => {
    const state = states[index] ?? "stopped";
    const service = services.get(app.id);
    const urls = urlsOf(app.ports);
    const ports = Object.entries(app.ports).map(([port, number]) =>
      number > 0 ? `${port} ${number}  ${urls[port] ?? ""}` : `${port} unallocated`,
    );
    const [first, ...rest] = ports;
    const head = `  ${pad(app.baseId, idWidth)}  ${pad(state, stateWidth)}`;
    lines.push({
      text: `${head}  ${first ?? "no ports"}`.trimEnd(),
      tone: service?.status === "crashed" ? "error" : service?.stale === true ? "warn" : "plain",
    });
    for (const more of rest) lines.push({ text: `${" ".repeat(head.length)}  ${more}`, tone: "plain" });
  });
  if (apps.length === 0) lines.push({ text: "  none", tone: "dim" });

  // --- what it borrows ---
  if (!instance.isBase) {
    lines.push({ text: "", tone: "plain" }, { text: "uses from base", tone: "title" });
    const deps = externalDependencies(snapshot, instance.name);
    if (deps.length === 0) {
      lines.push({ text: "  nothing — every app it depends on is its own copy", tone: "dim" });
    }
    const depWidth = widest(deps.map((d) => explicitTarget(d.id)));
    for (const dep of deps) {
      const up = dep.status === "running";
      const neededBy = dep.neededBy.map((id) => splitQualified(id).name).join(", ");
      lines.push({
        text:
          `  ${pad(explicitTarget(dep.id), depWidth)}  ${up ? "running" : `${dep.status} — not running`}` +
          `  (needed by ${neededBy})${up ? "" : " — start it from its own section"}`,
        tone: up ? "plain" : "error",
      });
    }
  }
  return lines;
}

/**
 * What destroying an instance does, for the question asked before it.
 *
 * `destroy` is the one instance action that removes worktrees unasked, with
 * whatever is in them, so each one is named — and when the git plugin can see
 * uncommitted work in it, that is said in the same line.
 */
export function destroyLines(snapshot: Snapshot, name: string, read: IndicatorReader): ToneLine[] {
  const instance = findInstance(snapshot, name);
  if (!instance) return [];
  const lines: ToneLine[] = [];
  const running = runningCount(snapshot, instance.appIds);
  lines.push({
    text: `stops ${running} running app${running === 1 ? "" : "s"}, runs the teardown steps and frees its ports`,
    tone: "plain",
  });

  const worktrees = new Map<string, string[]>();
  const adopted: string[] = [];
  for (const [qualified, checkout] of Object.entries(instance.checkouts)) {
    if (!checkout.owned || checkout.worktree === undefined) {
      if (!adopted.includes(checkout.path)) adopted.push(checkout.path);
      continue;
    }
    const notes = worktrees.get(checkout.worktree) ?? [];
    const dirty = uncommitted(read, qualified);
    if (dirty !== undefined) notes.push(`${splitQualified(qualified).name}: ${dirty}`);
    worktrees.set(checkout.worktree, notes);
  }
  if (worktrees.size > 0) {
    lines.push({
      text: `removes ${worktrees.size} worktree${worktrees.size === 1 ? "" : "s"} u8 created, with whatever is uncommitted in ${worktrees.size === 1 ? "it" : "them"}:`,
      tone: "error",
    });
    for (const [dir, notes] of worktrees) {
      lines.push({ text: `  ${dir}${notes.length > 0 ? ` — ${notes.join(", ")}` : ""}`, tone: notes.length > 0 ? "error" : "plain" });
    }
  }
  if (adopted.length > 0) {
    lines.push({
      text: `forgets ${adopted.length} adopted checkout${adopted.length === 1 ? "" : "s"} — the director${adopted.length === 1 ? "y is" : "ies are"} not touched:`,
      tone: "plain",
    });
    for (const dir of adopted) lines.push({ text: `  ${dir}`, tone: "plain" });
  }
  return lines;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
