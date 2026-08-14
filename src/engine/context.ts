/**
 * Adapters from the normalized config model to the shapes plugins receive.
 *
 * Plugins are handed copies, never the live workspace objects: a plugin that
 * mutates `scripts` or `env` must not silently rewrite the daemon's idea of the
 * workspace.
 */
import type { NormalizedApp, NormalizedSubapp, NormalizedWorkspace } from "../config/types.js";
import type { AppInfo, TargetInfo, WorkspaceInfo } from "../plugin/types.js";

export function toWorkspaceInfo(ws: NormalizedWorkspace): WorkspaceInfo {
  return { id: ws.id, name: ws.name, rootDir: ws.rootDir, configPath: ws.configPath };
}

export function toAppInfo(app: NormalizedApp): AppInfo {
  return { name: app.name, path: app.path };
}

export function toTargetInfo(subapp: NormalizedSubapp): TargetInfo {
  return {
    id: subapp.id,
    appName: subapp.appName,
    name: subapp.name,
    implicit: subapp.implicit,
    cwd: subapp.cwd,
    scripts: { ...subapp.scripts },
    env: { ...subapp.env },
    dependsOn: [...subapp.dependsOn],
    hasHealth: subapp.health !== undefined,
  };
}
