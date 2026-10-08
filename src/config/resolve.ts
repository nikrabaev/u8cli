/**
 * Pure lookups over a {@link NormalizedWorkspace}.
 *
 * Everything the engine, CLI and TUI need to turn user input ("start platform",
 * "run test on the active profile") into a concrete list of apps and scripts
 * lives here, so target semantics are defined exactly once and testable without
 * a daemon.
 */
import { U8Error } from "../util/errors.js";
import {
  BASE_INSTANCE,
  findApp,
  findCommand,
  findInstance,
  findProfile,
  INSTANCE_SEPARATOR,
  LIFECYCLE_COMMANDS,
  type NormalizedCommand,
  type NormalizedWorkspace,
  qualify,
  splitQualified,
  type TargetId,
} from "./types.js";

/**
 * The fully qualified form of a target string typed from inside `instance`.
 *
 * A bare name means "mine": `api` typed in `feat-x` is `api@feat-x`. A name that
 * carries its own `@instance` is taken at its word, which is the only way to
 * reach across — and `@base` is spelled out for that purpose, since base ids
 * are otherwise the bare ones.
 */
export function qualifyTarget(spec: string, instance: string = BASE_INSTANCE): string {
  if (!spec.includes(INSTANCE_SEPARATOR)) return qualify(spec, instance);
  const split = splitQualified(spec);
  return qualify(split.name, split.instance);
}

/**
 * App ids a single target string covers, or `undefined` when it matches nothing.
 *
 * Never falls back from an instance to base: `u8 restart api` typed in a
 * worktree that has no api of its own must not restart the one everybody else
 * is using. Reaching base takes `api@base`.
 */
export function expandTarget(
  ws: NormalizedWorkspace,
  spec: string,
  instance: string = BASE_INSTANCE,
): TargetId[] | undefined {
  const wanted = qualifyTarget(spec, instance);
  if (ws.apps.some((a) => a.id === wanted)) return [wanted];
  const repo = ws.repos.find((r) => r.name === wanted);
  return repo?.apps.map((a) => a.id);
}

/**
 * Why a target string matched nothing, in terms of the instance it was typed in.
 * The interesting case is a name that exists — just not here.
 */
export function unknownTargetMessage(ws: NormalizedWorkspace, spec: string, instance: string = BASE_INSTANCE): string {
  if (instance !== BASE_INSTANCE && !spec.includes(INSTANCE_SEPARATOR) && expandTarget(ws, spec, BASE_INSTANCE)) {
    return (
      `"${spec}" is not part of instance "${instance}", which uses base's — ` +
      `name it as "${spec}${INSTANCE_SEPARATOR}${BASE_INSTANCE}" to act on that one`
    );
  }
  const { instance: named } = splitQualified(qualifyTarget(spec, instance));
  if (!findInstance(ws, named)) {
    return `unknown instance "${named}" in target "${spec}" — known: ${ws.instances.map((i) => i.name).join(", ")}`;
  }
  return `unknown target "${spec}" — expected a repo name or "repo.app"`;
}

/**
 * Target strings → app ids: repo names expand to all their apps, duplicates
 * collapse, and the order the user (or the config) wrote them in is preserved.
 */
export function resolveTargetStrings(
  ws: NormalizedWorkspace,
  specs: readonly string[],
  instance: string = BASE_INSTANCE,
): TargetId[] {
  const out: TargetId[] = [];
  for (const spec of specs) {
    const ids = expandTarget(ws, spec, instance);
    if (!ids) {
      throw new U8Error("UNKNOWN_TARGET", unknownTargetMessage(ws, spec, instance), { spec, instance });
    }
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Every app an instance runs — what an untargeted command means outside base. */
export function instanceTargets(ws: NormalizedWorkspace, name: string): TargetId[] {
  const instance = findInstance(ws, name);
  if (!instance) {
    throw new U8Error("UNKNOWN_INSTANCE", `unknown instance "${name}"`, {
      instance: name,
      known: ws.instances.map((i) => i.name),
    });
  }
  return [...instance.appIds];
}

/** App ids of a profile; defaults to the workspace's default profile. */
export function profileTargets(ws: NormalizedWorkspace, name?: string): TargetId[] {
  const wanted = name ?? ws.defaultProfile;
  const profile = findProfile(ws, wanted);
  if (!profile) {
    throw new U8Error("UNKNOWN_PROFILE", `unknown profile "${wanted}"`, {
      profile: wanted,
      known: ws.profiles.map((p) => p.name),
    });
  }
  return [...profile.appIds];
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
 * Load diagnostics for the entries of the top-level `hooks` map that name no
 * command, as `path: message` lines like {@link NormalizedWorkspace.warnings}.
 *
 * `pluginCommands` is what the loaded plugins contribute, which is why this is
 * asked by the daemon and not answered at normalization: a plugin's commands
 * exist only once it has loaded. A miss is a warning rather than an error for
 * the same reason — a plugin that failed to load is disabled and reported, and
 * must not also turn the hooks written for it into an invalid config.
 */
export function unboundHookWarnings(ws: NormalizedWorkspace, pluginCommands: readonly string[]): string[] {
  const runs = [...LIFECYCLE_COMMANDS, ...pluginCommands];
  const known = new Set<string>([...ws.commands.map((c) => c.name), ...runs]);
  const out: string[] = [];
  for (const name of Object.keys(ws.hooks)) {
    if (known.has(name)) continue;
    const ns = name.slice(0, name.indexOf(":"));
    const siblings = runs.filter((candidate) => candidate.startsWith(`${ns}:`));
    const why =
      siblings.length > 0
        ? `"${ns}" has no command by that name — expected one of: ${siblings.join(", ")}`
        : `no loaded plugin is called "${ns}"`;
    out.push(`hooks.${name}: no command "${name}" is loaded, so these hooks never run (${why})`);
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
  return findApp(ws, id)?.scripts["start"] ?? null;
}

/** `null` means "no custom stop script": terminate the process group instead. */
export function coreStopScript(ws: NormalizedWorkspace, id: TargetId): string | null {
  return findApp(ws, id)?.scripts["stop"] ?? null;
}

/** Direct dependencies of an app, already expanded to concrete ids. */
export function dependenciesOf(ws: NormalizedWorkspace, id: TargetId): TargetId[] {
  const app = findApp(ws, id);
  if (!app) throw new U8Error("UNKNOWN_TARGET", `unknown target "${id}"`, { target: id });
  return [...app.dependsOn];
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
    if (!findApp(ws, id)) throw new U8Error("UNKNOWN_TARGET", `unknown target "${id}"`, { target: id });
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
