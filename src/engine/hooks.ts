/**
 * The hook pipeline for one (command, target) pair — SPEC §2.6.
 *
 * Two asymmetric guarantees drive the shape of this module:
 *
 *  - **`pre` is a gate.** The first failing hook aborts *that target* and
 *    nothing else runs for it, so the loop returns the reason immediately.
 *  - **`post` is a promise.** Every bound `post` runs even after a failure, an
 *    abort, or another `post` blowing up — so failures are collected, never
 *    thrown, and the caller decides what they mean for the target's state.
 *
 * Ordering is config-declared shell hooks first, then plugin hooks in load
 * order, which is exactly the order `PluginHost.hooksFor` returns them in.
 */
import type { TargetId } from "../config/types.js";
import type { BoundHook } from "../daemon/contracts.js";
import type { TaskTargetState } from "../ipc/protocol.js";
import type { HookContext, HookResult, MaybePromise } from "../plugin/types.js";
import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { describeExit, type ScriptOutcome } from "./script.js";

export interface HookPipeline {
  logger: Logger;
  /** Runs a config hook string in the target's cwd, with `extraEnv` on top of its own. */
  runShell(script: string, extraEnv?: Record<string, string>): Promise<ScriptOutcome>;
  /** Builds the context handed to one plugin hook. */
  context(plugin: string, phase: "pre" | "post", result?: HookResult): HookContext;
  /** Records an explanatory line in the target's run log. */
  note(text: string): void;
  /** The run's cancellation; remaining hooks are skipped once it fires. */
  signal: AbortSignal;
}

/**
 * The outcome of the work, for a config-declared `post` hook (SPEC §2.6:
 * "`post` always runs, receiving the result").
 *
 * A plugin hook reads `ctx.result`, but a shell string has no such channel —
 * without these variables the commonest use of a `post` hook, acting only when
 * the work failed, is impossible without writing a plugin. They are layered
 * over the target's own env, and only ever for `post`: a `pre` hook has no
 * result, and inventing one for it would be a lie a script could branch on.
 *
 * `U8_OK` is `1`/`0` so `[ "$U8_OK" = "1" ]` works; `U8_EXIT_CODE` is empty
 * when the target never ran anything to exit (an aborted one).
 */
export function postHookEnv(input: {
  command: string;
  targetId: TargetId;
  status: TaskTargetState;
  result: HookResult;
}): Record<string, string> {
  return {
    U8_OK: input.result.ok ? "1" : "0",
    U8_EXIT_CODE: input.result.exitCode === null ? "" : String(input.result.exitCode),
    U8_STATUS: input.status,
    U8_DURATION_MS: String(input.result.durationMs),
    U8_COMMAND: input.command,
    U8_TARGET: input.targetId,
  };
}

/**
 * Runs every `pre` hook in order.
 *
 * @returns the abort reason, or `undefined` when the target may proceed.
 */
export async function runPreHooks(
  config: readonly string[],
  bound: readonly BoundHook[],
  p: HookPipeline,
): Promise<string | undefined> {
  for (const script of config) {
    if (p.signal.aborted) return "run cancelled";
    const outcome = await p.runShell(script);
    if (!outcome.ok) {
      const reason = `pre hook ${describeExit(outcome)}: ${script}`;
      p.note(reason);
      return reason;
    }
  }

  for (const hook of bound) {
    if (!hook.def.pre) continue;
    if (p.signal.aborted) return "run cancelled";
    try {
      if (!(await awaitHook(hook.def.pre(p.context(hook.plugin, "pre")), p.signal))) return "run cancelled";
    } catch (err) {
      const reason = `pre hook of plugin "${hook.plugin}" aborted this target: ${errorMessage(err)}`;
      p.note(reason);
      return reason;
    }
  }

  return undefined;
}

/**
 * Runs every `post` hook, whatever happened before it.
 *
 * `env` carries the outcome to config-declared hooks; see {@link postHookEnv}.
 *
 * @returns the joined failures, or `undefined` when all of them passed.
 */
export async function runPostHooks(
  config: readonly string[],
  bound: readonly BoundHook[],
  result: HookResult,
  p: HookPipeline,
  env: Record<string, string>,
): Promise<string | undefined> {
  const failures: string[] = [];

  for (const script of config) {
    const outcome = await p.runShell(script, env);
    if (outcome.ok) continue;
    const message = `post hook ${describeExit(outcome)}: ${script}`;
    p.note(message);
    p.logger.warn(message);
    failures.push(message);
  }

  for (const hook of bound) {
    if (!hook.def.post) continue;
    try {
      // A cancellation mid-`post` ends the phase: the remaining hooks are not
      // failures, there is just no longer a daemon to run them in.
      if (!(await awaitHook(hook.def.post(p.context(hook.plugin, "post", result)), p.signal))) break;
    } catch (err) {
      const message = `post hook of plugin "${hook.plugin}" failed: ${errorMessage(err)}`;
      p.note(message);
      p.logger.warn(message);
      failures.push(message);
    }
  }

  return failures.length === 0 ? undefined : failures.join("; ");
}

/**
 * Awaits one plugin hook, but never past the run's cancellation.
 *
 * Plugin hooks are trusted code running inside the daemon (SPEC §6), and a
 * trusted `await` is still an `await`: a hook that never returns would pin its
 * run — and with it `cancelAll`, and with that the whole shutdown — forever.
 * The hook's promise is abandoned rather than cancelled, since nothing can be
 * done about code that ignores the signal; its rejection handler stays attached
 * so a late failure cannot surface as an unhandled rejection.
 *
 * @returns `false` when the run was cancelled before the hook returned.
 */
async function awaitHook(returned: MaybePromise<void>, signal: AbortSignal): Promise<boolean> {
  const work = Promise.resolve(returned);
  if (signal.aborted) {
    void work.catch(() => undefined);
    return false;
  }
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
