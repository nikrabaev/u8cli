/**
 * Indicator layer: the daemon's cache of `{ns@name}` and `{name}` values and the
 * providers that fill it. The registry is the single source of truth behind
 * both the TUI rows and `u8 status --json`.
 */
export {
  CHANGE_BATCH_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_PROVIDER_TIMEOUT_MS,
  MIN_PROVIDER_TIMEOUT_MS,
  REFRESH_COALESCE_MS,
  STAGGER_STEP_MS,
  createIndicatorRegistry,
} from "./registry.js";

export {
  CORE_NAMESPACE,
  STATUS_GLYPH,
  UPTIME_POLL_MS,
  aggregateStatus,
  appStatus,
  coreIndicators,
  formatUptime,
  statusResult,
  type CoreStatus,
} from "./core.js";

export { customIndicators, probeTimeoutMs } from "./custom.js";

export { INDICATOR_ELLIPSIS, MAX_INDICATOR_LENGTH, sanitizeIndicatorText } from "./sanitize.js";

export type { CoreIndicatorDeps, IndicatorRegistryDeps, ServiceStateAccess } from "./types.js";
