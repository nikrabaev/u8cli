/**
 * The command engine — SPEC §2.5, §2.6, §5.4.
 *
 * Three kinds of work share one run model:
 *
 *  - **core service commands** (`app:start|stop|restart`) delegate to the
 *    supervisor, sequenced by the dependency DAG;
 *  - **config commands** run a shell script per target in that target's cwd;
 *  - **plugin commands** call `def.run(ctx)` once per target (or once per repo).
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
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  commandTargets,
  coreStartScript,
  coreStopScript,
  BASE_INSTANCE,
  expandTarget,
  findApp,
  findCommand,
  findInstance,
  findRepo,
  instanceTargets,
  profileTargets,
  qualify,
  qualifyTarget,
  resolveTargetStrings,
  splitQualified,
  topoWaves,
  unknownTargetMessage,
  type NormalizedApp,
  type NormalizedCommand,
  type NormalizedRepo,
  type NormalizedWorkspace,
  type TargetId,
} from "../config/index.js";
import type {
  BoundCommand,
  BoundHook,
  Engine,
  LifecycleOptions,
  LifecyclePhase,
  PluginHost,
  RunCommandOptions,
  RunHandle,
  StartScope,
  Supervisor,
  TargetScope,
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
import { describeDirectory } from "../util/dirs.js";
import { errorMessage, U8Error } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { StatePaths } from "../util/paths.js";
import { toRepoInfo, toTargetInfo, toWorkspaceInfo } from "./context.js";
import { postHookEnv, runPostHooks, runPreHooks, type HookPipeline } from "./hooks.js";
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
  app: NormalizedApp;
  repo: NormalizedRepo;
  /** The repo path for repo-grouped plugin commands, the app cwd otherwise. */
  cwd: string;
}

type Work = (sink: TargetSink) => Promise<WorkOutcome>;

interface RunOptions {
  serial?: boolean;
  concurrency?: number;
  /** The instance target strings are read from; base when absent. */
  instance?: string;
  /** Settle each started target on ready rather than on running. */
  wait?: boolean;
}

type Gate =
  | { kind: "ready" }
  | { kind: "aborted" }
  | { kind: "crashed"; dep: TargetId }
  | { kind: "timeout"; dep: TargetId; timeoutMs: number };

/**
 * What a start pass hands the supervisor per target.
 *
 * `app:start` supervises each target's own `start` script; a `kind: "service"`
 * config command supervises its resolved per-target script instead (SPEC §2.5).
 * Everything else about the pass — ordering, readiness gating, hooks — is the
 * same, so the difference is captured here rather than in a second pass.
 */
interface StartPlan {
  /** The script to supervise, or `null` when this target is skipped. */
  script(id: TargetId): string | null;
  /** The command claiming the process; absent for `app:start`. */
  via?: string;
  /** Why a `null` script skipped the target, and how its dependents read it. */
  skip: { error(id: TargetId): string; blocked: string };
}

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
        exec(cmd, { cwd: pt.cwd, env: pt.app.env, signal: rec.controller.signal, ...opts }),
      command: rec.command,
      runId: rec.runId,
      repo: toRepoInfo(pt.repo),
      target: toTargetInfo(pt.app),
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
    const app = findApp(workspace.current(), id);
    return app ? toTargetInfo(app) : undefined;
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
      runShell: (script, extraEnv) =>
        runScript({
          script,
          cwd: pt.cwd,
          env: { ...targetEnv(pt.app.env), ...extraEnv },
          signal: rec.controller.signal,
          stopTimeoutMs: pt.app.stopTimeoutMs,
          logger: log,
          onLine: (stream, text, ts) => {
            sink.line(stream, text, ts);
          },
        }),
      context: (plugin, phase, result) => hookContext(plugin, rec, pt, phase, result),
      note: (text) => {
        sink.note(text);
      },
      signal: rec.controller.signal,
    };

    const startedAt = Date.now();
    let state: TaskTargetState = "failed";
    let exitCode: number | null | undefined;
    let error: string | undefined;

    try {
      const abortReason = await runPreHooks(hooks.config.pre, hooks.bound, pipeline);
      // Re-checked here, not only on entry: a pre hook takes time, and a
      // `cancelAll` landing while it runs means the shutdown has already
      // snapshotted what to stop. Spawning the work now would put a process
      // outside everything that is being torn down — an orphan forever.
      if (rec.controller.signal.aborted) {
        state = "aborted";
        exitCode = null;
        error = rec.cancelReason ?? "run cancelled";
      } else if (abortReason !== undefined) {
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
        const postError = await runPostHooks(
          hooks.config.post,
          hooks.bound,
          result,
          pipeline,
          postHookEnv({ command: rec.command, targetId: pt.id, status: state, result }),
        );
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

  /**
   * Stand-in definition for a target the config dropped while its process kept
   * running. It carries only what the stop pipeline needs — an id, a cwd for
   * hooks, the workspace stop timeout — and deliberately no scripts, env or
   * dependencies: those are exactly the things nothing remembers, and inventing
   * them would let a stop resurrect what it is tearing down.
   */
  function orphanApp(ws: NormalizedWorkspace, id: TargetId): NormalizedApp {
    // The id is all that is left of it, so its place in the workspace is read
    // back out of the id: `platform.shell@feat-x`.
    const { name: baseId, instance } = splitQualified(id);
    const dot = baseId.indexOf(".");
    return {
      id,
      baseId,
      instance,
      repoName: qualify(dot === -1 ? baseId : baseId.slice(0, dot), instance),
      name: dot === -1 ? baseId : baseId.slice(dot + 1),
      implicit: dot === -1,
      cwd: ws.rootDir,
      scripts: {},
      env: {},
      ports: {},
      dependsOn: [],
      restart: "no",
      readyTimeoutMs: ws.limits.readyTimeoutMs,
      stopTimeoutMs: ws.limits.stopTimeoutMs,
      lifecycle: { init: [], teardown: [] },
    };
  }

  function pipelineTarget(ws: NormalizedWorkspace, app: NormalizedApp, cwd?: string): PipelineTarget {
    const repo: NormalizedRepo = findRepo(ws, app.repoName) ?? {
      name: app.repoName,
      baseName: splitQualified(app.repoName).name,
      instance: app.instance,
      path: app.cwd,
      basePath: app.cwd,
      lifecycle: { copy: [], init: [], teardown: [] },
      apps: [app],
    };
    return { id: app.id, app, repo, cwd: cwd ?? app.cwd };
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

  /**
   * What an untargeted command means: the active profile in base, and every app
   * the instance runs anywhere else — an instance *is* its selection, so it has
   * no profile of its own to consult.
   */
  function defaultIds(ws: NormalizedWorkspace, instance: string): TargetId[] {
    return instance === BASE_INSTANCE ? profileTargets(ws, deps.activeProfile()) : instanceTargets(ws, instance);
  }

  function selectedIds(
    ws: NormalizedWorkspace,
    targets: readonly string[] | undefined,
    instance: string = BASE_INSTANCE,
  ): TargetId[] {
    if (!targets || targets.length === 0) return defaultIds(ws, instance);
    return resolveTargetStrings(ws, targets, instance);
  }

  /**
   * Targets the supervisor still owns a process for that the config has dropped,
   * as seen from `instance`. Base also answers for processes whose instance no
   * longer exists at all: nothing else is left that could name them.
   */
  function orphanIds(ws: NormalizedWorkspace, instance: string): TargetId[] {
    return supervisor
      .states()
      .filter((s) => s.status !== "stopped" && findApp(ws, s.targetId) === undefined)
      .map((s) => s.targetId)
      .filter((id) => {
        const owner = splitQualified(id).instance;
        return owner === instance || (instance === BASE_INSTANCE && findInstance(ws, owner) === undefined);
      });
  }

  /**
   * Target resolution for stop, widened by whatever the supervisor is still
   * running.
   *
   * A reload leaves running processes untouched (SPEC §8), so deleting a repo
   * from `u8.jsonc` while it runs produces a target the config cannot name.
   * Resolving stop against the config alone would answer `UNKNOWN_TARGET` for it
   * and leave it out of an unqualified "stop everything" — an orphan surviving
   * until the daemon exits. Start and run stay strict on purpose: nothing in the
   * config says what they would run.
   */
  function selectedStopIds(
    ws: NormalizedWorkspace,
    targets: readonly string[] | undefined,
    instance: string = BASE_INSTANCE,
  ): TargetId[] {
    if (targets === undefined || targets.length === 0) {
      // An instance that is already gone from the config has no default
      // selection left, and its processes are exactly what must still stop.
      const selected = findInstance(ws, instance) === undefined ? [] : defaultIds(ws, instance);
      for (const id of orphanIds(ws, instance)) if (!selected.includes(id)) selected.push(id);
      return selected;
    }

    const out: TargetId[] = [];
    for (const spec of targets) {
      // A repo name keeps covering the apps it used to have, including when
      // the repo itself survived the reload and only one of its apps did not.
      // Matched in qualified form, so `platform` typed in an instance covers
      // `platform.shell@feat-x` and never base's `platform.shell`.
      const wanted = splitQualified(qualifyTarget(spec, instance));
      const ids = [
        ...(expandTarget(ws, spec, instance) ?? []),
        ...orphanIds(ws, wanted.instance).filter((id) => {
          const orphan = splitQualified(id);
          return (
            orphan.instance === wanted.instance &&
            (orphan.name === wanted.name || orphan.name.startsWith(`${wanted.name}.`))
          );
        }),
      ];
      if (ids.length === 0) {
        throw new U8Error("UNKNOWN_TARGET", unknownTargetMessage(ws, spec, instance), { spec, instance });
      }
      for (const id of ids) if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * Reverse-dependency stop waves, with the targets the config no longer knows
   * going down first: nothing left in the config says what depends on them, and
   * a wave they cannot appear in is the only alternative.
   */
  function stopWaves(ws: NormalizedWorkspace, ids: readonly TargetId[]): TargetId[][] {
    const known = ids.filter((id) => findApp(ws, id) !== undefined);
    const orphans = ids.filter((id) => findApp(ws, id) === undefined);
    const waves = [...topoWaves(ws, known)].reverse();
    return orphans.length > 0 ? [orphans, ...waves] : waves;
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
        const app = findApp(ws, id);
        const script = scripts.get(id);
        if (!app || script === undefined) {
          finish(rec, id, "skipped", { error: `no script for "${id}" in command "${cmd.name}"` });
          continue;
        }
        const pt = pipelineTarget(ws, app);
        tasks.push(async () => {
          await runPipeline(rec, pt, hooks, async (sink) => {
            const outcome = await runScript({
              script,
              cwd: pt.cwd,
              env: targetEnv(app.env),
              signal: rec.controller.signal,
              stopTimeoutMs: app.stopTimeoutMs,
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
   * `groupBy: "repo"` it runs once per repo instead — the first selected app of
   * each repo represents it and the command's cwd becomes the repo root, which is
   * what `git:pull` needs to avoid fetching the same repo four times.
   */
  function runPluginCommand(bound: BoundCommand, ids: TargetId[], opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const rec = createRun(bound.name, ids);
    const concurrency = concurrencyFor(ws, undefined, opts);
    const hooks = hooksOf(ws, bound.name);
    const byRepo = bound.def.groupBy === "repo";
    const representatives = new Map<string, TargetId>();

    return launch(rec, async () => {
      const tasks: Array<() => Promise<void>> = [];
      for (const id of ids) {
        const app = findApp(ws, id);
        if (!app) {
          finish(rec, id, "skipped", { error: `unknown target "${id}"` });
          continue;
        }
        if (!applies(bound, app)) {
          finish(rec, id, "skipped", { error: `command "${bound.name}" does not apply to this target` });
          continue;
        }
        if (byRepo) {
          const seen = representatives.get(app.repoName);
          if (seen !== undefined) {
            finish(rec, id, "skipped", { error: `covered by "${seen}" — "${bound.name}" runs once per repo` });
            continue;
          }
          representatives.set(app.repoName, id);
        }

        const pt = pipelineTarget(ws, app, byRepo ? findRepo(ws, app.repoName)?.path : undefined);
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

  function applies(bound: BoundCommand, app: NormalizedApp): boolean {
    if (!bound.def.appliesTo) return true;
    try {
      return bound.def.appliesTo(toTargetInfo(app)) !== false;
    } catch (err) {
      log.warn(`appliesTo of "${bound.name}" threw for ${app.id}: ${errorMessage(err)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Core service commands
  // -------------------------------------------------------------------------

  /**
   * True once a dependency counts as ready (SPEC §5.4): a plugin verdict when
   * one is offered — that is the healthcheck path — and otherwise "it runs".
   *
   * "Runs" is deliberately `running`, not {@link Supervisor.isRunning}: the
   * supervisor counts `starting` as up for its own bookkeeping, but a process
   * still inside its start grace has not survived long enough to be depended
   * on, and treating it as ready makes the readiness timeout unreachable for
   * every dependency without a healthcheck — which is the default.
   */
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
    return supervisor.state(id).status === "running";
  }

  /**
   * A crashed dependency is only a dead end if nothing will bring it back: with
   * `restart: "on-crash"` the backoff ladder is still working on it, and giving
   * up on the first crash would break exactly the services that opted into
   * being restarted.
   */
  function willNeverBecomeReady(ws: NormalizedWorkspace, dep: TargetId): boolean {
    return supervisor.state(dep).status === "crashed" && findApp(ws, dep)?.restart !== "on-crash";
  }

  /** Polls every dependency until it is ready, the run is cancelled, or it times out. */
  async function awaitDependencies(rec: RunRecord, dependencies: readonly TargetId[]): Promise<Gate> {
    for (const dep of dependencies) {
      const ws = workspace.current();
      const timeoutMs = findApp(ws, dep)?.readyTimeoutMs ?? ws.limits.readyTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (rec.controller.signal.aborted) return { kind: "aborted" };
        if (await isReady(dep)) break;
        // Sitting out the full readiness timeout for something that already
        // died tells the user nothing they could not have been told at once.
        if (willNeverBecomeReady(ws, dep)) return { kind: "crashed", dep };
        if (Date.now() >= deadline) return { kind: "timeout", dep, timeoutMs };
        await delay(Math.min(readinessPollMs, Math.max(1, deadline - Date.now())), rec.controller.signal);
      }
    }
    return { kind: "ready" };
  }

  /** `app:start`: every target runs its own `start` script. */
  function coreStartPlan(ws: NormalizedWorkspace): StartPlan {
    return {
      script: (id) => coreStartScript(ws, id),
      skip: { error: (id) => `no "start" script for "${id}"`, blocked: "has no start script" },
    };
  }

  /**
   * A `kind: "service"` config command: the command's per-target script becomes
   * the supervised process. Resolution stays {@link commandTargets}, so a `null`
   * entry and a target with no script at all are skips here too — a service
   * command must never fall back to the target's own `start` script.
   */
  function serviceCommandPlan(
    ws: NormalizedWorkspace,
    cmd: NormalizedCommand,
    ids: readonly TargetId[],
  ): StartPlan {
    const scripts = new Map(commandTargets(ws, cmd, ids).map((t) => [t.targetId, t.script]));
    return {
      script: (id) => scripts.get(id) ?? null,
      via: cmd.name,
      skip: {
        error: (id) => `no script for "${id}" in command "${cmd.name}"`,
        blocked: `has no script in command "${cmd.name}"`,
      },
    };
  }

  /**
   * Dependency-ordered start (SPEC §5.4), shared by `app:start`, the start half
   * of `app:restart`, and every `kind: "service"` config command — the
   * {@link StartPlan} is the only thing that differs between them.
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
    plan: StartPlan,
    wait = false,
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

        const app = findApp(ws, id);
        if (!app) {
          finish(rec, id, "failed", { error: `unknown target "${id}"` });
          blocked.set(id, "unknown target");
          return;
        }

        const dependencies = app.dependsOn.filter((d) => d !== id && selected.has(d));
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
        if (gate.kind === "crashed") {
          // Nothing was attempted for this target, so it is `skipped` rather
          // than `failed`: the failure is the dependency's, and it is reported
          // as such on its own row.
          const message = `not started: dependency "${gate.dep}" crashed`;
          log.warn(`${id}: ${message}`);
          finish(rec, id, "skipped", { error: message });
          blocked.set(id, `was skipped (dependency "${gate.dep}" crashed)`);
          return;
        }
        if (gate.kind === "timeout") {
          const message = `dependency "${gate.dep}" did not become ready within ${gate.timeoutMs}ms`;
          log.warn(`${id}: ${message}`);
          finish(rec, id, "failed", { error: message });
          blocked.set(id, "never became ready");
          return;
        }

        const script = plan.script(id);
        if (script === null) {
          finish(rec, id, "skipped", { error: plan.skip.error(id) });
          blocked.set(id, plan.skip.blocked);
          return;
        }

        const state = await runPipeline(rec, pipelineTarget(ws, app), hooks, async (sink) => {
          try {
            // `app:start` lets the supervisor resolve the script itself, so its
            // spawn-time fingerprint stays the one a reload compares against.
            await supervisor.start(id, plan.via === undefined ? undefined : { script, via: plan.via });
            // `start` resolves at the spawn, while the status is still
            // `starting`; SPEC §2.5 says a service is done when it is running,
            // so the verdict is whatever it settles on. Waves already run in
            // parallel, so a whole profile pays the start grace once.
            const service = await supervisor.waitForSettled(id);
            if (service.status === "crashed") {
              const message = service.lastError ?? "service crashed during start";
              sink.note(message);
              return { state: "failed", exitCode: service.exitCode ?? null, error: message };
            }
            if (wait) {
              const gate = await awaitDependencies(rec, [id]);
              if (gate.kind !== "ready") {
                // The process is left as it is: a service that is up but not
                // yet healthy is something to read the log of, not to kill.
                const message =
                  gate.kind === "aborted"
                    ? (rec.cancelReason ?? "run cancelled before it became ready")
                    : gate.kind === "crashed"
                      ? (supervisor.state(id).lastError ?? "service crashed before it became ready")
                      : `started, but did not become ready within ${gate.timeoutMs}ms`;
                sink.note(message);
                return { state: "failed", exitCode: supervisor.state(id).exitCode ?? null, error: message };
              }
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

  /**
   * Reverse-dependency-ordered stop: dependents go down before what they need.
   *
   * Unlike the start passes this one accepts targets the config no longer
   * declares — see {@link selectedStopIds} — so a dropped target still travels
   * the whole pipeline, standing on {@link orphanApp}.
   */
  async function stopPass(rec: RunRecord, ids: readonly TargetId[], concurrency: number): Promise<void> {
    const ws = workspace.current();
    const hooks = hooksOf(ws, rec.command);

    for (const wave of stopWaves(ws, ids)) {
      const tasks = wave.map((id) => async () => {
        const app = findApp(ws, id) ?? orphanApp(ws, id);
        log.debug(`stopping ${id}`, { customStopScript: coreStopScript(ws, id) !== null });
        await runPipeline(rec, pipelineTarget(ws, app), hooks, async (sink) => {
          try {
            await supervisor.stop(id, { timeoutMs: app.stopTimeoutMs });
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
        const app = findApp(ws, id);
        if (!app) {
          finish(rec, id, "failed", { error: `unknown target "${id}"` });
          blocked.set(id, "unknown target");
          return;
        }
        progress(rec, id, "running");
        try {
          await supervisor.stop(id, { timeoutMs: app.stopTimeoutMs });
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
  // Instance lifecycle
  // -------------------------------------------------------------------------

  /**
   * What a lifecycle step is told about where it runs. An app's own env is
   * already whatever the config says; these are the facts no config value
   * carries for a repo-level step, which has no app to borrow an env from.
   */
  function lifecycleEnv(ws: NormalizedWorkspace, repo: NormalizedRepo, app?: NormalizedApp): Record<string, string> {
    // A repo that is its own app shares everything with it, env included.
    const only = repo.apps.length === 1 ? repo.apps[0] : undefined;
    const source = app ?? (only?.implicit === true ? only : undefined);
    return {
      ...targetEnv(source?.env ?? {}),
      U8_INSTANCE: repo.instance,
      U8_REPO: repo.baseName,
      U8_REPO_PATH: repo.path,
      U8_BASE_PATH: repo.basePath,
      U8_WORKSPACE_ROOT: ws.rootDir,
      ...(app === undefined ? {} : { U8_TARGET: app.id, U8_APP: app.name }),
    };
  }

  /**
   * Runs shell steps in order. `keepGoing` is for teardown: a step that fails
   * to undo one thing must not be the reason the next thing is left behind, so
   * every step runs and the first failure is what gets reported.
   */
  async function runSteps(
    rec: RunRecord,
    sink: TargetSink,
    steps: readonly string[],
    where: { cwd: string; env: Record<string, string>; stopTimeoutMs: number },
    keepGoing: boolean,
  ): Promise<WorkOutcome> {
    let failure: WorkOutcome | undefined;
    for (const step of steps) {
      if (rec.controller.signal.aborted) break;
      sink.note(`$ ${step}`);
      const outcome = await runScript({
        script: step,
        cwd: where.cwd,
        env: where.env,
        signal: rec.controller.signal,
        stopTimeoutMs: where.stopTimeoutMs,
        logger: log,
        onLine: (stream, text, ts) => {
          sink.line(stream, text, ts);
        },
      });
      if (outcome.ok) continue;
      const message = `${describeExit(outcome)}: ${step}`;
      sink.note(message);
      failure ??= { state: "failed", exitCode: outcome.exitCode, error: message };
      if (!keepGoing) break;
    }
    return failure ?? { state: "ok", exitCode: 0 };
  }

  /**
   * Brings over what git does not carry into a new worktree. Nothing is ever
   * overwritten: on a re-init the file in the checkout is the one somebody has
   * been editing, and base's copy is not more correct than theirs.
   */
  async function copyFromBase(repo: NormalizedRepo, sink: TargetSink): Promise<WorkOutcome> {
    if (repo.path === repo.basePath) return { state: "ok", exitCode: 0 };
    for (const rel of repo.lifecycle.copy) {
      const source = path.resolve(repo.basePath, rel);
      const target = path.resolve(repo.path, rel);
      if (!isWithin(source, repo.basePath) || !isWithin(target, repo.path)) {
        const message = `copy "${rel}" points outside the repo`;
        sink.note(message);
        return { state: "failed", exitCode: null, error: message };
      }
      try {
        if (!existsSync(source)) {
          sink.note(`copy ${rel}: not in the base checkout, skipped`);
          continue;
        }
        if (existsSync(target)) {
          sink.note(`copy ${rel}: already here, kept`);
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
        sink.note(`copy ${rel}`);
      } catch (err) {
        const message = `copy "${rel}" failed: ${errorMessage(err)}`;
        sink.note(message);
        return { state: "failed", exitCode: null, error: message };
      }
    }
    return { state: "ok", exitCode: 0 };
  }

  /**
   * A checkout that is already gone cannot host its own teardown, but what
   * teardown undoes — a database, a compose project — is usually still there.
   * The base checkout is the same code, and the env is still the instance's.
   */
  function teardownCwd(sink: TargetSink, dir: string, fallback: string): string {
    if (describeDirectory(dir) === undefined) return dir;
    sink.note(`${dir} is gone; running from ${fallback} instead`);
    return fallback;
  }

  /** Stops what the instance runs without settling any target: teardown owns the results. */
  async function stopForTeardown(ws: NormalizedWorkspace, ids: readonly TargetId[]): Promise<void> {
    for (const wave of stopWaves(ws, ids)) {
      await Promise.all(
        wave.map(async (id) => {
          try {
            await supervisor.stop(id, { timeoutMs: findApp(ws, id)?.stopTimeoutMs ?? ws.limits.stopTimeoutMs });
          } catch (err) {
            log.warn(`stopping ${id} before teardown failed: ${errorMessage(err)}`);
          }
        }),
      );
    }
  }

  /**
   * `instance:init` and `instance:teardown`.
   *
   * Repos run side by side; within one, order is the point. Init runs the
   * repo's steps in the checkout root first — an install at the root is what
   * every app's own step stands on — then each app's. Teardown is the mirror
   * image. The repo's steps are reported on its first app: a run's rows are
   * targets, and a repo is not one.
   */
  function runLifecycle(phase: LifecyclePhase, instanceName: string, opts: LifecycleOptions = {}): RunHandle {
    const ws = workspace.current();
    // An instance the workspace no longer knows — its record names nothing the
    // config still has — runs no steps, but must still be destroyable: what is
    // left of it is whatever the supervisor is running and what `finalize` does.
    const ids = findInstance(ws, instanceName) ? instanceTargets(ws, instanceName) : [];
    const command = `instance:${phase}`;
    const rec = createRun(command, ids);
    const hooks = hooksOf(ws, command);
    const repos = ws.repos.filter((r) => r.instance === instanceName);

    const initRepo = async (repo: NormalizedRepo): Promise<void> => {
      const [first, ...rest] = repo.apps;
      if (!first) return;
      let repoReady = false;
      await runPipeline(rec, pipelineTarget(ws, first), hooks, async (sink) => {
        const copied = await copyFromBase(repo, sink);
        if (copied.state !== "ok") return copied;
        const where = { cwd: repo.path, env: lifecycleEnv(ws, repo), stopTimeoutMs: first.stopTimeoutMs };
        const repoSteps = await runSteps(rec, sink, repo.lifecycle.init, where, false);
        if (repoSteps.state !== "ok") return repoSteps;
        repoReady = true;
        return runSteps(
          rec,
          sink,
          first.lifecycle.init,
          { cwd: first.cwd, env: lifecycleEnv(ws, repo, first), stopTimeoutMs: first.stopTimeoutMs },
          false,
        );
      });
      for (const app of rest) {
        if (!repoReady) {
          finish(rec, app.id, "skipped", { error: `not initialised: the steps of "${repo.baseName}" did not complete` });
          continue;
        }
        await runPipeline(rec, pipelineTarget(ws, app), hooks, (sink) =>
          runSteps(
            rec,
            sink,
            app.lifecycle.init,
            { cwd: app.cwd, env: lifecycleEnv(ws, repo, app), stopTimeoutMs: app.stopTimeoutMs },
            false,
          ),
        );
      }
    };

    const teardownRepo = async (repo: NormalizedRepo): Promise<void> => {
      const [first, ...rest] = repo.apps;
      if (!first) return;
      const appSteps = (app: NormalizedApp, sink: TargetSink): Promise<WorkOutcome> =>
        runSteps(
          rec,
          sink,
          app.lifecycle.teardown,
          {
            cwd: teardownCwd(sink, app.cwd, path.resolve(repo.basePath, path.relative(repo.path, app.cwd))),
            env: lifecycleEnv(ws, repo, app),
            stopTimeoutMs: app.stopTimeoutMs,
          },
          true,
        );
      for (const app of [...rest].reverse()) {
        await runPipeline(rec, pipelineTarget(ws, app), hooks, (sink) => appSteps(app, sink));
      }
      await runPipeline(rec, pipelineTarget(ws, first), hooks, async (sink) => {
        const own = await appSteps(first, sink);
        const repoSteps = await runSteps(
          rec,
          sink,
          repo.lifecycle.teardown,
          {
            cwd: teardownCwd(sink, repo.path, repo.basePath),
            env: lifecycleEnv(ws, repo),
            stopTimeoutMs: first.stopTimeoutMs,
          },
          true,
        );
        return own.state !== "ok" ? own : repoSteps;
      });
    };

    return launch(rec, async () => {
      if (opts.stopFirst === true) {
        const running = [...ids];
        for (const id of orphanIds(ws, instanceName)) if (!running.includes(id)) running.push(id);
        await stopForTeardown(ws, running);
      }

      const each = phase === "init" ? initRepo : teardownRepo;
      await runPool(
        repos.map((repo) => () => each(repo)),
        concurrencyFor(ws, undefined, {}),
      );

      if (opts.finalize === undefined) return;
      const ok = ids.every((id) => {
        const state = rec.results.get(id)?.state;
        return state === "ok" || state === "skipped";
      });
      try {
        await opts.finalize(ok);
      } catch (err) {
        // The steps' own verdicts stand where they failed; a target that had
        // succeeded is failed here, because the run as a whole did not do
        // what it was asked.
        const message = errorMessage(err);
        log.error(`finishing ${command} for "${instanceName}" failed: ${message}`);
        for (const id of ids) {
          const existing = rec.results.get(id);
          if (existing && existing.state !== "ok" && existing.state !== "skipped") continue;
          rec.results.set(id, { targetId: id, durationMs: existing?.durationMs ?? 0, state: "failed", error: message });
          progress(rec, id, "failed", { error: message });
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  function startRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedIds(ws, targets, opts.instance);
    const rec = createRun("app:start", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:start"), opts);
    return launch(rec, () => startPass(rec, ids, concurrency, new Map(), coreStartPlan(ws), opts.wait));
  }

  /**
   * A `kind: "service"` config command (SPEC §2.5). It takes the `app:start`
   * path in full — dependency ordering, readiness gating, its own hooks — and
   * differs only in the script each target is supervised from, which is why the
   * supervisor is told the command name: the process it owns is that command's.
   */
  function runServiceCommand(cmd: NormalizedCommand, ids: TargetId[], opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const rec = createRun(cmd.name, ids);
    const concurrency = concurrencyFor(ws, cmd, opts);
    const plan = serviceCommandPlan(ws, cmd, ids);
    return launch(rec, () => startPass(rec, ids, concurrency, new Map(), plan, opts.wait));
  }

  function stopRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedStopIds(ws, targets, opts.instance);
    const rec = createRun("app:stop", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:stop"), opts);
    return launch(rec, () => stopPass(rec, ids, concurrency));
  }

  function restartRun(targets: string[] | undefined, opts: RunOptions): RunHandle {
    const ws = workspace.current();
    const ids = selectedIds(ws, targets, opts.instance);
    const rec = createRun("app:restart", ids);
    const concurrency = concurrencyFor(ws, findCommand(ws, "app:restart"), opts);
    return launch(rec, async () => {
      const blocked = new Map<TargetId, string>();
      await restartStopPass(rec, ids, concurrency, blocked);
      await startPass(rec, ids, concurrency, blocked, coreStartPlan(ws), opts.wait);
    });
  }

  return {
    runCommand(opts: RunCommandOptions): RunHandle {
      const runOpts: RunOptions = {
        serial: opts.serial,
        concurrency: opts.concurrency,
        instance: opts.instance,
        wait: opts.wait,
      };
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
      const ids = selectedIds(ws, opts.targets, opts.instance);

      const plugin = plugins.commands().find((c) => c.name === opts.command);
      if (plugin) return runPluginCommand(plugin, ids, runOpts);

      const cmd = findCommand(ws, opts.command);
      if (!cmd) {
        throw new U8Error("UNKNOWN_COMMAND", `unknown command "${opts.command}"`, { command: opts.command });
      }
      // SPEC §2.5: "service" means the spawned process is registered with the
      // supervisor, so the command claims the target's one process instead of
      // running to completion.
      if (cmd.kind === "service") return runServiceCommand(cmd, ids, runOpts);
      return runConfigCommand(cmd, ids, runOpts);
    },

    startTargets(targets?: string[], scope: StartScope = {}): RunHandle {
      return startRun(targets, scope);
    },

    stopTargets(targets?: string[], scope: TargetScope = {}): RunHandle {
      return stopRun(targets, scope);
    },

    restartTargets(targets?: string[], scope: StartScope = {}): RunHandle {
      return restartRun(targets, scope);
    },

    runLifecycle,

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

    /**
     * A run closes only after every process it owns has exited, because each
     * target awaits its script's `exited` — including the SIGTERM → SIGKILL
     * escalation `cancelAll` sets off. So waiting for the runs is waiting for
     * the processes, and the bound is there for the one case that cannot be
     * waited out: a plugin command that ignores its abort signal.
     */
    async drain(timeoutMs: number): Promise<void> {
      const pending = [...runs.values()].filter((rec) => !rec.finished).map((rec) => rec.done);
      if (pending.length === 0) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, timeoutMs));
            // Draining is the last thing a dying daemon does; the timer must
            // not be the reason the process outlives it.
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const stuck = [...runs.values()].filter((rec) => !rec.finished);
      if (stuck.length > 0) {
        log.warn(`drain gave up after ${timeoutMs}ms with ${stuck.length} run(s) still in flight`);
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

/** True when `candidate` is `root` or somewhere beneath it. */
function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
