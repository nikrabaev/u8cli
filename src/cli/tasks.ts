/**
 * `u8 start|stop|restart` and `u8 run <command>` — the four commands that make
 * something happen and then have to say what happened.
 *
 * All four share one shape, which is what this module is: launch a run, stream
 * `task.progress` as each target settles, print a summary table, and exit
 * `0`/`1` on the aggregate. The exit code is the point — it is what makes u8
 * usable in CI, so it is derived from `TaskResult.ok` (any `failed`/`aborted`
 * target fails the run) and never from what got printed.
 *
 * Three deliberate details:
 *  - **The request deadline is disabled.** `run.await` resolves when the work
 *    does; a task legitimately outlives any timeout worth configuring.
 *  - **Ctrl-C detaches, it does not cancel.** The run belongs to the daemon
 *    (SPEC §5.1: processes survive the terminal), so an interrupt stops the
 *    printing and says where to pick the run back up.
 *  - **Every `u8 logs` command printed here must lead to the output**, which is
 *    why {@link outputLocation} exists: a summary that sends a first-time user
 *    to an empty log is worse than printing nothing at all.
 */
import type { CommandKind } from "../config/index.js";
import type { AttachedClient } from "../daemon/index.js";
import type {
  Snapshot,
  TaskProgress,
  TaskResult,
  TaskTargetResult,
  TaskTargetState,
} from "../ipc/protocol.js";
import { U8Error } from "../util/errors.js";
import { withAttached, type CliContext } from "./context.js";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "./errors.js";
import { formatDuration, oneLine, paintState, renderTable, STATE_SYMBOL } from "./format.js";
import { writeLine, writeLines } from "./io.js";

/** Which run to launch. `run` carries the knobs only `u8 run` exposes. */
export type TaskSpec =
  | { kind: "start" | "stop" | "restart" }
  | { kind: "run"; command: string; serial?: boolean; concurrency?: number };

export interface TaskOptions {
  /** Target strings as typed; empty means "the active profile". */
  targets: readonly string[];
  /** Every target in the workspace, rather than the active profile. */
  all?: boolean;
}

/** States worth a line while the run is in flight: the ones that are final. */
const TERMINAL: ReadonlySet<TaskTargetState> = new Set<TaskTargetState>([
  "ok",
  "failed",
  "skipped",
  "aborted",
]);

export async function taskCommand(ctx: CliContext, spec: TaskSpec, opts: TaskOptions): Promise<number> {
  if (opts.all === true && opts.targets.length > 0) {
    throw new U8Error("UNKNOWN_TARGET", "--all cannot be combined with explicit targets");
  }

  return withAttached(ctx, { requestTimeoutMs: 0 }, async (attached) => {
    const targets = selectTargets(attached.snapshot(), opts);
    const printer = createProgressPrinter(ctx);
    /** Set the moment the run is accepted; progress for other runs is ignored. */
    let runId: string | undefined;

    const offProgress = attached.on("task.progress", ({ progress }) => {
      if (progress.runId === runId) printer.push(progress);
    });
    // A daemon that goes away mid-run would otherwise leave the CLI waiting on a
    // promise the transport has already rejected; this makes the reason visible.
    const offShutdown = attached.on("daemon.shutdown", ({ reason }) => {
      writeLine(ctx.io.stderr, ctx.style.yellow(`the daemon is shutting down (${reason})`));
    });

    try {
      runId = (await launch(attached, spec, targets)).runId;
      const result = await settle(ctx, attached, runId);
      if (result === undefined) {
        writeLine(
          ctx.io.stderr,
          ctx.style.dim(`detached — the run continues in the background (u8 status, u8 logs --run ${runId})`),
        );
        return EXIT_INTERRUPTED;
      }
      printer.flush(result);
      printSummary(ctx, result, commandKind(attached.snapshot(), result.command));
      return result.ok ? 0 : EXIT_FAILURE;
    } finally {
      offProgress();
      offShutdown();
    }
  });
}

function selectTargets(snapshot: Snapshot, opts: TaskOptions): string[] | undefined {
  if (opts.all === true) return snapshot.repos.flatMap((repo) => repo.apps.map((a) => a.id));
  return opts.targets.length === 0 ? undefined : [...opts.targets];
}

async function launch(
  attached: AttachedClient,
  spec: TaskSpec,
  targets: string[] | undefined,
): Promise<{ runId: string }> {
  switch (spec.kind) {
    case "start":
      return attached.client.request("service.start", { targets });
    case "stop":
      return attached.client.request("service.stop", { targets });
    case "restart":
      return attached.client.request("service.restart", { targets });
    case "run":
      return attached.client.request("command.run", {
        command: spec.command,
        targets,
        serial: spec.serial,
        concurrency: spec.concurrency,
      });
  }
}

/** The result, or `undefined` when the user interrupted before it arrived. */
async function settle(
  ctx: CliContext,
  attached: AttachedClient,
  runId: string,
): Promise<TaskResult | undefined> {
  const pending = attached.client.request("run.await", { runId });
  // Registered before the race so abandoning it on an interrupt cannot surface
  // as an unhandled rejection when the client is closed underneath it.
  pending.catch(() => undefined);

  const signal = ctx.io.signal;
  if (signal === undefined) return pending;
  if (signal.aborted) return undefined;

  const interrupted = new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  return Promise.race([pending, interrupted]);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface ProgressPrinter {
  push(progress: TaskProgress): void;
  /** Prints anything the stream never reported (a dropped notification). */
  flush(result: TaskResult): void;
}

/**
 * One line per target as it settles.
 *
 * Target names are padded to the widest one *announced so far* — the engine
 * emits `pending` for every selected target before any work starts, so by the
 * time the first result lands the column width is already final.
 */
function createProgressPrinter(ctx: CliContext): ProgressPrinter {
  const seen = new Set<string>();
  const printed = new Set<string>();
  let width = 0;

  const line = (
    targetId: string,
    state: TaskTargetState,
    durationMs: number | undefined,
    exitCode: number | null | undefined,
    error: string | undefined,
  ): void => {
    if (printed.has(targetId)) return;
    printed.add(targetId);
    const detail = describe(state, exitCode, error);
    const parts = [
      paintState(ctx.style, state, STATE_SYMBOL[state]),
      padName(targetId, width),
      paintState(ctx.style, state, state),
      ctx.style.dim(durationMs === undefined ? "" : formatDuration(durationMs)),
    ];
    const text = parts.join(" ").trimEnd();
    writeLine(ctx.io.stdout, detail === undefined ? text : `${text} ${ctx.style.dim(`— ${detail}`)}`);
  };

  return {
    push(progress: TaskProgress): void {
      if (!seen.has(progress.targetId)) {
        seen.add(progress.targetId);
        width = Math.max(width, progress.targetId.length);
      }
      if (!TERMINAL.has(progress.state)) return;
      line(progress.targetId, progress.state, progress.durationMs, progress.exitCode, progress.error);
    },
    flush(result: TaskResult): void {
      for (const target of result.targets) {
        width = Math.max(width, target.targetId.length);
      }
      for (const target of result.targets) {
        line(target.targetId, target.state, target.durationMs, target.exitCode, target.error);
      }
    },
  };
}

function padName(name: string, width: number): string {
  return name.length >= width ? name : name + " ".repeat(width - name.length);
}

/** The short "why" for a line: an exit code if there is one, else the error. */
function describe(
  state: TaskTargetState,
  exitCode: number | null | undefined,
  error: string | undefined,
): string | undefined {
  if (state === "ok") return undefined;
  const parts: string[] = [];
  if (typeof exitCode === "number" && exitCode !== 0) parts.push(`exit ${exitCode}`);
  if (error !== undefined && error.length > 0) parts.push(oneLine(error));
  return parts.length === 0 ? undefined : parts.join(": ");
}

/**
 * The kind of work a run did, which is the whole basis for where its output
 * went. `app:start|stop|restart` are `"service"` in the normalized model, so the
 * three core commands need no special case here — and a command the snapshot no
 * longer knows (a reload mid-run) reads as a task, which is the form that at
 * least names the run.
 */
function commandKind(snapshot: Snapshot, command: string): CommandKind {
  return snapshot.commands.find((c) => c.name === command)?.kind ?? "task";
}

/**
 * Where a target's output actually landed.
 *
 * A service command hands its process to the supervisor, which writes it to the
 * *service* log; the run log then holds nothing but u8's own one-line verdict
 * ("exited with code 3") — the very line the user just read in the summary. A
 * task runs to completion inside the run, so its run log is the whole story.
 *
 * `aborted` is the exception within a service run: the target never reached the
 * supervisor, so its service log describes some earlier run, while whatever
 * explains the abort — a pre hook's output — is in this run's log.
 */
function outputLocation(kind: CommandKind, state: TaskTargetState): "service" | "run" {
  return kind === "service" && state !== "aborted" ? "service" : "run";
}

function logsCommandFor(result: TaskResult, target: TaskTargetResult, kind: CommandKind): string {
  return outputLocation(kind, target.state) === "service"
    ? `u8 logs ${target.targetId}`
    : `u8 logs ${target.targetId} --run ${result.runId}`;
}

/** Failed targets worth naming before the list turns into wall of text. */
const MAX_HINTS = 3;

/**
 * One `u8 logs` command per failed target, each in the form that fits it — a
 * run can mix the two, since a pre hook can abort one target while another's
 * process dies on its own.
 */
function printFailureHints(ctx: CliContext, result: TaskResult, kind: CommandKind): void {
  const failed = result.targets.filter((t) => t.state === "failed" || t.state === "aborted");
  if (failed.length === 0) return;

  const label = "see the output with: ";
  const indent = " ".repeat(label.length);
  const shown = failed.slice(0, MAX_HINTS);
  const lines = shown.map(
    (target, i) => `${i === 0 ? label : indent}${logsCommandFor(result, target, kind)}`,
  );
  const rest = failed.length - shown.length;
  if (rest > 0) lines.push(`${indent}… and ${rest} more, listed above`);
  for (const line of lines) writeLine(ctx.io.stderr, ctx.style.dim(line));
}

/**
 * Where a *successful* task's output went.
 *
 * A task's stdout is captured, not streamed, so `u8 run build` prints a tidy
 * table and not one word of what the command actually said. One line naming a
 * target that ran is enough to find the rest; service runs get nothing, because
 * their output keeps flowing to a log the user already knows how to tail.
 */
function printOutputHint(ctx: CliContext, result: TaskResult, kind: CommandKind): void {
  if (kind !== "task") return;
  const ran = result.targets.find((t) => t.state === "ok");
  if (!ran) return;
  writeLine(
    ctx.io.stderr,
    ctx.style.dim(`output was captured per target: u8 logs ${ran.targetId} --run ${result.runId}`),
  );
}

function printSummary(ctx: CliContext, result: TaskResult, kind: CommandKind): void {
  if (result.targets.length === 0) {
    writeLine(ctx.io.stdout, `${result.command}: nothing to do ${ctx.style.dim(`(run ${result.runId})`)}`);
    return;
  }

  const rows = result.targets.map((target) => [
    target.targetId,
    paintState(ctx.style, target.state, `${STATE_SYMBOL[target.state]} ${target.state}`),
    formatDuration(target.durationMs),
    describe(target.state, target.exitCode, target.error) ?? "",
  ]);

  writeLine(ctx.io.stdout);
  writeLines(
    ctx.io.stdout,
    renderTable(rows, { head: [ctx.style.dim("TARGET"), ctx.style.dim("RESULT"), ctx.style.dim("TIME"), ctx.style.dim("DETAIL")] }),
  );

  const tally = new Map<TaskTargetState, number>();
  for (const target of result.targets) tally.set(target.state, (tally.get(target.state) ?? 0) + 1);
  const counts = [...tally].map(([state, n]) => paintState(ctx.style, state, `${n} ${state}`)).join(", ");
  const wall = formatDuration(result.finishedAt - result.startedAt);
  writeLine(
    ctx.io.stdout,
    `${result.command}: ${counts || "nothing to do"} ${ctx.style.dim(`in ${wall} (run ${result.runId})`)}`,
  );

  if (result.ok) printOutputHint(ctx, result, kind);
  else printFailureHints(ctx, result, kind);
}
