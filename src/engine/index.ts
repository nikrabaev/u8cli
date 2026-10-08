/** Command engine: command resolution, task running, hooks, dependsOn ordering. */
export { createEngine, type EngineDeps } from "./engine.js";
export { runPool } from "./pool.js";
export { runScript, targetEnv, type ScriptOutcome, type ScriptRun } from "./script.js";
export { toRepoInfo, toTargetInfo, toWorkspaceInfo } from "./context.js";
