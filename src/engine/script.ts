/**
 * Shell work for the engine: config command scripts and config hook strings.
 *
 * Built on {@link spawnManaged} rather than `exec` because a task's output has
 * to reach the run log and attached clients *while it runs* — a buffer handed
 * over at exit would make a five-minute build look hung. It also gives us the
 * process group, so cancelling a run kills the whole tree the script spawned.
 */
import type { LogStream } from "../ipc/protocol.js";
import { spawnManaged } from "../process/index.js";
import type { Logger } from "../util/logger.js";

export interface ScriptRun {
  script: string;
  cwd: string;
  env: Record<string, string>;
  /** Aborting terminates the process group. */
  signal: AbortSignal;
  /** SIGTERM → SIGKILL grace used when the run is cancelled. */
  stopTimeoutMs: number;
  logger: Logger;
  onLine(stream: LogStream, text: string, ts: number): void;
}

export interface ScriptOutcome {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export async function runScript(run: ScriptRun): Promise<ScriptOutcome> {
  const handle = spawnManaged(
    { script: run.script, cwd: run.cwd, env: run.env },
    { stopTimeoutMs: run.stopTimeoutMs, logger: run.logger },
  );

  const unsubscribe = handle.onOutput((stream, text, ts) => {
    run.onLine(stream, text, ts);
  });
  const onAbort = (): void => {
    void handle.stop({ timeoutMs: run.stopTimeoutMs }).catch(() => {
      // `stop` resolves through the same `exited` promise we already await.
    });
  };

  if (run.signal.aborted) onAbort();
  else run.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const exit = await handle.exited;
    return {
      ok: exit.code === 0 && !run.signal.aborted,
      exitCode: exit.code,
      signal: exit.signal,
      durationMs: exit.durationMs,
    };
  } finally {
    unsubscribe();
    run.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The environment a target's script sees: the daemon's own environment with the
 * app's merged `env` layered on top. `spawnManaged` takes `env` verbatim, so
 * the merge has to happen here — and unset variables must be dropped rather
 * than passed through as `undefined`.
 */
export function targetEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}

/** Human-readable exit description used in run logs and error messages. */
export function describeExit(outcome: ScriptOutcome): string {
  if (outcome.signal !== null) return `killed by ${outcome.signal}`;
  return `exited with code ${outcome.exitCode ?? "unknown"}`;
}
