/**
 * State-directory layout. Every runtime artifact for a workspace lives under
 * `$U8_STATE_HOME/<workspaceId>/` (default `~/.u8/<workspaceId>/`), where the id
 * is a hash of the config file's real path — so two checkouts of the same project
 * never share a daemon, and moving a workspace gives it a fresh state dir.
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILENAME = "u8.jsonc";

/** Root for all workspace state dirs. Overridable via `U8_STATE_HOME` (tests). */
export function stateHome(): string {
  const override = process.env.U8_STATE_HOME;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".u8");
}

/** Stable short id for a workspace, derived from the real config path. */
export function workspaceId(realConfigPath: string): string {
  return createHash("sha256").update(realConfigPath).digest("hex").slice(0, 12);
}

export interface StatePaths {
  id: string;
  dir: string;
  socket: string;
  pidFile: string;
  daemonLog: string;
  stateFile: string;
  serviceLogDir: string;
  taskLogDir: string;
}

export function statePaths(realConfigPath: string): StatePaths {
  const id = workspaceId(realConfigPath);
  const dir = path.join(stateHome(), id);
  return {
    id,
    dir,
    socket: path.join(dir, "daemon.sock"),
    pidFile: path.join(dir, "daemon.pid"),
    daemonLog: path.join(dir, "daemon.log"),
    stateFile: path.join(dir, "state.json"),
    serviceLogDir: path.join(dir, "logs", "services"),
    taskLogDir: path.join(dir, "logs", "tasks"),
  };
}

/** Makes a target id (or command name) safe to use as a path segment. */
export function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]/g, "_");
}

/** Expands a leading `~` and resolves against `base`. */
export function resolvePath(p: string, base: string): string {
  let out = p;
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/")) out = path.join(os.homedir(), out.slice(2));
  return path.resolve(base, out);
}
