/**
 * The RPC surface of the daemon: one handler per method in {@link RpcMethods}.
 *
 * Handlers are deliberately thin — they validate, delegate to a collaborator,
 * and shape the reply. Anything with a lifetime (timers, subscriptions, the
 * shutdown sequence) belongs to `daemon.ts`; anything with domain logic belongs
 * to the supervisor, the engine or the registry. What is left here is exactly
 * the translation between the wire contract and those interfaces.
 *
 * Two conventions hold throughout:
 *  - **Params are untrusted.** The typed signatures describe what a well-behaved
 *    client sends; every handler still re-checks what it actually got and
 *    answers with a precise `U8Error` (the transport maps it to
 *    `APPLICATION_ERROR` carrying the `u8Code`).
 *  - **Long work never blocks a reply.** Starting services or running a command
 *    answers with a run id immediately; the client follows `task.progress` and
 *    settles with `run.await`.
 */
import {
  commandTargets,
  coreStartScript,
  findProfile,
  findSubapp,
  type NormalizedCommand,
  type NormalizedWorkspace,
  type TargetId,
} from "../config/index.js";
import { toTargetInfo } from "../engine/index.js";
import type { RpcHandlerMap } from "../ipc/index.js";
import {
  PROTOCOL_VERSION,
  type DaemonStatus,
  type LogLine,
  type Snapshot,
  type SnapshotApp,
  type SnapshotCommand,
  type SnapshotSubapp,
} from "../ipc/protocol.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { BoundCommand, DaemonContext, RunHandle } from "./contracts.js";

/** Backfill size when a client does not ask for one. */
export const DEFAULT_LOG_LINES = 200;

/** Upper bound on a single backfill: a log view scrolls, it does not slurp. */
export const MAX_LOG_LINES = 5_000;

export interface DaemonRuntimeStats {
  /** Connected clients, attached or not. */
  clients: number;
  runningServices: number;
  /** Milliseconds until the idle timer fires; `null` when it is not armed. */
  idleExitInMs: number | null;
}

export interface ReloadOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Everything the handlers need. The {@link DaemonContext} half is the frozen
 * contract; the rest is daemon-owned bookkeeping the handlers may read but
 * never drive themselves.
 */
export interface HandlerDeps extends DaemonContext {
  version: string;
  /** Epoch ms the daemon came up; `daemon.status` reports uptime from it. */
  startedAt: number;
  stats(): DaemonRuntimeStats;
  /** Formatted error of the last failed reload, while last-good config is in use. */
  configError(): string | undefined;
  reload(): Promise<ReloadOutcome>;
  /** Sets *and persists* the active profile before the RPC is answered. */
  saveProfile(name: string): Promise<void>;
  /** Registers an in-flight run so idle exit cannot fire underneath it. */
  track(handle: RunHandle): void;
  /** Schedules a graceful shutdown *after* the current response is written. */
  requestShutdown(reason: string): void;
  /** True from the moment shutdown begins; see {@link refuseWhileStopping}. */
  shuttingDown(): boolean;
}

export function createHandlers(deps: HandlerDeps): RpcHandlerMap {
  const ws = (): NormalizedWorkspace => deps.workspace.current();

  const launch = (handle: RunHandle): { runId: string } => {
    deps.track(handle);
    return { runId: handle.runId };
  };

  /**
   * Refuses anything that would spawn a process once the shutdown has begun.
   *
   * The stop pass works from the targets the supervisor knows about when it
   * starts, and the daemon is on its way out: a process started now is one no
   * daemon will ever own again. The next daemon reports the target `stopped`,
   * so the following `u8 start` runs a second copy of it — two writers on one
   * database, both invisible.
   *
   * Stopping and every read stay available: winding down is exactly what a
   * client should still be able to ask a shutting-down daemon for.
   */
  const refuseWhileStopping = (method: string): void => {
    if (!deps.shuttingDown()) return;
    throw new U8Error("RPC_ERROR", `the daemon is shutting down; "${method}" was refused`, { method });
  };

  return {
    "daemon.ping": () => ({
      pong: true as const,
      version: deps.version,
      protocolVersion: PROTOCOL_VERSION,
    }),

    "daemon.status": (): DaemonStatus => {
      const stats = deps.stats();
      return {
        version: deps.version,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - deps.startedAt,
        workspaceId: ws().id,
        configPath: ws().configPath,
        runningServices: stats.runningServices,
        clients: stats.clients,
        idleExitInMs: stats.idleExitInMs,
      };
    },

    "daemon.stop": (params) => {
      const force = readBoolean(params, "force") === true;
      deps.requestShutdown(force ? "daemon.stop (forced)" : "daemon.stop");
      return { ok: true as const };
    },

    /** The transport flips `conn.attached` once this resolves, enabling pushes. */
    "client.attach": (params, conn) => {
      const clientVersion = readString(params, "clientVersion") ?? "unknown";
      if (clientVersion !== deps.version) {
        deps.logger.debug(`client ${conn.id} attached with version ${clientVersion} (daemon ${deps.version})`);
      }
      return buildSnapshot(deps);
    },

    "workspace.snapshot": () => buildSnapshot(deps),

    "workspace.reload": () => deps.reload(),

    "profile.use": async (params) => {
      const name = readString(params, "name");
      if (name === undefined || name.length === 0) {
        throw new U8Error("UNKNOWN_PROFILE", 'profile.use requires a "name"');
      }
      if (!findProfile(ws(), name)) {
        throw new U8Error("UNKNOWN_PROFILE", `unknown profile "${name}"`, {
          profile: name,
          known: ws().profiles.map((p) => p.name),
        });
      }
      await deps.saveProfile(name);
      return { ok: true as const, activeProfile: name };
    },

    "service.start": (params) => {
      refuseWhileStopping("service.start");
      return launch(deps.engine.startTargets(readTargets(params)));
    },
    "service.stop": (params) => launch(deps.engine.stopTargets(readTargets(params))),
    "service.restart": (params) => {
      refuseWhileStopping("service.restart");
      return launch(deps.engine.restartTargets(readTargets(params)));
    },

    "command.run": (params) => {
      refuseWhileStopping("command.run");
      const command = readString(params, "command");
      if (command === undefined || command.length === 0) {
        throw new U8Error("UNKNOWN_COMMAND", 'command.run requires a "command"');
      }
      assertKnownCommand(deps, command);
      const concurrency = readNumber(params, "concurrency");
      return launch(
        deps.engine.runCommand({
          command,
          targets: readTargets(params),
          serial: readBoolean(params, "serial"),
          concurrency: concurrency !== undefined && concurrency > 0 ? Math.floor(concurrency) : undefined,
        }),
      );
    },

    "run.await": (params) => {
      const runId = readString(params, "runId");
      if (runId === undefined || runId.length === 0) {
        throw new U8Error("RPC_ERROR", 'run.await requires a "runId"');
      }
      return deps.engine.awaitRun(runId);
    },

    "logs.read": async (params) => {
      const targetId = requireTarget(deps, params);
      const lines = clampLines(readNumber(params, "lines"));
      const runId = readString(params, "runId");
      const out: LogLine[] =
        runId === undefined || runId.length === 0
          ? await deps.supervisor.readLog(targetId, lines)
          : await deps.engine.readRunLog(runId, targetId, lines);
      return { lines: out };
    },

    "logs.subscribe": (params, conn) => {
      conn.subscriptions.add(requireTarget(deps, params));
      return { ok: true as const };
    },

    "logs.unsubscribe": (params, conn) => {
      // Deliberately not validated against the workspace: unsubscribing from a
      // target the config just dropped must always be possible.
      const targetId = readString(params, "targetId");
      if (targetId !== undefined) conn.subscriptions.delete(targetId);
      return { ok: true as const };
    },

    "indicators.list": () => ({ indicators: deps.indicators.values() }),
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Everything a client needs to render, in one payload (SPEC §5.2). Built fresh
 * per call from the live collaborators — cheap, and never at risk of shipping a
 * stale view after a reload.
 */
export function buildSnapshot(deps: HandlerDeps): Snapshot {
  const ws = deps.workspace.current();
  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: deps.version,
    workspace: { id: ws.id, name: ws.name, rootDir: ws.rootDir, configPath: ws.configPath },
    templates: { ...ws.templates },
    apps: ws.apps.map(toSnapshotApp),
    profiles: ws.profiles.map((p) => ({
      name: p.name,
      isDefault: p.isDefault,
      subappIds: [...p.subappIds],
    })),
    activeProfile: deps.activeProfile(),
    commands: snapshotCommands(deps, ws),
    services: deps.supervisor.states(),
    indicators: deps.indicators.values(),
    plugins: deps.plugins.list(),
    configError: deps.configError(),
  };
}

function toSnapshotApp(app: NormalizedWorkspace["apps"][number]): SnapshotApp {
  return {
    name: app.name,
    path: app.path,
    template: app.template,
    subapps: app.subapps.map(
      (s): SnapshotSubapp => ({
        id: s.id,
        appName: s.appName,
        name: s.name,
        implicit: s.implicit,
        cwd: s.cwd,
        template: s.template,
        hasHealth: s.health !== undefined,
        dependsOn: [...s.dependsOn],
        scripts: Object.keys(s.scripts),
      }),
    ),
  };
}

function snapshotCommands(deps: HandlerDeps, ws: NormalizedWorkspace): SnapshotCommand[] {
  const ids = ws.subapps.map((s) => s.id);
  const configured = ws.commands.map(
    (cmd): SnapshotCommand => ({
      name: cmd.name,
      kind: cmd.kind,
      source: cmd.source,
      description: cmd.description,
      appliesTo: appliesTo(ws, cmd, ids),
    }),
  );
  // Plugin commands never enter the normalized config, so the two lists are
  // merged here — the palette shows one set of commands, whatever declared them.
  const contributed = deps.plugins.commands().map(
    (bound): SnapshotCommand => ({
      name: bound.name,
      kind: bound.def.kind ?? "task",
      source: "plugin",
      description: bound.def.description,
      appliesTo: ws.subapps.filter((s) => pluginApplies(deps, bound, s)).map((s) => s.id),
    }),
  );
  return [...configured, ...contributed];
}

/**
 * Which targets a command actually resolves work for.
 *
 * The core commands bypass {@link commandTargets} for the same reason the
 * supervisor does: a `null` entry there means "no custom script", not "skip".
 * Starting needs a `start` script, while stopping falls back to signalling the
 * process group and therefore applies to every target.
 */
function appliesTo(ws: NormalizedWorkspace, cmd: NormalizedCommand, ids: readonly TargetId[]): TargetId[] {
  if (cmd.name === "app:start" || cmd.name === "app:restart") {
    return ids.filter((id) => coreStartScript(ws, id) !== null);
  }
  if (cmd.name === "app:stop") return [...ids];
  return commandTargets(ws, cmd, ids).map((t) => t.targetId);
}

function pluginApplies(deps: HandlerDeps, bound: BoundCommand, subapp: NormalizedWorkspace["subapps"][number]): boolean {
  if (!bound.def.appliesTo) return true;
  try {
    return bound.def.appliesTo(toTargetInfo(subapp)) !== false;
  } catch (err) {
    deps.logger.warn(`appliesTo of "${bound.name}" threw for ${subapp.id}: ${errorMessage(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function asRecord(params: unknown): Record<string, unknown> | undefined {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : undefined;
}

function readString(params: unknown, field: string): string | undefined {
  const value = asRecord(params)?.[field];
  return typeof value === "string" ? value : undefined;
}

function readNumber(params: unknown, field: string): number | undefined {
  const value = asRecord(params)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(params: unknown, field: string): boolean | undefined {
  const value = asRecord(params)?.[field];
  return typeof value === "boolean" ? value : undefined;
}

/** `undefined` (or an empty list) means "the active profile", per the protocol. */
function readTargets(params: unknown): string[] | undefined {
  const value = asRecord(params)?.["targets"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new U8Error("UNKNOWN_TARGET", '"targets" must be an array of target strings');
  }
  return value.length === 0 ? undefined : (value as string[]);
}

/**
 * A target id the daemon can serve. Targets the config dropped are still
 * accepted while the supervisor tracks them, so a client can read the logs of
 * something that just disappeared from `u8.jsonc`.
 */
function requireTarget(deps: HandlerDeps, params: unknown): TargetId {
  const targetId = readString(params, "targetId");
  if (targetId === undefined || targetId.length === 0) {
    throw new U8Error("UNKNOWN_TARGET", 'a "targetId" is required');
  }
  if (findSubapp(deps.workspace.current(), targetId)) return targetId;
  if (deps.supervisor.states().some((s) => s.targetId === targetId)) return targetId;
  throw new U8Error("UNKNOWN_TARGET", `unknown target "${targetId}"`, { target: targetId });
}

function assertKnownCommand(deps: HandlerDeps, command: string): void {
  const ws = deps.workspace.current();
  if (ws.commands.some((c) => c.name === command)) return;
  if (deps.plugins.commands().some((c) => c.name === command)) return;
  throw new U8Error("UNKNOWN_COMMAND", `unknown command "${command}"`, {
    command,
    known: ws.commands.map((c) => c.name),
  });
}

function clampLines(lines: number | undefined): number {
  if (lines === undefined) return DEFAULT_LOG_LINES;
  return Math.max(0, Math.min(Math.floor(lines), MAX_LOG_LINES));
}
