/**
 * What there is to say about an instance, worked out once.
 *
 * `u8 instance …` prints these things and the dashboard draws them, and the
 * two must not drift: "which apps went stale", "what became of the checkout"
 * and "what it leans on in base" are facts about two snapshots, not about a
 * front end. So the facts and the sentences live here, as plain functions of
 * {@link Snapshot} with no colour and no stream in them; each front end adds
 * only what is its own — where the line goes, and how its user restarts an app.
 *
 * Nothing in this file may import a front end, the daemon launcher or anything
 * with a lifetime: the dashboard loads it on its hot path.
 */
import path from "node:path";

import { BASE_INSTANCE, INSTANCE_SEPARATOR, splitQualified, type TargetId } from "../config/types.js";
import type { LogLine, Snapshot, TaskResult } from "../ipc/protocol.js";

/** Lines of a failing target's log shown without being asked. */
export const FAILURE_TAIL_LINES = 30;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export function urlsOf(ports: Record<string, number>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ports)
      .filter(([, port]) => port > 0)
      .map(([name, port]) => [name, `http://localhost:${port}`]),
  );
}

export interface Address {
  id: TargetId;
  /** The port's name in the config: `http`. */
  port: string;
  url: string;
}

/** The addresses of an instance's apps — all of them, or just the ones in `only`. */
export function addressesOf(snapshot: Snapshot, instanceName: string, only?: readonly string[]): Address[] {
  const instance = snapshot.instances.find((i) => i.name === instanceName);
  if (!instance) return [];
  const own = new Set(only === undefined ? instance.appIds : instance.appIds.filter((id) => only.includes(id)));
  return snapshot.repos
    .flatMap((r) => r.apps)
    .filter((a) => own.has(a.id))
    .flatMap((a) => Object.entries(urlsOf(a.ports)).map(([port, url]) => ({ id: a.id, port, url })));
}

/**
 * A target with its instance spelled out, base included: `api@base`. Not an id
 * — the way to name base's copy from inside an instance, where a bare name
 * means the instance's own.
 */
export function explicitTarget(id: TargetId): string {
  const { name, instance } = splitQualified(id);
  return `${name}${INSTANCE_SEPARATOR}${instance}`;
}

/** `api platform.shell`, the way they would be typed: ids as the config spells them. */
export function typed(snapshot: Snapshot, ids: readonly string[]): string {
  const apps = new Map(snapshot.repos.flatMap((r) => r.apps).map((a) => [a.id, a.baseId]));
  return ids.map((id) => apps.get(id) ?? splitQualified(id).name).join(" ");
}

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

/**
 * The running apps a membership change left on their old wiring.
 *
 * What an app points at — a dependency, another app's port in its `env` — is
 * decided by who else is in the instance, so adding or removing one rewires
 * the rest. Running processes are never touched; they go `stale`. Only the
 * ones that were not stale already are named: those are this change's doing.
 */
export function rewiredApps(before: Snapshot, after: Snapshot, instanceName: string): TargetId[] {
  const own = new Set(after.instances.find((i) => i.name === instanceName)?.appIds ?? []);
  const already = new Set(before.services.filter((s) => s.stale).map((s) => s.targetId));
  return after.services
    .filter((s) => s.stale && own.has(s.targetId) && !already.has(s.targetId))
    .map((s) => s.targetId);
}

/** The line that says a restart is what makes the change real. `restart` is the front end's way to do it. */
export function rewiredMessage(stale: readonly TargetId[], restart: string): string {
  const one = stale.length === 1;
  return (
    `${stale.join(", ")} ${one ? "is" : "are"} now stale: ${one ? "it is" : "they are"} still running with what ` +
    `${one ? "it" : "they"} pointed at before this change — restart to pick it up: ${restart}`
  );
}

/** Dependencies of an instance's apps that live outside it and are not running. */
export function externalDependenciesDown(snapshot: Snapshot, instanceName: string): string[] {
  const instance = snapshot.instances.find((i) => i.name === instanceName);
  if (!instance || instance.isBase) return [];
  const own = new Set(instance.appIds);
  const running = new Set(snapshot.services.filter((s) => s.status === "running").map((s) => s.targetId));
  const out: string[] = [];
  for (const app of snapshot.repos.flatMap((r) => r.apps)) {
    if (!own.has(app.id)) continue;
    for (const dep of app.dependsOn) {
      if (!own.has(dep) && !running.has(dep) && !out.includes(dep)) out.push(dep);
    }
  }
  return out;
}

/**
 * Says which of base's apps an instance leans on are not up.
 *
 * A partial instance is wired to base for everything it has no copy of, and
 * starting it never starts base — that would be one task reaching into
 * everybody's stack. So when what it depends on is down, the start succeeds and
 * the app then fails its first request; this is the line that explains why.
 * `start` is the front end's way to bring them up.
 */
export function baseDependencyMessage(instanceName: string, down: readonly string[], start: string): string {
  return (
    `instance "${instanceName}" uses ${down.join(", ")} from another instance, and ` +
    `${down.length === 1 ? "it is" : "they are"} not running — ${start}`
  );
}

// ---------------------------------------------------------------------------
// Checkouts
// ---------------------------------------------------------------------------

export interface CheckoutOutcome {
  /**
   * `kept`: still the instance's, with no apps. `forgotten`: an adopted one,
   * dropped from the record and untouched on disk. `shared`: asked to go, but
   * other apps still run from the same worktree. `removed`: the worktree is gone.
   */
  kind: "kept" | "forgotten" | "shared" | "removed";
  /** The repo as the config names it. */
  repo: string;
  /** The directory the sentence is about. */
  path: string;
  text: string;
  /** A parenthetical a front end may set apart. */
  note?: string;
}

/**
 * What became of the checkouts a removal left without apps. Kept is the
 * default and easy to miss — the directory is still there, still the
 * instance's — so it is said. One worktree can be several repos' checkout, and
 * is reported once.
 */
export function checkoutOutcomes(before: Snapshot, after: Snapshot, instanceName: string): CheckoutOutcome[] {
  const was = before.instances.find((i) => i.name === instanceName);
  const now = after.instances.find((i) => i.name === instanceName);
  if (!was || !now) return [];
  const inUse = (snapshot: Snapshot, repo: string): boolean =>
    snapshot.repos.some((r) => r.name === repo && r.apps.length > 0);
  const stillHeld = new Set(Object.values(now.checkouts).map((c) => c.worktree));

  const out: CheckoutOutcome[] = [];
  const say = (outcome: CheckoutOutcome): void => {
    if (!out.some((o) => o.text === outcome.text)) out.push(outcome);
  };
  for (const [qualified, checkout] of Object.entries(was.checkouts)) {
    const repo = splitQualified(qualified).name;
    if (now.checkouts[qualified] !== undefined) {
      if (!inUse(before, qualified) || inUse(after, qualified)) continue;
      say({ kind: "kept", repo, path: checkout.path, text: `kept the checkout of ${repo} at ${checkout.path}` });
    } else if (!checkout.owned) {
      say({
        kind: "forgotten",
        repo,
        path: checkout.path,
        text: `forgot the checkout at ${checkout.path}`,
        note: "(adopted — the directory was not touched)",
      });
    } else if (checkout.worktree !== undefined && stillHeld.has(checkout.worktree)) {
      say({
        kind: "shared",
        repo,
        path: checkout.worktree,
        text: `the worktree at ${checkout.worktree} stays: the instance's other apps still run from it`,
      });
    } else {
      const dir = checkout.worktree ?? checkout.path;
      say({ kind: "removed", repo, path: dir, text: `removed the worktree at ${dir}` });
    }
  }
  return out;
}

/**
 * What became of an instance's checkouts when it was destroyed: the same two
 * sentences a removal uses, since the same two things happen to them.
 */
export function destroyedCheckouts(before: Snapshot, instanceName: string): CheckoutOutcome[] {
  const was = before.instances.find((i) => i.name === instanceName);
  if (!was) return [];
  const out: CheckoutOutcome[] = [];
  for (const [qualified, checkout] of Object.entries(was.checkouts)) {
    const repo = splitQualified(qualified).name;
    const outcome: CheckoutOutcome =
      checkout.owned && checkout.worktree !== undefined
        ? { kind: "removed", repo, path: checkout.worktree, text: `removed the worktree at ${checkout.worktree}` }
        : {
            kind: "forgotten",
            repo,
            path: checkout.path,
            text: `forgot the checkout at ${checkout.path}`,
            note: "(adopted — the directory was not touched)",
          };
    if (!out.some((o) => o.text === outcome.text)) out.push(outcome);
  }
  return out;
}

/**
 * A name for a worktree nobody named: its directory, made to fit. Suffixed
 * when that is taken, because two tools can both call their worktree `fix`.
 */
export function nameForWorktree(dir: string, snapshot: Snapshot): string {
  const cleaned = path
    .basename(dir)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  const stem = cleaned.length === 0 || cleaned === BASE_INSTANCE ? "worktree" : cleaned;
  const taken = new Set(snapshot.instances.map((i) => i.name));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export interface FailureTail {
  targetId: TargetId;
  lines: string[];
}

/** `── api@feat-x: last 12 lines ──` */
export function failureTailTitle(tail: FailureTail): string {
  return `── ${tail.targetId}: last ${tail.lines.length} line${tail.lines.length === 1 ? "" : "s"} ──`;
}

/**
 * The end of each failed target's output.
 *
 * A start that fails leaves its reason in the service log, an init step in the
 * run log; which one is asked for is decided by the command, the same way the
 * `u8 logs` hint is. Both are tried for a service run, since a target can fail
 * before its process ever existed. `read` is `logs.read` on whatever connection
 * the caller has; a log that cannot be read is skipped, never an error.
 */
export async function readFailureTails(
  read: (params: { targetId: TargetId; lines: number; runId?: string }) => Promise<{ lines: LogLine[] }>,
  result: TaskResult,
): Promise<FailureTail[]> {
  const service = result.command.startsWith("app:");
  const out: FailureTail[] = [];
  for (const target of result.targets) {
    if (target.state !== "failed" && target.state !== "aborted") continue;
    const tail = async (runId: string | undefined): Promise<string[]> => {
      try {
        const { lines } = await read({ targetId: target.targetId, lines: FAILURE_TAIL_LINES, runId });
        return lines.map((l) => l.text);
      } catch {
        return [];
      }
    };
    let lines = await tail(service ? undefined : result.runId);
    if (lines.length === 0 && service) lines = await tail(result.runId);
    if (lines.length > 0) out.push({ targetId: target.targetId, lines });
  }
  return out;
}
