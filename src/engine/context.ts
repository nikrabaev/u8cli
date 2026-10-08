/**
 * Adapters from the normalized config model to the shapes plugins receive.
 *
 * Plugins are handed copies, never the live workspace objects: a plugin that
 * mutates `scripts` or `env` must not silently rewrite the daemon's idea of the
 * workspace.
 */
import type { NormalizedApp, NormalizedRepo, NormalizedWorkspace } from "../config/types.js";
import type { RepoInfo, TargetInfo, WorkspaceInfo } from "../plugin/types.js";

export function toWorkspaceInfo(ws: NormalizedWorkspace): WorkspaceInfo {
  return { id: ws.id, name: ws.name, rootDir: ws.rootDir, configPath: ws.configPath };
}

export function toRepoInfo(repo: NormalizedRepo): RepoInfo {
  return { name: repo.name, baseName: repo.baseName, instance: repo.instance, path: repo.path };
}

export function toTargetInfo(app: NormalizedApp): TargetInfo {
  return {
    id: app.id,
    baseId: app.baseId,
    instance: app.instance,
    repoName: app.repoName,
    name: app.name,
    implicit: app.implicit,
    cwd: app.cwd,
    scripts: { ...app.scripts },
    env: { ...app.env },
    ports: { ...app.ports },
    dependsOn: [...app.dependsOn],
    hasHealth: app.health !== undefined,
  };
}
