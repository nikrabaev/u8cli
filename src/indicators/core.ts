/**
 * The `app@` and `repo@` namespaces — the only indicators every workspace has.
 *
 * One namespace per scope: an app row is written with `{app@name}` /
 * `{app@status}` and the repo header row with `{repo@name}` / `{repo@status}`,
 * so a token says which level it reads instead of leaving the row to decide.
 * They read injected state and never shell out, because `refresh()` re-runs
 * them on every service transition.
 */
import path from "node:path";
import { REPO_NAMESPACE } from "../config/types.js";
import type { IndicatorRegistration } from "../daemon/contracts.js";
import type { IndicatorTone, ServiceState, ServiceStatus } from "../ipc/protocol.js";
import type { IndicatorContext, IndicatorResult } from "../plugin/types.js";
import type { CoreIndicatorDeps } from "./types.js";

export const CORE_NAMESPACE = "app";

/** Status is rendered as a dot; the raw value stays machine-readable for `--json`. */
export const STATUS_GLYPH = "●";

/** How often uptime is recomputed. One shared 5 s poll, not a 1 s timer per target. */
export const UPTIME_POLL_MS = 5_000;

/**
 * SPEC §3's user-facing status enum. `stale` is not a lifecycle state — a stale
 * process is a *running* one whose spawn-time definition no longer matches the
 * config — so the two are collapsed here and nowhere else.
 */
export type CoreStatus = ServiceStatus | "stale";

const STATUS_TONES: Record<CoreStatus, IndicatorTone> = {
  running: "ok",
  starting: "info",
  stopped: "muted",
  crashed: "error",
  stopping: "warn",
  stale: "warn",
};

/** Statuses during which a pid exists and an exit code does not. */
const LIVE: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>(["starting", "running", "stopping"]);

export function statusResult(status: CoreStatus): IndicatorResult {
  return { value: status, display: STATUS_GLYPH, tone: STATUS_TONES[status] };
}

export function appStatus(state: ServiceState | undefined): CoreStatus {
  if (!state) return "stopped";
  return state.status === "running" && state.stale ? "stale" : state.status;
}

/**
 * A repo is as bad as its worst app: one crash colours the whole header row
 * red, and "running" is reserved for the case where the entire repo is up.
 */
export function aggregateStatus(states: readonly ServiceState[]): CoreStatus {
  if (states.length === 0) return "stopped";
  if (states.some((s) => s.status === "crashed")) return "crashed";
  if (states.every((s) => s.status === "running")) return "running";
  if (states.some((s) => s.status === "starting" || s.status === "stopping")) return "starting";
  return "stopped";
}

/** `12s`, `4m`, `1h3m`, `2d5h` — always two significant units at most. */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * Builds every core registration.
 *
 * `status`, `pid` and `exitcode` declare `event` mode: SPEC §2.7's event mode is
 * "pushed by the engine", and the engine pushes by calling
 * {@link IndicatorRegistry.refresh} after a supervisor transition. Only `uptime`
 * needs a clock of its own.
 */
export function coreIndicators(deps: CoreIndicatorDeps): IndicatorRegistration[] {
  const appState = (ctx: IndicatorContext): ServiceState | undefined =>
    ctx.service ?? (ctx.target ? deps.services.state(ctx.target.id) : undefined);

  return [
    // --- app scope: the child row ---------------------------------------
    reg("name", {
      scope: "app",
      description: "App name",
      update: { mode: "static" },
      value: (ctx) => ctx.target?.name ?? "",
    }),
    reg("dirname", {
      scope: "app",
      description: "Basename of the app's working directory",
      update: { mode: "static" },
      value: (ctx) => path.basename(ctx.cwd),
    }),
    reg("path", {
      scope: "app",
      description: "Absolute working directory",
      update: { mode: "static" },
      value: (ctx) => ctx.cwd,
    }),
    reg("status", {
      scope: "app",
      description: "Service lifecycle state",
      update: { mode: "event" },
      value: (ctx) => statusResult(appStatus(appState(ctx))),
    }),
    reg("pid", {
      scope: "app",
      description: "Process id while the service is up",
      update: { mode: "event" },
      value: (ctx) => pidValue(appState(ctx)),
    }),
    reg("uptime", {
      scope: "app",
      description: "Time since the current run started",
      update: { mode: "poll", intervalMs: UPTIME_POLL_MS },
      value: (ctx) => uptimeValue(appState(ctx)),
    }),
    reg("exitcode", {
      scope: "app",
      description: "Exit code of the last finished run",
      update: { mode: "event" },
      value: (ctx) => exitCodeValue(appState(ctx)),
    }),

    // --- repo scope: the header row -----------------------------------------
    repoReg("name", {
      scope: "repo",
      description: "Repo name",
      update: { mode: "static" },
      value: (ctx) => ctx.repo.name,
    }),
    repoReg("dirname", {
      scope: "repo",
      description: "Basename of the repo root",
      update: { mode: "static" },
      value: (ctx) => path.basename(ctx.repo.path),
    }),
    repoReg("path", {
      scope: "repo",
      description: "Absolute repo root",
      update: { mode: "static" },
      value: (ctx) => ctx.repo.path,
    }),
    repoReg("status", {
      scope: "repo",
      description: "Aggregate state of the repo's apps",
      update: { mode: "event" },
      value: (ctx) => statusResult(aggregateStatus(repoStates(deps, ctx.repo.name))),
    }),
  ];
}

function reg(name: string, def: IndicatorRegistration["def"]): IndicatorRegistration {
  return { ns: CORE_NAMESPACE, name, def };
}

function repoReg(name: string, def: IndicatorRegistration["def"]): IndicatorRegistration {
  return { ns: REPO_NAMESPACE, name, def };
}

function repoStates(deps: CoreIndicatorDeps, repoName: string): ServiceState[] {
  const repo = deps.workspace.current().repos.find((r) => r.name === repoName);
  if (!repo) return [];
  const out: ServiceState[] = [];
  for (const app of repo.apps) {
    const state = deps.services.state(app.id);
    // A supervisor that has not seen this target yet is "not running", not a crash.
    if (state) out.push(state);
  }
  return out;
}

function pidValue(state: ServiceState | undefined): string {
  if (!state || state.pid === undefined || !LIVE.has(state.status)) return "";
  return String(state.pid);
}

function uptimeValue(state: ServiceState | undefined): string {
  if (!state || state.status !== "running" || state.startedAt === undefined) return "";
  return formatUptime(Date.now() - state.startedAt);
}

function exitCodeValue(state: ServiceState | undefined): string {
  if (!state || LIVE.has(state.status)) return "";
  return typeof state.exitCode === "number" ? String(state.exitCode) : "";
}
