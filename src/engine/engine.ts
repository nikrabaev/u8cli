/**
 * The command engine — SPEC §2.5, §2.6, §5.4.
 *
 * Three kinds of work share one run model:
 *
 *  - **core service commands** (`app:start|stop|restart`) delegate to the
 *    supervisor, sequenced by the dependency DAG;
 *  - **config commands** run a shell script per target in that target's cwd;
 *  - **plugin commands** call `def.run(ctx)` once per target (or once per app).
 *
 * Whatever the work is, every target travels the same path: a hook pipeline
 * around it, a `TaskProgress` event on each state change, its output captured
 * to a per-(run, target) log file *and* streamed out live, and a slot in the
 * final `TaskResult`. A run therefore has exactly one shape for the RPC layer
 * to relay, and exactly one place — {@link settle} — where it can finish.
 *
 * Every entry point hands back a {@link RunHandle} synchronously: the daemon
 * answers the RPC with the run id and lets the client follow the progress
 * stream, so nothing here may block before returning the handle.
 *
 * Each flow reads the workspace once, when it is launched, and works against
 * that snapshot for the rest of the run — a config reload landing mid-run must
 * not move a target's cwd or script out from under a process already using it.
 */
import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import {
  commandTargets,
  coreStartScript,
  coreStopScript,
  findApp,
  findCommand,
  findSubapp,
  profileTargets,
  resolveTargetStrings,
  topoWaves,
  type NormalizedApp,
  type NormalizedCommand,
  type NormalizedSubapp,
  type NormalizedWorkspace,
  type TargetId,
} from "../config/index.js";
import type {
  BoundCommand,
  BoundHook,
  Engine,
  PluginHost,
  RunCommandOptions,
  RunHandle,
  Supervisor,
  Unsubscribe,
  WorkspaceHolder,
} from "../daemon/contracts.js";
import type {
  LogLine,
  TaskProgress,
  TaskResult,
  TaskTargetResult,
  TaskTargetState,
} from "../ipc/protocol.js";
import type { CommandContext, HookContext, HookResult, TargetInfo } from "../plugin/types.js";
import { exec, parseLogLine, pruneTaskRuns, readLastLines, taskRunLogPath } from "../process/index.js";
import type { ExecOptions, ExecResult } from "../process/types.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { StatePaths } from "../util/paths.js";
import { toAppInfo, toTargetInfo, toWorkspaceInfo } from "./context.js";
import { runPostHooks, runPreHooks, type HookPipeline } from "./hooks.js";
import { runPool } from "./pool.js";
import { describeExit, runScript, targetEnv } from "./script.js";
import { createTargetSink, type TargetSink } from "./sink.js";

/** How many finished runs stay answerable by {@link Engine.awaitRun}. */
const MAX_RETAINED_RUNS = 50;

/** How often a dependency's readiness is re-evaluated while gating a start. */
const DEFAULT_READINESS_POLL_MS = 100;

export interface EngineDeps {
  workspace: WorkspaceHolder;
  paths: StatePaths;
  logger: Logger;
  supervisor: Supervisor;
  plugins: PluginHost;
  /** Name of the profile a run targets when the caller names no targets. */
  activeProfile: () => string;
  /** Poll interval for dependency readiness; a test seam. Defaults to 100 ms. */
  readinessPollMs?: number;
}

interface RunRecord {
  runId: string;
  command: string;
  startedAt: number;
  controller: AbortController;
  cancelReason?: string;
  /** Every selected target, in resolution order — the shape of the result table. */
  order: TargetId[];
  results: Map<TargetId, TaskTargetResult>;
  /** Last state pushed per target, so a repeat is not re-announced. */
  emitted: Map<TargetId, TaskTargetState>;
  done: Promise<TaskResult>;
  resolve: (result: TaskResult) => void;
  finished: boolean;
}

/** Outcome of the work itself, before post hooks get a say. */
interface WorkOutcome {
  state: "ok" | "failed";
  exitCode?: number | null;
  error?: string;
}

/** One unit the pipeline runs: a reported id plus where the work happens. */
interface PipelineTarget {
  id: TargetId;
  subapp: NormalizedSubapp;
  app: NormalizedApp;
  /** The app path for app-grouped plugin commands, the subapp cwd otherwise. */
  cwd: string;
}

type Work = (sink: TargetSink) => Promise<WorkOutcome>;

interface RunOptions {
  serial?: boolean;
  concurrency?: number;
}

type Gate =
  | { kind: "ready" }
  | { kind: "aborted" }
  | { kind: "timeout"; dep: TargetId; timeoutMs: number };

export function createEngine(deps: EngineDeps): Engine {
  const { workspace, paths, supervisor, plugins } = deps;
  const log = deps.logger.child("engine");
  const readinessPollMs = deps.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;

  const runs = new Map<string, RunRecord>();
  /** Per-plugin scratch space, surviving across invocations as the SDK promises. */
  const stores = new Map<string, Map<string, unknown>>();

  const progressCbs = new Set<(p: TaskProgress) => void>();
  const finishedCbs = new Set<(r: TaskResult) => void>();
  const logCbs = new Set<(l: LogLine) => void>();

  function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const cb of [...listeners]) {
      try {
        cb(value);
      } catch (err) {
        log.warn(`engine listener threw: ${errorMessage(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Run bookkeeping
  // -------------------------------------------------------------------------

  function createRun(command: string, ids: readonly TargetId[]): RunRecord {
    const controller = new AbortController();
    // One signal fans out to every target's script and plugin call; the default
    // listener ceiling would warn on a wide profile.
    setMaxListeners(0, controller.signal);

    let resolve!: (result: TaskResult) => void;
    const done = new Promise<TaskResult>((r) => {
      resolve = r;
    });

    const rec: RunRecord = {
      runId: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      command,
      startedAt: Date.now(),
      controller,
      order: [...ids],
      results: new Map(),
      emitted: new Map(),
      done,
      resolve,
      finished: false,
    };
    runs.set(rec.runId, rec);
    return rec;
  }

  function progress(
    rec: RunRecord,
    targetId: TargetId,
    state: TaskTargetState,
    extra: Pick<TaskProgress, "exitCode" | "durationMs" | "error"> = {},
  ): void {
    if (rec.emitted.get(targetId) === state) return;
    rec.emitted.set(targetId, state);
    emit(progressCbs, { runId: rec.runId, command: rec.command, targetId, state, ...extra });
  }

  /** Records a target's terminal state. The first call wins. */
  function finish(
    rec: RunRecord,
    targetId: TargetId,
    state: TaskTargetState,
    extra: Partial<TaskTargetResult> = {},
  ): void {
    if (rec.results.has(targetId)) return;
    rec.results.set(targetId, {
      targetId,
      state,
      exitCode: extra.exitCode,
      durationMs: extra.durationMs ?? 0,
      error: extra.error,
      logPath: extra.logPath,
    });
    progress(rec, targetId, state, {
      exitCode: extra.exitCode,
      durationMs: extra.durationMs,
      error: extra.error,
    });
  }

  /**
   * Closes a run: fills in anything the body never reached, prunes old run logs,
   * and resolves the handle. Called exactly once per run, on every path.
   */
  async function settle(rec: RunRecord): Promise<void> {
    const targets = rec.order.map(
      (id) => rec.results.get(id) ?? { targetId: id, state: "skipped" as const, durationMs: 0 },
    );
    const result: TaskResult = {
      runId: rec.runId,
      command: rec.command,
      ok: targets.every((t) => t.state !== "failed" && t.state !== "aborted"),
      targets,
      startedAt: rec.startedAt,
      finishedAt: Date.now(),
    };
    rec.finished = true;

    try {
      await pruneTaskRuns(paths.taskLogDir, rec.command, workspace.current().limits.taskRunsKeep);
    } catch (err) {
      log.warn(`pruning task runs for "${rec.command}" failed: ${errorMessage(err)}`);
    }

    retainRuns();
    emit(finishedCbs, result);
    rec.resolve(result);
  }

  /** Keeps the newest {@link MAX_RETAINED_RUNS} answerable; in-flight runs never expire. */
  function retainRuns(): void {
    if (runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, rec] of runs) {
      if (runs.size <= MAX_RETAINED_RUNS) return;
      if (rec.finished) runs.delete(id);
    }
  }

  /**
   * Starts a run's body without letting the caller wait on it.
   *
   * The body is deferred by a turn of the event loop so the RPC layer can answer
   * with the run id before the first `task.progress` notification goes out —
   * otherwise a client would see progress for a run it does not know yet.
   */
  function launch(rec: RunRecord, body: () => Promise<void>): RunHandle {
    void (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const id of rec.order) progress(rec, id, "pending");
      try {
        await body();
      } catch (err) {
        const message = errorMessage(err);
        log.error(`run ${rec.runId} (${rec.command}) failed: ${message}`);
        for (const id of rec.order) finish(rec, id, "failed", { error: message });
      }
      try {
        await settle(rec);
      } catch (err) {
        // `done` must never hang: settle owns the only resolve, so a failure
        // there has to be turned into a result rather than swallowed.
        log.error(`settling run ${rec.runId} failed: ${errorMessage(err)}`);
        rec.finished = true;
        rec.resolve({
          runId: rec.runId,
          command: rec.command,
          ok: false,
          targets: [...rec.results.values()],
          startedAt: rec.startedAt,
          finishedAt: Date.now(),
        });
      }
    })();
    return { runId: rec.runId, done: rec.done };
  }

  // -------------------------------------------------------------------------
  // Plugin-facing contexts
  // -------------------------------------------------------------------------

  function storeFor(plugin: string): Map<string, unknown> {
    let store = stores.get(plugin);
    if (!store) {
      store = new Map<string, unknown>();
      stores.set(plugin, store);
    }
    return store;
  }

  function baseContext(plugin: string, rec: RunRecord, pt: PipelineTarget) {
    const ws = workspace.current();
    return {
      workspace: toWorkspaceInfo(ws),
      logger: deps.logger.child(plugin),
      store: storeFor(plugin),
      exec: (cmd: string, opts: ExecOptions = {}): Promise<ExecResult> =>
        exec(cmd, { cwd: pt.cwd, env: pt.subapp.env, signal: rec.controller.signal, ...opts }),
      command: rec.command,
      runId: rec.runId,
      app: toAppInfo(pt.app),
      target: toTargetInfo(pt.subapp),
      cwd: pt.cwd,
    };
  }

  function hookContext(
    plugin: string,
    rec: RunRecord,
    pt: PipelineTarget,
    phase: "pre" | "post",
    result?: HookResult,
  ): HookContext {
    return { ...baseContext(plugin, rec, pt), phase, result };
  }

  function commandContext(
    plugin: string,
    rec: RunRecord,
    pt: PipelineTarget,
    sink: TargetSink,
  ): CommandContext {
    return {
      ...baseContext(plugin, rec, pt),
      log: (text: string) => {
        sink.line("stdout", text);
      },
      signal: rec.controller.signal,
    };
  }

  function targetInfoFor(id: TargetId): TargetInfo | undefined {
    const subapp = findSubapp(workspace.current(), id);
    return subapp ? toTargetInfo(subapp) : undefined;
  }

  // -------------------------------------------------------------------------
  // The per-target pipeline: pre hooks → work → post hooks
  // -------------------------------------------------------------------------

  async function runPipeline(
    rec: RunRecord,
    pt: PipelineTarget,
    hooks: { config: { pre: string[]; post: string[] }; bound: readonly BoundHook[] },
    work: Work,
  ): Promise<TaskTargetState> {
    if (rec.controller.signal.aborted) {
      finish(rec, pt.id, "aborted", { error: rec.cancelReason ?? "run cancelled" });
      return "aborted";
    }

    progress(rec, pt.id, "running");
    const ws = workspace.current();
    const sink = createTargetSink({
      path: taskRunLogPath(paths.taskLogDir, rec.command, rec.runId, pt.id),
      runId: rec.runId,
      targetId: pt.id,
      maxBytes: ws.limits.logMaxBytes,
      logger: log,
      emit: (line) => {
        emit(logCbs, line);
      },
    });

    const pipeline: HookPipeline = {
      logger: log,
      runShell: (script) =>
        runScript({
          script,
          cwd: pt.cwd,
          env: targetEnv(pt.subapp.env),
          signal: rec.controller.signal,
          stopTimeoutMs: pt.subapp.stopTimeoutMs,
          logger: log,
          onLine: (stream, text, ts) => {
            sink.line(stream, text, ts);
          },
        }),
      context: (plugin, phase, result) => hookContext(plugin, rec, pt, phase, result),
      note: (text) => {
        sink.note(text);
      },
      cancelled: () => rec.controller.signal.aborted,
    };

    const startedAt = Date.now();
    let state: TaskTargetState = "failed";
    let exitCode: number | null | undefined;
    let error: string | undefined;

    try {
      const abortReason = await runPreHooks(hooks.config.pre, hooks.bound, pipeline);
      if (abortReason !== undefined) {
        state = "aborted";
        exitCode = null;
        error = abortReason;
      } else {
        const outcome = await work(sink);
        state = outcome.state;
        exitCode = outcome.exitCode;
        error = outcome.error;
      }

      // Cancellation short-circuits the pipeline: the `post` guarantee covers
      // hook aborts and failures, not a daemon that is trying to shut down.
      if (rec.controller.signal.aborted) {
        state = "aborted";
        error = rec.cancelReason ?? "run cancelled";
      } else {
        const result: HookResult = {
          ok: state === "ok",
          exitCode: exitCode ?? null,
          durationMs: Date.now() - startedAt,
          error,
        };
        const postError = await runPostHooks(hooks.config.post, hooks.bound, result, pipeline);
        if (postError !== undefined) {
          // A failing `post` fails the target, but never overwrites the original
          // cause when the target was already failing: that one explains more.
          if (state === "ok") {
            state = "failed";
            error = postError;
          } else {
            error = error === undefined ? postError : `${error}; ${postError}`;
          }
        }
      }
    } catch (err) {
      // Nothing above is expected to throw; if it does, the target fails rather
      // than the whole run, and the log handle is still released below.
      state = "failed";
      error = errorMessage(err);
      log.error(`pipeline for ${pt.id} (${rec.command}) threw: ${error}`);
    } finally {
      await sink.close();
    }

    finish(rec, pt.id, state, {
      exitCode,
      durationMs: Date.now() - startedAt,
      error,
      logPath: logPathOf(sink),
    });
    return state;
  }

  function logPathOf(sink: TargetSink): string | undefined {
    return sink.written ? sink.path : undefined;
  }

  function pipelineTarget(ws: NormalizedWorkspace, subapp: NormalizedSubapp, cwd?: string): PipelineTarget {
    const app = findApp(ws, subapp.appName) ?? { name: subapp.appName, path: subapp.cwd, subapps: [subapp] };
    return { id: subapp.id, subapp, app, cwd: cwd ?? subapp.cwd };
  }

  function hooksOf(ws: NormalizedWorkspace, command: string): {
    config: { pre: string[]; post: string[] };
    bound: BoundHook[];
  } {
    const declared = findCommand(ws, command)?.hooks;
    return {
      config: { pre: [...(declared?.pre ?? [])], post: [...(declared?.post ?? [])] },
      bound: plugins.hooksFor(command),
    };
  }

  // -------------------------------------------------------------------------
  // Target resolution
  // -------------------------------------------------------------------------

  function selectedIds(ws: NormalizedWorkspace, targets: readonly string[] | undefined): TargetId[] {
    if (!targets || targets.length === 0) return profileTargets(ws, deps.activeProfile());
    return resolveTargetStrings(ws, targets);
  }

  function concurrencyFor(
    ws: NormalizedWorkspace,
    cmd: NormalizedCommand | undefined,
    opts: RunOptions,
  ): number {
    if (opts.serial === true) return 1;
    return cmd?.concurrency ?? opts.concurrency ?? ws.limits.taskConcurrency;
  }

  // -------------------------------------------------------------------------
  // Config commands
  // -------------------------------------------------------------------------

  /**
   * A config command is a script per target. `null` in the `targets` map and a
   * target with no script at all are both skips — reported, not dropped, so the
   * summary table shows why nothing happened.
   */
  function runConfigCommand(cmd: NormalizedCommand, ids: TargetId[], opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const runnable = commandTargets(ws, cmd, ids);
    const scripts = new Map(runnable.map((t) => [t.targetId, t.script]));
    const rec = createRun(cmd.name, ids);
    const concurrency = concurrencyFor(ws, cmd, opts);
    const hooks = hooksOf(ws, cmd.name);

    return launch(rec, async () => {
      const tasks: Array<() => Promise<void>> = [];
      for (const id of ids) {
        const subapp = findSubapp(ws, id);
        const script = scripts.get(id);
        if (!subapp || script === undefined) {
          finish(rec, id, "skipped", { error: `no script for "${id}" in command "${cmd.name}"` });
          continue;
        }
        const pt = pipelineTarget(ws, subapp);
        tasks.push(async () => {
          await runPipeline(rec, pt, hooks, async (sink) => {
            const outcome = await runScript({
              script,
              cwd: pt.cwd,
              env: targetEnv(subapp.env),
              signal: rec.controller.signal,
              stopTimeoutMs: subapp.stopTimeoutMs,
              logger: log,
              onLine: (stream, text, ts) => {
                sink.line(stream, text, ts);
              },
            });
            if (outcome.ok) return { state: "ok", exitCode: outcome.exitCode };
            const message = describeExit(outcome);
            sink.note(message);
            return { state: "failed", exitCode: outcome.exitCode, error: message };
          });
        });
      }
      await runPool(tasks, concurrency);
    });
  }

  // -------------------------------------------------------------------------
  // Plugin commands
  // -------------------------------------------------------------------------

  /**
   * A plugin command runs once per target, filtered by `appliesTo`. With
   * `groupBy: "app"` it runs once per app instead — the first selected subapp of
   * each app represents it and the command's cwd becomes the app root, which is
   * what `git:pull` needs to avoid fetching the same repo four times.
   */
  function runPluginCommand(bound: BoundCommand, ids: TargetId[], opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const rec = createRun(bound.name, ids);
    const concurrency = concurrencyFor(ws, undefined, opts);
    const hooks = hooksOf(ws, bound.name);
    const byApp = bound.def.groupBy === "app";
    const representatives = new Map<string, TargetId>();

    return launch(rec, async () => {
      const tasks: Array<() => Promise<void>> = [];
      for (const id of ids) {
        const subapp = findSubapp(ws, id);
        if (!subapp) {
          finish(rec, id, "skipped", { error: `unknown target "${id}"` });
          continue;
        }
        if (!applies(bound, subapp)) {
          finish(rec, id, "skipped", { error: `command "${bound.name}" does not apply to this target` });
          continue;
        }
        if (byApp) {
          const seen = representatives.get(subapp.appName);
          if (seen !== undefined) {
            finish(rec, id, "skipped", { error: `covered by "${seen}" — "${bound.name}" runs once per app` });
            continue;
          }
          representatives.set(subapp.appName, id);
        }

        const pt = pipelineTarget(ws, subapp, byApp ? findApp(ws, subapp.appName)?.path : undefined);
        tasks.push(async () => {
          await runPipeline(rec, pt, hooks, async (sink) => {
            try {
              const returned = await bound.def.run(commandContext(bound.plugin, rec, pt, sink));
              if (typeof returned === "number" && returned !== 0) {
                const message = `command returned exit code ${returned}`;
                sink.note(message);
                return { state: "failed", exitCode: returned, error: message };
              }
              return { state: "ok", exitCode: 0 };
            } catch (err) {
              const message = errorMessage(err);
              sink.note(message);
              return { state: "failed", exitCode: null, error: message };
            }
          });
        });
      }
      await runPool(tasks, concurrency);
    });
  }

  function applies(bound: BoundCommand, subapp: NormalizedSubapp): boolean {
    if (!bound.def.appliesTo) return true;
    try {
      return bound.def.appliesTo(toTargetInfo(subapp)) !== false;
    } catch (err) {
      log.warn(`appliesTo of "${bound.name}" threw for ${subapp.id}: ${errorMessage(err)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Core service commands
  // -------------------------------------------------------------------------

  /** True once a dependency counts as ready: plugins decide, else "it runs". */
  async function isReady(id: TargetId): Promise<boolean> {
    const info = targetInfoFor(id);
    if (info) {
      try {
        const verdict = await plugins.readiness(info, supervisor.state(id));
        if (verdict === "ready") return true;
        if (verdict === "pending") return false;
      } catch (err) {
        log.warn(`readiness check for "${id}" threw: ${errorMessage(err)}`);
      }
    }
    return supervisor.isRunning(id);
  }

  /** Polls every dependency until it is ready, the run is cancelled, or it times out. */
  async function awaitDependencies(rec: RunRecord, dependencies: readonly TargetId[]): Promise<Gate> {
    for (const dep of dependencies) {
      const ws = workspace.current();
      const timeoutMs = findSubapp(ws, dep)?.readyTimeoutMs ?? ws.limits.readyTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (rec.controller.signal.aborted) return { kind: "aborted" };
        if (await isReady(dep)) break;
        if (Date.now() >= deadline) return { kind: "timeout", dep, timeoutMs };
        await delay(Math.min(readinessPollMs, Math.max(1, deadline - Date.now())), rec.controller.signal);
      }
    }
    return { kind: "ready" };
  }

  /**
   * Dependency-ordered start (SPEC §5.4).
   *
   * `blocked` carries the reason a target must not be attempted; a target whose
   * dependency lands in it is reported as `skipped` and blocks its own
   * dependents in turn, so a single unready service never silently drops half
   * the profile.
   *
   * Only dependencies *inside the selection* gate a start: `topoWaves` ignores
   * the rest on purpose, and waiting on a target the user chose not to start
   * would deadlock every partial start.
   *
   * Hooks are keyed on the *run's* command, not on `app:start`: this pass is
   * also the second half of `app:restart`, and a hook bound to a name the user
   * never ran — receiving a `ctx.command` that disagrees with its own binding —
   * would break the per-(command, target) contract of SPEC §2.6.
   */
  async function startPass(
    rec: RunRecord,
    ids: readonly TargetId[],
    concurrency: number,
    blocked: Map<TargetId, string>,
  ): Promise<void> {
    const ws = workspace.current();
    const hooks = hooksOf(ws, rec.command);
    const selected = new Set(ids);

    for (const wave of topoWaves(ws, ids)) {
      const tasks = wave.map((id) => async () => {
        const alreadyBlocked = blocked.get(id);
        if (alreadyBlocked !== undefined) {
          // Settled by an earlier pass — a restart whose stop half failed. The
          // existing result stands; `finish` only fills a target that has none.
          finish(rec, id, "skipped", { error: `not started: ${alreadyBlocked}` });
          return;
        }

        const subapp = findSubapp(ws, id);
        if (!subapp) {
          finish(rec, id, "failed", { error: `unknown target "${id}"` });
          blocked.set(id, "unknown target");
          return;
        }

        const dependencies = subapp.dependsOn.filter((d) => d !== id && selected.has(d));
        const badDep = dependencies.find((d) => blocked.has(d));
        if (badDep !== undefined) {
          const message = `not started: dependency "${badDep}" ${blocked.get(badDep) ?? "did not start"}`;
          finish(rec, id, "skipped", { error: message });
          blocked.set(id, `was skipped (dependency "${badDep}")`);
          return;
        }

        const gate = await awaitDependencies(rec, dependencies);
        if (gate.kind === "aborted") {
          finish(rec, id, "aborted", { error: rec.cancelReason ?? "run cancelled" });
          blocked.set(id, "was cancelled");
          return;
        }
        if (gate.kind === "timeout") {
          const message = `dependency "${gate.dep}" did not become ready within ${gate.timeoutMs}ms`;
          log.warn(`${id}: ${message}`);
          finish(rec, id, "failed", { error: message });
          blocked.set(id, "never became ready");
          return;
        }

        if (coreStartScript(ws, id) === null) {
          finish(rec, id, "skipped", { error: `no "start" script for "${id}"` });
          blocked.set(id, "has no start script");
          return;
        }

        const state = await runPipeline(rec, pipelineTarget(ws, subapp), hooks, async (sink) => {
          try {
            const service = await supervisor.start(id);
            if (service.status === "crashed") {
              const message = service.lastError ?? "service crashed during start";
              sink.note(message);
              return { state: "failed", exitCode: service.exitCode ?? null, error: message };
            }
            return { state: "ok", exitCode: 0 };
          } catch (err) {
            const message = errorMessage(err);
            sink.note(message);
            return { state: "failed", exitCode: null, error: message };
          }
        });
        if (state !== "ok") blocked.set(id, `did not start (${state})`);
      });

      await runPool(tasks, concurrency);
    }
  }

  /** Reverse-dependency-ordered stop: dependents go down before what they need. */
  async function stopPass(rec: RunRecord, ids: readonly TargetId[], concurrency: number): Promise<void> {
    const ws = workspace.current();
    const hooks = hooksOf(ws, rec.command);

    for (const wave of [...topoWaves(ws, ids)].reverse()) {
      const tasks = wave.map((id) => async () => {
        const subapp = findSubapp(ws, id);
        if (!subapp) {
          finish(rec, id, "failed", { error: `unknown target "${id}"` });
          return;
        }
        log.debug(`stopping ${id}`, { customStopScript: coreStopScript(ws, id) !== null });
        await runPipeline(rec, pipelineTarget(ws, subapp), hooks, async (sink) => {
          try {
            await supervisor.stop(id, { timeoutMs: subapp.stopTimeoutMs });
            return { state: "ok", exitCode: 0 };
          } catch (err) {
            const message = errorMessage(err);
            sink.note(message);
            return { state: "failed", exitCode: null, error: message };
          }
        });
      });

      await runPool(tasks, concurrency);
    }
  }

  /**
   * Restart's first half. It settles no target — the start half owns each
   * target's reported outcome — but a target that refuses to stop is failed
   * here and excluded from the start.
   */
  async function restartStopPass(
    rec: RunRecord,
    ids: readonly TargetId[],
    concurrency: number,
    blocked: Map<TargetId, string>,
  ): Promise<void> {
    const ws = workspace.current();

    for (const wave of [...topoWaves(ws, ids)].reverse()) {
      const tasks = wave.map((id) => async () => {
        if (rec.controller.signal.aborted) {
          finish(rec, id, "aborted", { error: rec.cancelReason ?? "run cancelled" });
          blocked.set(id, "was cancelled");
          return;
        }
        const subapp = findSubapp(ws, id);
        if (!subapp) {
          finish(rec, id, "failed", { error: `unknown target "${id}"` });
          blocked.set(id, "unknown target");
          return;
        }
        progress(rec, id, "running");
        try {
          await supervisor.stop(id, { timeoutMs: subapp.stopTimeoutMs });
        } catch (err) {
          const message = `stop failed: ${errorMessage(err)}`;
          finish(rec, id, "failed", { error: message });
          blocked.set(id, "failed to stop");
        }
      });

      await runPool(tasks, concurrency);
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  function startRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedIds(ws, targets);
    const rec = createRun("app:start", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:start"), opts);
    return launch(rec, () => startPass(rec, ids, concurrency, new Map()));
  }

  function stopRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedIds(ws, targets);
    const rec = createRun("app:stop", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:stop"), opts);
    return launch(rec, () => stopPass(rec, ids, concurrency));
  }

  function restartRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedIds(ws, targets);
    const rec = createRun("app:restart", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:restart"), opts);
    return launch(rec, async () => {
      const blocked = new Map<TargetId, string>();
      await restartStopPass(rec, ids, concurrency, blocked);
      await startPass(rec, ids, concurrency, blocked);
    });
  }

  return {
    runCommand(opts: RunCommandOptions): RunHandle {
      const runOpts: RunOptions = { serial: opts.serial, concurrency: opts.concurrency };
      switch (opts.command) {
        case "app:start":
          return startRun(opts.targets, runOpts);
        case "app:stop":
          return stopRun(opts.targets, runOpts);
        case "app:restart":
          return restartRun(opts.targets, runOpts);
        default:
          break;
      }

      const ws = workspace.current();
      const ids = selectedIds(ws, opts.targets);

      const plugin = plugins.commands().find((c) => c.name === opts.command);
      if (plugin) return runPluginCommand(plugin, ids, runOpts);

      const cmd = findCommand(ws, opts.command);
      if (!cmd) {
        throw new U8Error("UNKNOWN_COMMAND", `unknown command "${opts.command}"`, { command: opts.command });
      }
      // `kind: "service"` on a config command is accepted but runs as a task:
      // the supervisor registers one process per subapp from its `start` script,
      // and has no seam for an arbitrary script to claim that slot.
      return runConfigCommand(cmd, ids, runOpts);
    },

    startTargets(targets?: string[]): RunHandle {
      return startRun(targets, {});
    },

    stopTargets(targets?: string[]): RunHandle {
      return stopRun(targets, {});
    },

    restartTargets(targets?: string[]): RunHandle {
      return restartRun(targets, {});
    },

    awaitRun(runId: string): Promise<TaskResult> {
      const rec = runs.get(runId);
      if (!rec) return Promise.reject(unknownRun(runId));
      return rec.done;
    },

    cancelAll(reason: string): void {
      for (const rec of runs.values()) {
        if (rec.finished || rec.controller.signal.aborted) continue;
        rec.cancelReason = reason;
        rec.controller.abort(new U8Error("INTERNAL", reason, { runId: rec.runId }));
      }
    },

    onProgress(cb: (p: TaskProgress) => void): Unsubscribe {
      progressCbs.add(cb);
      return () => progressCbs.delete(cb);
    },

    onFinished(cb: (r: TaskResult) => void): Unsubscribe {
      finishedCbs.add(cb);
      return () => finishedCbs.delete(cb);
    },

    onLog(cb: (line: LogLine) => void): Unsubscribe {
      logCbs.add(cb);
      return () => logCbs.delete(cb);
    },

    /**
     * The on-disk format carries no stream tag (see `formatLogLine`), so
     * backfilled lines are reported as `stdout` — the live stream is the only
     * place stderr stays distinguishable.
     */
    async readRunLog(runId: string, targetId: TargetId, lines: number): Promise<LogLine[]> {
      const rec = runs.get(runId);
      if (!rec) throw unknownRun(runId);
      const file = taskRunLogPath(paths.taskLogDir, rec.command, runId, targetId);
      const raw = await readLastLines(file, lines);
      return raw.map((line) => {
        const { ts, text } = parseLogLine(line);
        return { targetId, runId, stream: "stdout" as const, ts: ts ?? rec.startedAt, text };
      });
    },
  };
}

/**
 * A run id that no longer resolves. There is no dedicated error code for it, so
 * this stays `INTERNAL` — clients distinguish it by the message, not the code.
 */
function unknownRun(runId: string): U8Error {
  const message = `unknown run "${runId}" — it never existed or is no longer retained`;
  return new U8Error("INTERNAL", message, { runId });
}

/**
 * Abortable sleep. The timer is intentionally *not* unref'd: it only exists
 * while a run is waiting on a dependency, and that is live work the process
 * should stay awake for. It is always cleared, on both paths.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
