/** Process layer: one-shot exec, supervised service spawns, rotating log files. */
export { exec, defaultShell, DEFAULT_MAX_BUFFER, TRUNCATION_NOTICE } from "./exec.js";
export { spawnManaged, type SpawnManagedOptions } from "./spawn.js";
export {
  createLogWriter,
  formatLogLine,
  parseLogLine,
  pruneTaskRuns,
  readLastLines,
  serviceLogPath,
  taskRunDir,
  taskRunLogPath,
  type LogWriter,
  type LogWriterOptions,
} from "./logfile.js";
export type * from "./types.js";
