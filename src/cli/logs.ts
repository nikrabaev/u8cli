/**
 * `u8 logs <target> [-f] [-n N] [--run <runId>]`.
 *
 * Backfill comes from `logs.read` (the daemon owns the files) and `--follow`
 * continues from the live `log.line` push. Backfill is read *before* the
 * subscription goes in: the alternative ordering trades a one-RPC gap for
 * duplicated lines, and a log view that repeats itself is harder to trust than
 * one that might miss a line at the seam.
 *
 * A target that names a repo expands to all its apps, so the output is
 * prefixed with the target id whenever more than one stream is being shown —
 * and never when there is only one, because that prefix would just be noise in
 * front of every line of a `grep`.
 */
import { qualifyTarget } from "../config/index.js";
import type { AttachedClient } from "../daemon/index.js";
import type { LogLine, Snapshot } from "../ipc/protocol.js";
import { U8Error } from "../util/errors.js";
import { instanceIn, scopeOf, warnUnregistered, withAttached, type CliContext } from "./context.js";
import { EXIT_INTERRUPTED } from "./errors.js";
import { writeLine } from "./io.js";

export interface LogsOptions {
  follow?: boolean;
  /** Backfill size; `0` skips it entirely. */
  lines?: number;
  /** Read a task run's per-target log instead of the service log. */
  run?: string;
}

export async function logsCommand(ctx: CliContext, target: string, opts: LogsOptions): Promise<number> {
  const scope = scopeOf(ctx);
  warnUnregistered(ctx, scope);
  return withAttached(ctx, {}, async (attached) => {
    const instance = instanceIn(attached.snapshot(), scope);
    const ids = expandTarget(attached.snapshot(), target, instance.name);
    const prefixed = ids.length > 1;
    const print = (line: LogLine): void => {
      const prefix = prefixed ? `${ctx.style.dim(`${line.targetId} |`)} ` : "";
      writeLine(ctx.io.stdout, `${prefix}${line.text}`);
    };

    const backfill = opts.lines === 0 ? [] : await readBackfill(attached, ids, opts);
    for (const line of backfill) print(line);

    if (opts.follow !== true) {
      // Silence is ambiguous — an empty log and a wrong target id look the same
      // from here. The note goes to stderr so a pipe still sees log lines only.
      if (backfill.length === 0 && opts.lines !== 0) {
        writeLine(ctx.io.stderr, ctx.style.dim(emptyNote(target, opts)));
      }
      return 0;
    }
    return follow(ctx, attached, ids, opts, print);
  });
}

function emptyNote(target: string, opts: LogsOptions): string {
  return opts.run === undefined
    ? `no log lines for "${target}" yet — it has not run in this workspace`
    : `no log lines for "${target}" in run ${opts.run}`;
}

/**
 * App ids a target string covers — the client-side twin of `expandTarget`, read
 * from inside `instance` the same way: a bare name is that instance's copy.
 */
export function expandTarget(snapshot: Snapshot, spec: string, instance: string): string[] {
  const wanted = qualifyTarget(spec, instance);
  const apps = snapshot.repos.flatMap((repo) => repo.apps);
  if (apps.some((a) => a.id === wanted)) return [wanted];
  const repo = snapshot.repos.find((r) => r.name === wanted);
  if (repo) return repo.apps.map((a) => a.id);

  const inBase = !spec.includes("@") && apps.some((a) => a.id === spec || a.repoName === spec);
  const here = snapshot.repos.filter((r) => r.instance === instance);
  throw new U8Error(
    "UNKNOWN_TARGET",
    inBase
      ? `"${spec}" is not part of instance "${instance}", which uses base's — name it as "${spec}@base"`
      : `unknown target "${spec}" — expected a repo name or "repo.app"`,
    {
      spec,
      // De-duplicated: an implicit app's id *is* its repo name, and listing
      // "example, example" as the alternatives reads like a bug.
      known: [...new Set([...here.map((r) => r.baseName), ...here.flatMap((r) => r.apps.map((a) => a.baseId))])],
    },
  );
}

/**
 * Every target's tail, merged by timestamp. Sorting is what makes a multi-target
 * backfill readable: read per target, the same second would appear once per
 * stream in file order rather than in the order things happened.
 */
async function readBackfill(
  attached: AttachedClient,
  ids: readonly string[],
  opts: LogsOptions,
): Promise<LogLine[]> {
  const out: LogLine[] = [];
  for (const targetId of ids) {
    const { lines } = await attached.client.request("logs.read", {
      targetId,
      lines: opts.lines,
      runId: opts.run,
    });
    out.push(...lines);
  }
  return ids.length === 1 ? out : out.sort((a, b) => a.ts - b.ts);
}

/**
 * Streams until Ctrl-C or the daemon goes away. Every listener is torn down on
 * the way out — a follow that leaves one behind keeps the process alive after
 * the socket closes.
 */
async function follow(
  ctx: CliContext,
  attached: AttachedClient,
  ids: readonly string[],
  opts: LogsOptions,
  print: (line: LogLine) => void,
): Promise<number> {
  const wanted = new Set(ids);
  for (const targetId of ids) await attached.subscribe(targetId);

  const signal = ctx.io.signal;
  if (signal?.aborted === true) return EXIT_INTERRUPTED;

  return new Promise<number>((resolve) => {
    const disposers: Array<() => void> = [];
    const stop = (code: number): void => {
      for (const dispose of disposers.splice(0)) dispose();
      resolve(code);
    };

    disposers.push(
      attached.on("log.line", ({ line }) => {
        if (!wanted.has(line.targetId)) return;
        // A run's stream is only the lines that run produced; service lines
        // carry no runId and are filtered out of a `--run` follow.
        if (opts.run !== undefined && line.runId !== opts.run) return;
        print(line);
      }),
      attached.on("daemon.shutdown", ({ reason }) => {
        writeLine(ctx.io.stderr, ctx.style.dim(`daemon stopped (${reason})`));
        stop(0);
      }),
      // The message is not repeated here: the context's logger already put the
      // give-up reason on stderr when the re-attach loop ran out of attempts.
      attached.onLost(() => stop(EXIT_INTERRUPTED)),
    );

    if (signal !== undefined) {
      const onAbort = (): void => stop(EXIT_INTERRUPTED);
      signal.addEventListener("abort", onAbort, { once: true });
      disposers.push(() => signal.removeEventListener("abort", onAbort));
    }
  });
}
