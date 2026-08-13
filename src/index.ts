/** Programmatic entry point. The CLI lives in `src/cli/main.ts`. */
export { VERSION } from "./version.js";
export type * from "./config/types.js";
export type * from "./ipc/protocol.js";
export type * from "./plugin/types.js";
export type * from "./process/types.js";
export { U8Error, ConfigError, type ConfigIssue, type U8ErrorCode } from "./util/errors.js";
export { createLogger, nullLogger, type Logger } from "./util/logger.js";
export { statePaths, workspaceId, stateHome, CONFIG_FILENAME } from "./util/paths.js";
