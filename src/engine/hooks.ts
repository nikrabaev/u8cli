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
import type { BoundHook } from "../daemon/contracts.js";
import type { HookContext, HookResult } from "../plugin/types.js";
import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { describeExit, type ScriptOutcome } from "./script.js";

export interface HookPipeline {
  logger: Logger;
  /** Runs a config hook string in the target's cwd. */
  runShell(script: string): Promise<ScriptOutcome>;
  /** Builds the context handed to one plugin hook. */
  context(plugin: string, phase: "pre" | "post", result?: HookResult): HookContext;
  /** Records an explanatory line in the target's run log. */
  note(text: string): void;
  /** True once the run was cancelled; remaining hooks are then skipped. */
  cancelled(): boolean;
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
    if (p.cancelled()) return "run cancelled";
    const outcome = await p.runShell(script);
    if (!outcome.ok) {
      const reason = `pre hook ${describeExit(outcome)}: ${script}`;
      p.note(reason);
      return reason;
    }
  }

  for (const hook of bound) {
    if (!hook.def.pre) continue;
    if (p.cancelled()) return "run cancelled";
    try {
      await hook.def.pre(p.context(hook.plugin, "pre"));
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
 * @returns the joined failures, or `undefined` when all of them passed.
 */
export async function runPostHooks(
  config: readonly string[],
  bound: readonly BoundHook[],
  result: HookResult,
  p: HookPipeline,
): Promise<string | undefined> {
  const failures: string[] = [];

  for (const script of config) {
    const outcome = await p.runShell(script);
    if (outcome.ok) continue;
    const message = `post hook ${describeExit(outcome)}: ${script}`;
    p.note(message);
    p.logger.warn(message);
    failures.push(message);
  }

  for (const hook of bound) {
    if (!hook.def.post) continue;
    try {
      await hook.def.post(p.context(hook.plugin, "post", result));
    } catch (err) {
      const message = `post hook of plugin "${hook.plugin}" failed: ${errorMessage(err)}`;
      p.note(message);
      p.logger.warn(message);
      failures.push(message);
    }
  }

  return failures.length === 0 ? undefined : failures.join("; ");
}
