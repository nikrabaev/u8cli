/**
 * Config layer entry point: `cwd → NormalizedWorkspace`.
 *
 * Everything else in u8cli consumes the normalized model; nothing outside this
 * directory should import `schema.ts` or reach for the raw JSONC shape.
 */
import fs from "node:fs";
import { U8Error } from "../util/errors.js";
import { statePaths } from "../util/paths.js";
import { discoverConfig } from "./discover.js";
import { readInstanceRecords } from "./instances.js";
import { loadConfigFile } from "./load.js";
import { normalizeWorkspace } from "./normalize.js";
import type { NormalizedWorkspace } from "./types.js";

/** Discovers `u8.jsonc` upward from `cwd`, then loads and normalizes it. */
export function loadWorkspace(cwd: string = process.cwd()): NormalizedWorkspace {
  return loadWorkspaceFrom(discoverConfig(cwd));
}

/**
 * Loads a specific config file. The path is symlink-resolved first because the
 * workspace id (and therefore the state dir and daemon socket) derives from it.
 *
 * The workspace's instance records are read from that state dir and folded in,
 * so every caller — the daemon, a client, a plugin re-reading the file — gets
 * the same apps for the same path.
 */
export function loadWorkspaceFrom(configPath: string): NormalizedWorkspace {
  let realPath: string;
  try {
    realPath = fs.realpathSync(configPath);
  } catch {
    throw new U8Error("CONFIG_NOT_FOUND", `config file not found: ${configPath}`, { configPath });
  }
  const { raw } = loadConfigFile(realPath);
  const { records, problem } = readInstanceRecords(statePaths(realPath).instancesFile);
  const ws = normalizeWorkspace(raw, realPath, records);
  if (problem !== undefined) ws.warnings.unshift(problem);
  return ws;
}

export {
  discoverConfig,
  findConfigPath,
  locateWorkspace,
  serializeWorkspaceIndex,
  WORKSPACE_INDEX_VERSION,
  type LocatedWorkspace,
  type WorkspaceIndex,
} from "./discover.js";
export {
  INSTANCES_FILE_VERSION,
  readInstanceRecords,
  serializeInstanceRecords,
  type ReadInstances,
} from "./instances.js";
export { parseInterpolation, parseRef, renderInterpolation, REFERENCE_HINT } from "./interpolate.js";
export { loadConfigFile, parseConfigText, readConfigText, validateConfig, type LoadedConfig } from "./load.js";
export {
  DEFAULT_INDICATOR_INTERVAL_MS,
  IMPLICIT_PROFILE_NAME,
  instanceNameProblem,
  normalizeWorkspace,
} from "./normalize.js";
export {
  commandTargets,
  coreStartScript,
  coreStopScript,
  dependenciesOf,
  expandTarget,
  instanceTargets,
  profileTargets,
  qualifyTarget,
  resolveTargetStrings,
  topoWaves,
  unboundHookWarnings,
  unknownTargetMessage,
  type CommandTarget,
} from "./resolve.js";
export { skeletonConfig, writeSkeletonConfig } from "./init.js";
export {
  BARE_NAME_PATTERN,
  NAME_PATTERN,
  jsonSchema,
  workspaceConfigSchema,
  type RawApp,
  type RawCommand,
  type RawHealth,
  type RawHooks,
  type RawProfile,
  type RawRepo,
  type RawWorkspaceConfig,
} from "./schema.js";
export * from "./types.js";
