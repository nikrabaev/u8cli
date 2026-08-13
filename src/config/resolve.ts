/**
 * Pure lookups over a {@link NormalizedWorkspace}.
 *
 * Everything the engine, CLI and TUI need to turn user input ("start platform",
 * "run test on the active profile") into a concrete list of subapps and scripts
 * lives here, so target semantics are defined exactly once and testable without
 * a daemon.
 */
import { U8Error } from "../util/errors.js";
import {
  findCommand,
  findProfile,
  findSubapp,
  type NormalizedCommand,
  type NormalizedWorkspace,
  type TargetId,
} from "./types.js";

/** Subapp ids a single target string covers, or `undefined` when it matches nothing. */
export function expandTarget(ws: NormalizedWorkspace, spec: string): TargetId[] | undefined {
  if (ws.subapps.some((s) => s.id === spec)) return [spec];
  const app = ws.apps.find((a) => a.name === spec);
  return app?.subapps.map((s) => s.id);
}

/**
 * Target strings → subapp ids: app names expand to all their subapps, duplicates
 * collapse, and the order the user (or the config) wrote them in is preserved.
 */
export function resolveTargetStrings(ws: NormalizedWorkspace, specs: readonly string[]): TargetId[] {
  const out: TargetId[] = [];
  for (const spec of specs) {
    const ids = expandTarget(ws, spec);
    if (!ids) {
      throw new U8Error("UNKNOWN_TARGET", `unknown target "${spec}" — expected an app name or "app.subapp"`, {
        spec,
      });
    }
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Subapp ids of a profile; defaults to the workspace's default profile. */
export function profileTargets(ws: NormalizedWorkspace, name?: string): TargetId[] {
  const wanted = name ?? ws.defaultProfile;
  const profile = findProfile(ws, wanted);
  if (!profile) {
    throw new U8Error("UNKNOWN_PROFILE", `unknown profile "${wanted}"`, {
      profile: wanted,
      known: ws.profiles.map((p) => p.name),
    });
  }
  return [...profile.subappIds];
}

export interface CommandTarget {
  targetId: TargetId;
  /** The script to run in this target's cwd. */
  script: string;
}

/**
 * Applies the many-to-one script rules: a per-target entry wins over the shared
 * `script`, an explicit `null` skips the target, and a target with neither an
 * entry nor a shared script is skipped too.
 *
 * Not for `app:stop`: a null there means "signal the process group", not "skip",
 * so the supervisor must read {@link NormalizedCommand.targetScripts} directly.
 */
export function commandTargets(
  ws: NormalizedWorkspace,
  command: NormalizedCommand | string,
  ids: readonly TargetId[],
): CommandTarget[] {
  const cmd = typeof command === "string" ? findCommand(ws, command) : command;
  if (!cmd) {
    throw new U8Error("UNKNOWN_COMMAND", `unknown command "${String(command)}"`, { command });
  }

  const out: CommandTarget[] = [];
  const seen = new Set<TargetId>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const override = Object.prototype.hasOwnProperty.call(cmd.targetScripts, id)
      ? cmd.targetScripts[id]
      : undefined;
    if (override === null) continue;
    const script = override ?? cmd.script;
    if (script === undefined) continue;
    out.push({ targetId: id, script });
  }
  return out;
}

/**
 * Start/stop scripts for the core `app:*` commands.
 *
 * These deliberately bypass {@link commandTargets}, whose `null` means "skip".
 * For `app:stop`, `null` means "no custom stop script — signal the process
 * group", and routing it through the generic resolver would silently stop
 * nothing. Callers in the supervisor must use these accessors.
 */
export function coreStartScript(ws: NormalizedWorkspace, id: TargetId): string | null {
  return findSubapp(ws, id)?.scripts["start"] ?? null;
}

/** `null` means "no custom stop script": terminate the process group instead. */
export function coreStopScript(ws: NormalizedWorkspace, id: TargetId): string | null {
  return findSubapp(ws, id)?.scripts["stop"] ?? null;
}

/** Direct dependencies of a subapp, already expanded to concrete ids. */
export function dependenciesOf(ws: NormalizedWorkspace, id: TargetId): TargetId[] {
  const subapp = findSubapp(ws, id);
  if (!subapp) throw new U8Error("UNKNOWN_TARGET", `unknown target "${id}"`, { target: id });
  return [...subapp.dependsOn];
}

/**
 * Startup ordering: every id in a wave may launch in parallel once the previous
 * wave is ready. Dependencies outside `ids` are ignored — starting a subset must
 * not implicitly drag in targets the user did not select.
 */
export function topoWaves(ws: NormalizedWorkspace, ids: readonly TargetId[]): TargetId[][] {
  const order: TargetId[] = [];
  const selected = new Set<TargetId>();
  for (const id of ids) {
    if (selected.has(id)) continue;
    if (!findSubapp(ws, id)) throw new U8Error("UNKNOWN_TARGET", `unknown target "${id}"`, { target: id });
    selected.add(id);
    order.push(id);
  }

  const pending = new Map<TargetId, TargetId[]>(
    order.map((id) => [id, dependenciesOf(ws, id).filter((d) => d !== id && selected.has(d))]),
  );

  const waves: TargetId[][] = [];
  const done = new Set<TargetId>();
  while (done.size < order.length) {
    const wave = order.filter(
      (id) => !done.has(id) && (pending.get(id) ?? []).every((d) => done.has(d)),
    );
    if (wave.length === 0) {
      // Unreachable for a normalized workspace: cycles are rejected at load.
      const stuck = order.filter((id) => !done.has(id));
      throw new U8Error("INTERNAL", `dependency cycle among targets: ${stuck.join(", ")}`);
    }
    for (const id of wave) done.add(id);
    waves.push(wave);
  }
  return waves;
}
