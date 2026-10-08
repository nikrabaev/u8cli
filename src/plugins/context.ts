/**
 * The contexts handed to plugin callbacks.
 *
 * Every callsite (setup, readiness, indicators, commands, hooks) gives a plugin
 * the same four things — the workspace it runs in, a scoped logger, an `exec`
 * already pointed at the right directory, and its own scratch space — and then
 * adds whatever that callsite is about. This module owns the common half, so a
 * plugin sees one shape wherever it is called from.
 */
import type { NormalizedWorkspace } from "../config/types.js";
import { toWorkspaceInfo } from "../engine/index.js";
import type { PluginBaseContext } from "../plugin/types.js";
import { exec } from "../process/index.js";
import type { ExecOptions, ExecResult } from "../process/types.js";
import type { Logger } from "../util/logger.js";

export interface BaseContextInput {
  workspace: NormalizedWorkspace;
  logger: Logger;
  /** The plugin's own store; the same Map at every callsite (see `withStore`). */
  store: Map<string, unknown>;
  /** Default cwd for `exec`: the workspace root, a repo path or an app cwd. */
  cwd: string;
  /** Env of the callsite, layered over the daemon's own by `exec`. */
  env?: Record<string, string>;
  /**
   * Cancels commands the plugin spawned. Without one, a plugin that shells out
   * during shutdown leaves a child nothing will ever reap.
   */
  signal?: AbortSignal;
}

/**
 * Builds the half of a plugin context that does not depend on the callsite.
 *
 * Exported because the engine builds command and hook contexts itself: the
 * cwd, env and abort signal a running command needs are only known there.
 */
export function pluginBaseContext(input: BaseContextInput): PluginBaseContext {
  return {
    workspace: toWorkspaceInfo(input.workspace),
    logger: input.logger,
    store: input.store,
    exec: (cmd: string, opts: ExecOptions = {}): Promise<ExecResult> =>
      exec(cmd, {
        ...opts,
        cwd: opts.cwd ?? input.cwd,
        env: { ...input.env, ...opts.env },
        signal: opts.signal ?? input.signal,
      }),
  };
}

/**
 * Re-points a context at one plugin's store.
 *
 * The indicator registry and the engine each keep their own per-namespace
 * scratch map, so a plugin writing from `value()` and reading from `run()` would
 * otherwise find two different Maps. The host owns the definitions those two
 * call, so it swaps the store in on the way through and the SDK's promise —
 * *one* store per plugin, surviving across invocations — holds everywhere.
 */
export function withStore<T extends PluginBaseContext>(ctx: T, store: Map<string, unknown>): T {
  return { ...ctx, store };
}
