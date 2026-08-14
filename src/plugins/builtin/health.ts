/**
 * The built-in `health` plugin — SPEC §7.2, PLAN 9.3.
 *
 * One probe loop per subapp that declares a `health` check: it publishes the
 * verdict as `{health@status}` and answers the readiness question `dependsOn`
 * gating asks (SPEC §5.4).
 *
 * Four decisions shape the file:
 *
 *  - **A stopped process is never probed.** A probe against a service nobody
 *    started is a connection refused every five seconds, forever, plus a red row
 *    that says nothing. Such a target reads `n/a` and the loop idles.
 *  - **One probe at a time per target.** A hung probe must not stack up behind
 *    itself, so both probe kinds are bounded (`timeoutMs`, plus a kill grace well
 *    inside the interval for `cmd`) and a monitor refuses to start a second one.
 *  - **A single blip is not a failure.** `threshold` *consecutive* failures flip
 *    a target to `unhealthy`; one success resets the count immediately. That is
 *    the difference between a dashboard worth watching and a blinking one.
 *  - **Every socket, child and timer has an owner.** The indicator's disposer
 *    stops the loop and aborts whatever is in flight, and the HTTP probe destroys
 *    its request on every exit path — a leaked keep-alive socket per probe per
 *    interval is a file-descriptor leak that only shows up after a day of uptime.
 *
 * ## Where lifecycle state comes from
 *
 * The plugin API has no "service changed" event, and `IndicatorContext.service`
 * is captured once for a `subscribe`-mode provider (the registry re-builds the
 * context per *evaluation*, and a subscription is only activated once). So the
 * monitors take lifecycle edges from every source the SDK does offer — the
 * subscribe-time snapshot, every `readiness()` call, and the `app:start` /
 * `app:restart` / `app:stop` hooks — and from {@link HealthPluginOptions.services}
 * when the daemon wires it, which is the only fully precise source (it also sees
 * crashes and auto-restarts). Passing it is a one-liner:
 * `createHealthPlugin({ services: supervisor })`.
 */
import fs from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { findSubapp, loadWorkspaceFrom } from "../../config/index.js";
import { DEFAULT_HEALTH } from "../../config/types.js";
import type { HealthCheckDef, NormalizedWorkspace, TargetId } from "../../config/types.js";
import type { WorkspaceHolder } from "../../daemon/contracts.js";
import type { ServiceStateAccess } from "../../indicators/index.js";
import type { IndicatorTone, ServiceState, ServiceStatus } from "../../ipc/protocol.js";
import { definePlugin } from "../../plugin/index.js";
import type {
  HookContext,
  IndicatorResult,
  PluginDefinition,
  ReadinessContext,
  ReadinessVerdict,
  TargetInfo,
  WorkspaceInfo,
} from "../../plugin/types.js";
import { exec } from "../../process/index.js";
import { errorMessage } from "../../util/errors.js";
import type { Logger } from "../../util/logger.js";

/** Also the reserved namespace: `{health@status}`. */
export const PLUGIN_NAME = "health";

/** The one cell this plugin publishes. */
export const STATUS_INDICATOR = "status";

/** SPEC §7.2's user-facing enum, rendered verbatim (`--json` reads the same string). */
export type HealthStatus = "healthy" | "unhealthy" | "starting" | "n/a";

const TONES: Record<HealthStatus, IndicatorTone> = {
  healthy: "ok",
  unhealthy: "error",
  starting: "info",
  "n/a": "muted",
};

/**
 * Upper bound on how long a monitor may go without re-reading lifecycle state,
 * when a live accessor makes that possible. Reading it is a map lookup, so a
 * service that goes down should not stay green for a whole (possibly 5 s) probe
 * interval; the probes themselves stay on `intervalMs`.
 */
export const STATE_POLL_MS = 1_000;

/**
 * Slack allowed when deciding a probe is due. Timers fire a millisecond or two
 * late, and without it every probe would slip a whole tick — turning a 5 s check
 * into a 10 s one.
 */
const DUE_SLACK_MS = 50;

/** How often the config file is re-stat'ed when health defs are read from disk. */
const CONFIG_RECHECK_MS = 1_000;

/** Lifecycle states in which a process exists to probe. */
const LIVE: ReadonlySet<ServiceStatus> = new Set<ServiceStatus>(["starting", "running"]);

function isLive(state: ServiceState | undefined): boolean {
  return state !== undefined && LIVE.has(state.status);
}

/** The cell as the registry caches it: the status verbatim, plus how to colour it. */
export function statusResult(status: HealthStatus): IndicatorResult {
  return { value: status, tone: TONES[status] };
}

/**
 * SIGTERM→SIGKILL grace for a `cmd` probe. It stays well inside the interval:
 * a hung probe that lingers past the next tick would freeze the target's verdict
 * for as long as it takes to die.
 */
export function probeKillGraceMs(def: HealthCheckDef): number {
  return Math.max(50, Math.min(1_000, Math.floor(def.intervalMs / 4)));
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface ProbeOutcome {
  ok: boolean;
  /** Why, for the daemon log. Never rendered — the row only carries the status. */
  detail: string;
}

/**
 * GETs `url`. 2xx and 3xx are healthy; every other answer, a refused connection
 * and the timeout are failures.
 *
 * `agent: false` keeps the request out of the global agent's keep-alive pool,
 * and the request is destroyed on every exit path — including the timeout, where
 * the socket would otherwise sit open until the server felt like closing it.
 */
export function probeHttp(url: string, timeoutMs: number, signal?: AbortSignal): Promise<ProbeOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, detail: `invalid health URL "${url}"` });
  }
  const secure = parsed.protocol === "https:";
  if (!secure && parsed.protocol !== "http:") {
    return Promise.resolve({ ok: false, detail: `unsupported health URL protocol "${parsed.protocol}"` });
  }

  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      req?.destroy();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ ok: false, detail: "probe cancelled" });

    const timer = setTimeout(() => finish({ ok: false, detail: `timed out after ${timeoutMs}ms` }), timeoutMs);
    // A probe is background work: the pending socket already holds the loop open
    // for as long as this timer matters.
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });

    const onResponse = (res: IncomingMessage): void => {
      const code = res.statusCode ?? 0;
      // The body is irrelevant to the verdict, but the socket only closes once
      // the response has been consumed or thrown away.
      res.resume();
      res.destroy();
      finish({ ok: code >= 200 && code < 400, detail: `HTTP ${code}` });
    };

    try {
      req = secure
        ? // A dev server on localhost usually has a self-signed certificate, and
          // rejecting it would report a perfectly healthy service as down. The
          // probe reads a status code and sends nothing, so there is no secret to
          // protect — but only loopback gets the exemption.
          httpsRequest(
            parsed,
            { method: "GET", agent: false, rejectUnauthorized: !isLoopback(parsed.hostname) },
            onResponse,
          )
        : httpRequest(parsed, { method: "GET", agent: false }, onResponse);
      req.on("error", (err) => finish({ ok: false, detail: errorMessage(err) }));
      req.end();
    } catch (err) {
      finish({ ok: false, detail: errorMessage(err) });
      return;
    }

    if (signal?.aborted === true) onAbort();
  });
}

/** `URL.hostname` has already stripped the brackets from an IPv6 literal. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

interface CmdProbeOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  killGraceMs: number;
  signal?: AbortSignal;
}

/** Runs the shell probe in the subapp's cwd with its merged env; exit 0 is healthy. */
export async function probeCmd(cmd: string, opts: CmdProbeOptions): Promise<ProbeOutcome> {
  const result = await exec(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    killGraceMs: opts.killGraceMs,
    signal: opts.signal,
  });
  if (result.ok) return { ok: true, detail: `exit 0 in ${result.durationMs}ms` };
  if (result.timedOut) return { ok: false, detail: `timed out after ${opts.timeoutMs}ms` };
  return { ok: false, detail: `exit code ${result.exitCode ?? "none"}` };
}

// ---------------------------------------------------------------------------
// Monitor — one target's probe loop and verdict
// ---------------------------------------------------------------------------

type Emit = (status: HealthStatus) => void;

/**
 * The state machine behind one target's `health@status`.
 *
 * It is *armed* while the target's process is up. Arming resets everything —
 * a fresh process starts at `starting` with no failures behind it — and
 * disarming parks the cell at `n/a` and cancels whatever was in flight.
 */
class Monitor {
  private def: HealthCheckDef | undefined;
  /** Identity of the current check; a changed one invalidates past verdicts. */
  private key = "";
  private cwd: string;
  private env: Record<string, string>;
  private logger: Logger;

  private status: HealthStatus = "n/a";
  private failures = 0;
  private armed = false;
  /** `startedAt` of the run being probed; a change means a different process. */
  private runToken: number | undefined;
  private inFlight = false;
  private probeStartedAt = 0;
  /** Bumped whenever the run changes, so a late probe cannot report into it. */
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly listeners = new Set<Emit>();

  constructor(
    readonly id: TargetId,
    target: TargetInfo,
    logger: Logger,
  ) {
    this.cwd = target.cwd;
    this.env = target.env;
    this.logger = logger;
  }

  /** Re-reads the target's definition; a target that lost its check goes `n/a`. */
  configure(def: HealthCheckDef | undefined, target: TargetInfo, logger: Logger): void {
    this.cwd = target.cwd;
    this.env = target.env;
    this.logger = logger;
    const key = checkKey(def);
    if (key === this.key) return;
    this.key = key;
    this.def = def;
    if (def === undefined) {
      this.disarm();
      return;
    }
    // Whatever the previous check measured says nothing about this one.
    if (this.armed) this.arm(this.runToken);
  }

  hasCheck(): boolean {
    return this.def !== undefined;
  }

  intervalMs(): number {
    return this.def?.intervalMs ?? DEFAULT_HEALTH.intervalMs;
  }

  current(): HealthStatus {
    return this.status;
  }

  listen(emit: Emit): () => void {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  /** Applies a lifecycle state. Ignores `undefined`: no news is not bad news. */
  observe(state: ServiceState | undefined): void {
    if (state === undefined) return;
    if (this.def === undefined || !isLive(state)) {
      this.disarm();
      return;
    }
    if (!this.armed || state.startedAt !== this.runToken) this.arm(state.startedAt);
  }

  /**
   * A lifecycle edge inferred from a command hook, which carries no
   * {@link ServiceState}. `fresh` marks a restart: the process behind an already
   * armed monitor was replaced, so its verdict starts over.
   */
  assume(running: boolean, fresh = false): void {
    if (!running) {
      this.disarm();
      return;
    }
    if (this.def === undefined) return;
    if (fresh || !this.armed) this.arm(Date.now());
  }

  /** Starts a probe when one is due and none is in flight. Never throws or awaits. */
  maybeProbe(): void {
    const def = this.def;
    if (!def || !this.armed || this.inFlight) return;
    const slack = Math.min(DUE_SLACK_MS, Math.floor(def.intervalMs / 4));
    if (this.probeStartedAt !== 0 && Date.now() - this.probeStartedAt < def.intervalMs - slack) return;
    void this.probe(def).catch((err: unknown) => {
      this.logger.error(`health probe of ${this.id} failed: ${errorMessage(err)}`);
    });
  }

  /** Cancels in-flight work without forgetting the verdict (disposal, re-arming). */
  stopProbing(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  }

  dispose(): void {
    this.listeners.clear();
    this.stopProbing();
  }

  // --- internals -----------------------------------------------------------

  private arm(token: number | undefined): void {
    this.stopProbing();
    this.armed = true;
    this.runToken = token;
    this.failures = 0;
    this.probeStartedAt = 0;
    this.setStatus("starting");
  }

  private disarm(): void {
    if (!this.armed && this.status === "n/a") return;
    this.stopProbing();
    this.armed = false;
    this.runToken = undefined;
    this.failures = 0;
    this.probeStartedAt = 0;
    this.setStatus("n/a");
  }

  private async probe(def: HealthCheckDef): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight = true;
    this.probeStartedAt = Date.now();
    this.controller = controller;

    let outcome: ProbeOutcome;
    try {
      outcome =
        def.http !== undefined
          ? await probeHttp(def.http, def.timeoutMs, controller.signal)
          : await probeCmd(def.cmd ?? "", {
              cwd: this.cwd,
              env: this.env,
              timeoutMs: def.timeoutMs,
              killGraceMs: probeKillGraceMs(def),
              signal: controller.signal,
            });
    } catch (err) {
      // Only an unspawnable shell lands here; a failing probe is data, not a throw.
      outcome = { ok: false, detail: errorMessage(err) };
    } finally {
      this.inFlight = false;
      if (this.controller === controller) this.controller = undefined;
    }

    // The run this probe belonged to is over (stopped, restarted, disposed).
    if (generation !== this.generation || controller.signal.aborted) return;
    this.record(def, outcome);
  }

  private record(def: HealthCheckDef, outcome: ProbeOutcome): void {
    if (!this.armed) return;
    if (outcome.ok) {
      this.failures = 0;
      this.setStatus("healthy");
      return;
    }
    this.failures += 1;
    this.logger.debug(`${this.id}: probe failed (${this.failures}/${def.threshold}) — ${outcome.detail}`);
    if (this.failures >= def.threshold) this.setStatus("unhealthy");
  }

  private setStatus(next: HealthStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (err) {
        this.logger.warn(`health listener threw for ${this.id}: ${errorMessage(err)}`);
      }
    }
  }
}

/** Identity of a check: two defs with the same key measure the same thing. */
function checkKey(def: HealthCheckDef | undefined): string {
  if (!def) return "";
  return [def.http ?? "", def.cmd ?? "", def.intervalMs, def.timeoutMs, def.threshold].join("|");
}

// ---------------------------------------------------------------------------
// Health definitions — read from the workspace the plugin was loaded for
// ---------------------------------------------------------------------------

/**
 * Resolves a target's `health` block.
 *
 * `TargetInfo` carries `hasHealth` but not the check itself, so without a live
 * workspace the config file is re-read — cached against its mtime, which also
 * makes a hot reload land here without a restart. `hasHealth === false` short-
 * circuits it, so a workspace with no health checks never touches the disk.
 */
function createDefReader(holder: WorkspaceHolder | undefined): (
  workspace: WorkspaceInfo,
  target: TargetInfo,
  logger: Logger,
) => HealthCheckDef | undefined {
  let cached: NormalizedWorkspace | undefined;
  let cachedPath = "";
  let cachedMtimeMs = -1;
  let checkedAt = 0;
  let warned = false;

  const load = (configPath: string, logger: Logger): NormalizedWorkspace | undefined => {
    if (holder) return holder.current();
    const now = Date.now();
    if (cached !== undefined && cachedPath === configPath && now - checkedAt < CONFIG_RECHECK_MS) return cached;
    checkedAt = now;

    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(configPath).mtimeMs;
    } catch {
      // Unreadable right now: last-good beats no health checks at all.
    }
    if (cached !== undefined && cachedPath === configPath && mtimeMs === cachedMtimeMs) return cached;

    try {
      cached = loadWorkspaceFrom(configPath);
      cachedPath = configPath;
      cachedMtimeMs = mtimeMs;
      warned = false;
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.warn(`cannot read health checks from ${configPath}: ${errorMessage(err)}`);
      }
    }
    return cached;
  };

  return (workspace, target, logger) => {
    if (!target.hasHealth) return undefined;
    return findSubapp(load(workspace.configPath, logger) ?? blankWorkspace(), target.id)?.health;
  };
}

/** Stand-in for a workspace that could not be read; every lookup misses. */
function blankWorkspace(): NormalizedWorkspace {
  return { subapps: [] } as unknown as NormalizedWorkspace;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export interface HealthPluginOptions {
  /**
   * Live lifecycle state, which the daemon's supervisor satisfies structurally.
   * Without it the monitors fall back to the lifecycle edges the plugin SDK
   * exposes (see the module docs), which miss crashes and auto-restarts.
   */
  services?: ServiceStateAccess;
  /**
   * Live workspace. Without it the health checks are re-read from
   * `workspace.configPath`, cached against the file's mtime.
   */
  workspace?: WorkspaceHolder;
}

/**
 * Builds the plugin. The default export is an instance with no wiring, which is
 * what the plugin host loads; the daemon can hand over live state instead.
 */
export function createHealthPlugin(opts: HealthPluginOptions = {}): PluginDefinition {
  const monitors = new Map<TargetId, Monitor>();
  const defOf = createDefReader(opts.workspace);

  const liveState = (id: TargetId): ServiceState | undefined => opts.services?.state(id);

  const monitorFor = (workspace: WorkspaceInfo, target: TargetInfo, logger: Logger): Monitor => {
    let monitor = monitors.get(target.id);
    if (!monitor) {
      monitor = new Monitor(target.id, target, logger);
      monitors.set(target.id, monitor);
    }
    monitor.configure(defOf(workspace, target, logger), target, logger);
    return monitor;
  };

  /** Applies one lifecycle command's outcome to the target's monitor. */
  const onLifecycle = (ctx: HookContext, running: boolean, fresh = false): void => {
    const monitor = monitorFor(ctx.workspace, ctx.target, ctx.logger);
    const state = liveState(ctx.target.id);
    if (state !== undefined) {
      monitor.observe(state);
    } else if (ctx.result?.ok === false) {
      // The command failed: a start that never spawned has nothing to probe, and
      // a stop that did not take leaves the process — and its verdict — standing.
      if (running) monitor.assume(false);
    } else {
      monitor.assume(running, fresh);
    }
    monitor.maybeProbe();
  };

  return definePlugin({
    name: PLUGIN_NAME,

    indicators: {
      [STATUS_INDICATOR]: {
        scope: "subapp",
        description: "Health check verdict: healthy, unhealthy, starting or n/a",
        // Event mode: the verdict is pushed the moment a probe lands, instead of
        // waiting for a registry poll that knows nothing about probe timing.
        update: { mode: "event" },
        subscribe(ctx, emit) {
          const target = ctx.target;
          if (!target) return;
          const monitor = monitorFor(ctx.workspace, target, ctx.logger);
          monitor.observe(liveState(target.id) ?? ctx.service);

          const off = monitor.listen((status) => emit(statusResult(status)));
          emit(statusResult(monitor.current()));
          // A target with no health check has nothing to poll: `n/a` is its final
          // answer until a config reload re-subscribes it.
          if (!monitor.hasCheck()) return off;

          monitor.maybeProbe();
          const tickMs = opts.services
            ? Math.min(monitor.intervalMs(), STATE_POLL_MS)
            : monitor.intervalMs();
          const timer = setInterval(() => {
            monitor.observe(liveState(target.id));
            monitor.maybeProbe();
          }, tickMs);
          // Health is decoration: it must never be why the daemon stays alive.
          timer.unref();

          return () => {
            clearInterval(timer);
            off();
            monitor.stopProbing();
          };
        },
      },
    },

    /**
     * Lifecycle edges. `IndicatorContext.service` is captured once for a
     * subscription, so without {@link HealthPluginOptions.services} these hooks
     * are what tells a monitor its process came up or went away.
     */
    hooks: {
      "app:start": {
        post: (ctx) => {
          onLifecycle(ctx, true);
        },
      },
      "app:restart": {
        post: (ctx) => {
          onLifecycle(ctx, true, true);
        },
      },
      "app:stop": {
        post: (ctx) => {
          onLifecycle(ctx, false);
        },
      },
    },

    /**
     * The readiness signal `dependsOn` gates on (SPEC §5.4).
     *
     * `"n/a"` means "no opinion": the engine falls back to *ready once running*.
     * Answering anything else for a target that declares no health check would
     * stall every dependent it has, so that case is decided before anything else.
     */
    readiness(ctx: ReadinessContext): ReadinessVerdict {
      const monitor = monitorFor(ctx.workspace, ctx.target, ctx.logger);
      if (!monitor.hasCheck()) return "n/a";

      const state = liveState(ctx.target.id) ?? ctx.service;
      monitor.observe(state);
      if (!isLive(state)) return "n/a";

      // Gating polls faster than any probe interval, so this only starts a probe
      // when one is genuinely due — and it is what drives the loop for a target
      // whose indicator nobody subscribed to.
      monitor.maybeProbe();
      return monitor.current() === "healthy" ? "ready" : "pending";
    },

    teardown() {
      for (const monitor of monitors.values()) monitor.dispose();
      monitors.clear();
    },
  });
}

export default createHealthPlugin();
