import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkspace } from "../../src/config/index.js";
import type { NormalizedWorkspace, TargetId } from "../../src/config/types.js";
import type {
  BoundCommand,
  BoundHook,
  Engine,
  IndicatorRegistration,
  PluginHost,
  RunHandle,
  StartOptions,
  StopOptions,
  Supervisor,
  Unsubscribe,
} from "../../src/daemon/contracts.js";
import { createEngine } from "../../src/engine/index.js";
import type {
  LogLine,
  ServiceState,
  SnapshotPlugin,
  TaskProgress,
  TaskResult,
  TaskTargetResult,
  TaskTargetState,
} from "../../src/ipc/protocol.js";
import type { HookDef, PluginCommandDef, ReadinessVerdict, TargetInfo } from "../../src/plugin/types.js";
import { nullLogger } from "../../src/util/logger.js";
import type { StatePaths } from "../../src/util/paths.js";

const created: string[] = [];

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `predicate` holds, or throws after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Fake supervisor — the engine only ever sees the frozen interface
// ---------------------------------------------------------------------------

export interface SupervisorEvent {
  id: TargetId;
  kind: "start" | "stop";
  at: number;
  /** Start only: the script the engine asked to supervise, if it named one. */
  script?: string;
  /** Start only: the command the start was made on behalf of. */
  via?: string;
}

export class FakeSupervisor implements Supervisor {
  readonly events: SupervisorEvent[] = [];
  /** Targets whose `start` rejects, as a spawn failure would. */
  readonly failStart = new Set<TargetId>();
  /** Targets that come back `crashed` instead of `running`. */
  readonly crashOnStart = new Set<TargetId>();
  /**
   * Targets whose start settles in `"starting"` and stays there — a process
   * still inside the supervisor's start grace, or one the backoff ladder has
   * just respawned. The real supervisor counts those as "up" for
   * {@link isRunning}, which is exactly what readiness gating must not do.
   */
  readonly stuckStarting = new Set<TargetId>();
  /** Targets whose `stop` rejects. */
  readonly failStop = new Set<TargetId>();
  startDelayMs = 0;
  private nextPid = 4_000;
  private readonly byId = new Map<TargetId, ServiceState>();

  get startOrder(): TargetId[] {
    return this.events.filter((e) => e.kind === "start").map((e) => e.id);
  }

  get stopOrder(): TargetId[] {
    return this.events.filter((e) => e.kind === "stop").map((e) => e.id);
  }

  state(id: TargetId): ServiceState {
    return this.byId.get(id) ?? { targetId: id, status: "stopped", stale: false, restartAttempts: 0 };
  }

  states(): ServiceState[] {
    return [...this.byId.values()];
  }

  /** Deliberately mirrors the real supervisor: `"starting"` counts as up. */
  isRunning(id: TargetId): boolean {
    const status = this.state(id).status;
    return status === "running" || status === "starting";
  }

  runningCount(): number {
    return this.states().filter((s) => s.status === "running").length;
  }

  async start(id: TargetId, opts?: StartOptions): Promise<ServiceState> {
    this.events.push({ id, kind: "start", at: Date.now(), script: opts?.script, via: opts?.via });
    if (this.startDelayMs > 0) await delay(this.startDelayMs);
    if (this.failStart.has(id)) throw new Error(`fake supervisor cannot start ${id}`);
    const crashed = this.crashOnStart.has(id);
    const starting = !crashed && this.stuckStarting.has(id);
    const next: ServiceState = {
      targetId: id,
      status: crashed ? "crashed" : starting ? "starting" : "running",
      stale: false,
      pid: crashed ? undefined : this.nextPid++,
      startedAt: Date.now(),
      exitCode: crashed ? 7 : undefined,
      restartAttempts: 0,
      lastError: crashed ? "exited immediately" : undefined,
    };
    this.byId.set(id, next);
    return next;
  }

  /** The real supervisor settles a start on its own; the fake is already settled. */
  async waitForSettled(id: TargetId): Promise<ServiceState> {
    return this.state(id);
  }

  /** Flips an already-started target to `crashed`, as a late crash would. */
  crash(id: TargetId, exitCode = 9): void {
    this.byId.set(id, {
      targetId: id,
      status: "crashed",
      stale: false,
      exitCode,
      restartAttempts: 0,
      lastError: `exited with code ${exitCode}`,
    });
  }

  async stop(id: TargetId, _opts?: StopOptions): Promise<ServiceState> {
    this.events.push({ id, kind: "stop", at: Date.now() });
    if (this.failStop.has(id)) throw new Error(`fake supervisor cannot stop ${id}`);
    const next: ServiceState = { targetId: id, status: "stopped", stale: false, restartAttempts: 0 };
    this.byId.set(id, next);
    return next;
  }

  async restart(id: TargetId): Promise<ServiceState> {
    await this.stop(id);
    return this.start(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.byId.keys()]) await this.stop(id);
  }

  markStale(): void {}

  onChange(): Unsubscribe {
    return () => {};
  }

  onLog(): Unsubscribe {
    return () => {};
  }

  async readLog(): Promise<LogLine[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fake plugin host
// ---------------------------------------------------------------------------

export class FakePluginHost implements PluginHost {
  private readonly bindings: Array<{ plugin: string; command: string; def: HookDef }> = [];
  private readonly cmds: BoundCommand[] = [];
  /** Per-target readiness verdict; anything absent answers `"n/a"`. */
  readonly verdicts = new Map<TargetId, ReadinessVerdict>();
  /** Set to make `readiness` throw, proving the engine falls back safely. */
  readinessThrows = false;

  addHook(plugin: string, command: string, def: HookDef): this {
    this.bindings.push({ plugin, command, def });
    return this;
  }

  addCommand(plugin: string, name: string, def: PluginCommandDef): this {
    this.cmds.push({ plugin, name, def });
    return this;
  }

  hooksFor(command: string): BoundHook[] {
    return this.bindings
      .filter((b) => b.command === command || b.command === "*")
      .map((b) => ({ plugin: b.plugin, def: b.def }));
  }

  commands(): BoundCommand[] {
    return [...this.cmds];
  }

  indicators(): IndicatorRegistration[] {
    return [];
  }

  async readiness(target: TargetInfo, _service: ServiceState): Promise<ReadinessVerdict> {
    if (this.readinessThrows) throw new Error("readiness exploded");
    return this.verdicts.get(target.id) ?? "n/a";
  }

  list(): SnapshotPlugin[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  config: object;
  /** Directories to create under the workspace root (repo / app cwds). */
  dirs?: string[];
  files?: Record<string, string>;
  profile?: string;
  readinessPollMs?: number;
}

export interface Harness {
  dir: string;
  /** The workspace the engine currently sees — swapped by {@link Harness.reload}. */
  readonly ws: NormalizedWorkspace;
  paths: StatePaths;
  supervisor: FakeSupervisor;
  plugins: FakePluginHost;
  engine: Engine;
  progress: TaskProgress[];
  finished: TaskResult[];
  logs: LogLine[];
  setProfile(name: string): void;
  /** Rewrites `u8.jsonc` and swaps what the holder hands out — a hot reload. */
  reload(config: object): NormalizedWorkspace;
  /** Every state pushed for one target, in order. */
  statesOf(targetId: TargetId): TaskTargetState[];
  file(rel: string): string;
  read(rel: string): string;
}

export function createHarness(opts: HarnessOptions): Harness {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-engine-")));
  created.push(dir);
  for (const rel of opts.dirs ?? []) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  fs.writeFileSync(path.join(dir, "u8.jsonc"), JSON.stringify(opts.config, null, 2), "utf8");

  let ws = loadWorkspace(dir);
  const stateDir = path.join(dir, ".state");
  const paths: StatePaths = {
    id: ws.id,
    dir: stateDir,
    socket: path.join(stateDir, "daemon.sock"),
    pidFile: path.join(stateDir, "daemon.pid"),
    daemonLog: path.join(stateDir, "daemon.log"),
    stateFile: path.join(stateDir, "state.json"),
    serviceLogDir: path.join(stateDir, "logs", "services"),
    taskLogDir: path.join(stateDir, "logs", "tasks"),
  };

  const supervisor = new FakeSupervisor();
  const plugins = new FakePluginHost();
  const progress: TaskProgress[] = [];
  const finished: TaskResult[] = [];
  const logs: LogLine[] = [];
  let profile = opts.profile ?? ws.defaultProfile;

  // A function, not a captured value: `reload` swaps the workspace underneath a
  // live engine exactly as the daemon's config reload does.
  const engine = createEngine({
    workspace: { current: () => ws },
    paths,
    logger: nullLogger,
    supervisor,
    plugins,
    activeProfile: () => profile,
    readinessPollMs: opts.readinessPollMs ?? 20,
  });

  engine.onProgress((p) => progress.push(p));
  engine.onFinished((r) => finished.push(r));
  engine.onLog((l) => logs.push(l));

  return {
    dir,
    get ws() {
      return ws;
    },
    paths,
    supervisor,
    plugins,
    engine,
    progress,
    finished,
    logs,
    setProfile(name: string) {
      profile = name;
    },
    reload(config: object) {
      fs.writeFileSync(path.join(dir, "u8.jsonc"), JSON.stringify(config, null, 2), "utf8");
      ws = loadWorkspace(dir);
      return ws;
    },
    statesOf(targetId: TargetId) {
      return progress.filter((p) => p.targetId === targetId).map((p) => p.state);
    },
    file(rel: string) {
      return path.join(dir, rel);
    },
    read(rel: string) {
      const p = path.join(dir, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    },
  };
}

export function cleanupHarnesses(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function resultFor(result: TaskResult, targetId: TargetId): TaskTargetResult {
  const found = result.targets.find((t) => t.targetId === targetId);
  if (!found) throw new Error(`no result for "${targetId}" (have: ${result.targets.map((t) => t.targetId).join(", ")})`);
  return found;
}

export function statesByTarget(result: TaskResult): Record<TargetId, TaskTargetState> {
  return Object.fromEntries(result.targets.map((t) => [t.targetId, t.state]));
}

/** Fails loudly instead of hanging when a run never settles. */
export async function settled(handle: RunHandle, timeoutMs = 5_000): Promise<TaskResult> {
  const timer = delay(timeoutMs).then(() => "timed out" as const);
  const outcome = await Promise.race([handle.done, timer]);
  if (outcome === "timed out") throw new Error(`run ${handle.runId} did not settle in ${timeoutMs}ms`);
  return outcome;
}

/**
 * Peak parallelism recorded by the concurrency fixture script, which appends a
 * line as it enters and another as it leaves.
 */
export function peakConcurrency(marker: string): number {
  let depth = 0;
  let peak = 0;
  for (const line of marker.split("\n")) {
    if (line === "in") peak = Math.max(peak, ++depth);
    else if (line === "out") depth--;
  }
  return peak;
}

/**
 * Records its own overlap window into the marker file one level above the
 * target's cwd — every app using it must sit at the same depth, so all of
 * them append to the same file. `>>` is O_APPEND, so the one-word writes of
 * parallel shells cannot tear.
 */
export const CONCURRENCY_SCRIPT = 'printf "in\\n" >> ../mark.txt; sleep 0.12; printf "out\\n" >> ../mark.txt';
