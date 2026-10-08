/**
 * `u8cli/plugin` — the entry point plugin authors import.
 *
 * ```ts
 * import { definePlugin } from "u8cli/plugin";
 *
 * export default definePlugin({
 *   name: "example",
 *   indicators: { thing: { update: { mode: "poll", intervalMs: 5000 }, value: () => "42" } },
 *   commands: { greet: { async run(ctx) { ctx.log("hello"); } } },
 *   hooks: { "app:start": { async pre(ctx) { if (dirty) throw new Error("dirty"); } } },
 * });
 * ```
 */
import type { PluginDefinition } from "./types.js";

/** Identity helper that pins the type of a plugin definition. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export type {
  CommandContext,
  HookContext,
  HookDef,
  HookResult,
  IndicatorContext,
  IndicatorDef,
  IndicatorResult,
  IndicatorScope,
  IndicatorUpdate,
  MaybePromise,
  PluginBaseContext,
  PluginCommandDef,
  PluginDefinition,
  PluginSetupContext,
  ReadinessContext,
  ReadinessVerdict,
  RepoInfo,
  TargetInfo,
  WorkspaceInfo,
} from "./types.js";

export type { CommandKind, TargetId } from "../config/types.js";
export type { IndicatorTone, ServiceState, ServiceStatus } from "../ipc/protocol.js";
export type { ExecOptions, ExecResult } from "../process/types.js";
export type { Logger } from "../util/logger.js";
