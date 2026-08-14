/**
 * Daemon layer entry point.
 *
 * Two audiences: the daemon process (`createDaemon` plus the collaborators it
 * wires) and every client (`ensureDaemon` / `attach`, which spawn and talk to
 * it). `entry.ts` is deliberately absent — importing it starts a daemon, so it
 * is reached only by being executed.
 */
export {
  createDaemon,
  resolveIdleMs,
  LOG_BYTES_PER_WINDOW,
  LOG_WINDOW_MS,
  type Daemon,
  type DaemonOptions,
} from "./daemon.js";

export {
  buildSnapshot,
  createHandlers,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  type DaemonRuntimeStats,
  type HandlerDeps,
  type ReloadOutcome,
} from "./handlers.js";

export {
  attach,
  daemonEntryPath,
  ensureDaemon,
  pingDaemon,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  type AttachOptions,
  type AttachedClient,
  type EnsureDaemonOptions,
} from "./launch.js";

export {
  createStateStore,
  readLocalState,
  writeLocalState,
  type LocalState,
  type ReadLocalState,
  type StateStore,
  type StateStoreOptions,
} from "./state.js";

export {
  createSupervisor,
  restartDelayMs,
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_MS,
  START_GRACE_MS,
  type SupervisorDeps,
  type SupervisorTiming,
} from "./supervisor.js";

export * from "./contracts.js";
