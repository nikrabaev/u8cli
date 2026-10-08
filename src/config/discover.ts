/**
 * Workspace discovery: walk upward from a directory looking for `u8.jsonc`,
 * git-style. The returned path is always symlink-resolved because the workspace
 * id — and therefore the state dir and the daemon socket — is a hash of it; two
 * routes to the same file must land on the same daemon.
 */
import fs from "node:fs";
import path from "node:path";
import { U8Error } from "../util/errors.js";
import { CONFIG_FILENAME, stateHome } from "../util/paths.js";
import { readInstanceRecords } from "./instances.js";
import { BASE_INSTANCE } from "./types.js";

/** Real path of the nearest `u8.jsonc`, or `undefined` when there is none. */
export function findConfigPath(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (isFile(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Like {@link findConfigPath}, but throws `CONFIG_NOT_FOUND` instead of returning undefined. */
export function discoverConfig(startDir: string = process.cwd()): string {
  const found = findConfigPath(startDir);
  if (found) return found;
  const from = path.resolve(startDir);
  throw new U8Error(
    "CONFIG_NOT_FOUND",
    `no ${CONFIG_FILENAME} in ${from} or any parent directory — run \`u8 init\` to create one`,
    { startDir: from },
  );
}

// ---------------------------------------------------------------------------
// Discovery through the state dir
// ---------------------------------------------------------------------------

/** Bumped when the index's shape changes in a way an older reader would misread. */
export const WORKSPACE_INDEX_VERSION = 1;

/** What a daemon leaves in its state dir so a checkout can be traced back to its workspace. */
export interface WorkspaceIndex {
  configPath: string;
  name: string;
  /** Base repo name → absolute checkout root. */
  repos: Record<string, string>;
}

export function serializeWorkspaceIndex(index: WorkspaceIndex): string {
  return `${JSON.stringify({ version: WORKSPACE_INDEX_VERSION, ...index }, null, 2)}\n`;
}

function readWorkspaceIndex(file: string): WorkspaceIndex | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { version, configPath, name, repos } = parsed as Record<string, unknown>;
    if (version !== WORKSPACE_INDEX_VERSION || typeof configPath !== "string") return undefined;
    const out: Record<string, string> = {};
    if (typeof repos === "object" && repos !== null) {
      for (const [repo, dir] of Object.entries(repos)) if (typeof dir === "string") out[repo] = dir;
    }
    return { configPath, name: typeof name === "string" ? name : "", repos: out };
  } catch {
    return undefined;
  }
}

export interface LocatedWorkspace {
  /** Real path of the workspace's `u8.jsonc`. */
  configPath: string;
  /**
   * The instance `startDir` is a checkout of. `undefined` when the directory
   * says nothing about it — the caller then means base.
   */
  instance?: string;
  /**
   * Root of the git worktree `startDir` is in, when it is a worktree of one of
   * the workspace's repos that no instance has been given. The directory is
   * not base, and it is not an instance yet: a caller about to change something
   * has to decide which it meant rather than be handed base by default.
   */
  unregistered?: string;
}

/**
 * The workspace a directory belongs to, and the instance it is a checkout of.
 *
 * Walking upward is not enough once instances exist. A worktree is rarely
 * below the workspace's `u8.jsonc`, and one made from a repo that *contains*
 * its config has a copy of the file in it — walking up from there finds the
 * copy, which hashes to a different workspace with the same ports. So the
 * checkouts every daemon has recorded are consulted first: a directory inside
 * one belongs to that workspace and that instance.
 *
 * A `u8.jsonc` strictly below the checkout root still wins, because that is a
 * workspace of its own that merely lives inside a repo.
 */
export function locateWorkspace(startDir: string = process.cwd()): LocatedWorkspace | undefined {
  const start = realDir(startDir);
  const walked = findConfigPath(startDir);

  let best: (LocatedWorkspace & { dir: string }) | undefined;
  const consider = (dir: string, configPath: string, instance: string | undefined): void => {
    if (!isWithin(start, dir)) return;
    if (best !== undefined && best.dir.length >= dir.length) return;
    best = { dir, configPath, instance };
  };

  for (const { index, dir: stateDir } of workspaceIndexes()) {
    for (const repoPath of Object.values(index.repos)) consider(repoPath, index.configPath, undefined);
    for (const record of readInstanceRecords(path.join(stateDir, "instances.json")).records) {
      for (const checkout of Object.values(record.repos)) {
        consider(checkout.path, index.configPath, record.name);
        if (checkout.worktree !== undefined) consider(checkout.worktree, index.configPath, record.name);
      }
    }
  }

  // Not inside any checkout an instance was given. A linked git worktree of one
  // of the workspace's repos is still not base, though — and if the repo holds
  // its own `u8.jsonc`, the copy found by walking up from here is the wrong
  // workspace entirely. The main checkout is what says which workspace this is.
  if (best === undefined || best.instance === undefined) {
    const linked = linkedWorktree(start);
    if (linked !== undefined) {
      // The same spot in the main checkout: a config may sit anywhere inside a
      // repo, and it is found from where this directory would have been.
      const owner = locateWorkspace(path.join(linked.main, path.relative(linked.top, start)));
      if (owner !== undefined && owner.instance === undefined && owner.unregistered === undefined) {
        return { configPath: owner.configPath, unregistered: linked.top };
      }
    }
  }

  if (best === undefined) return walked === undefined ? undefined : { configPath: walked };
  const nested = walked !== undefined && walked !== best.configPath && isStrictlyWithin(path.dirname(walked), best.dir);
  if (nested) return { configPath: walked };
  // A base checkout says which workspace, but a config found by walking up
  // from it is the same answer by the older rule — and the one to prefer when
  // the two disagree, since nothing about being in base needed the index.
  if (best.instance === undefined && walked !== undefined) return { configPath: walked };
  return best.instance === undefined || best.instance === BASE_INSTANCE
    ? { configPath: best.configPath }
    : { configPath: best.configPath, instance: best.instance };
}

/**
 * The worktree `dir` is in and the main checkout it was made from, read from
 * the `.git` *file* a linked worktree has where a clone has a directory. No
 * git process: this runs on every command, and the answer is two short reads.
 */
function linkedWorktree(dir: string): { top: string; main: string } | undefined {
  for (let current = dir; ; ) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
    if (stat?.isDirectory()) return undefined;
    if (stat?.isFile()) {
      let pointer: string;
      try {
        pointer = fs.readFileSync(dotGit, "utf8");
      } catch {
        return undefined;
      }
      // `gitdir: <main>/.git/worktrees/<name>`. A submodule's pointer goes to
      // `.git/modules/…` instead, and is not a second checkout of anything.
      const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
      if (gitDir === undefined) return undefined;
      const resolved = path.resolve(current, gitDir);
      const match = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolved);
      const main = match?.[1];
      return main === undefined ? undefined : { top: current, main: realDir(main) };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Every workspace that has a state dir and whose config is still on disk. */
function workspaceIndexes(): Array<{ dir: string; index: WorkspaceIndex }> {
  const home = stateHome();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ dir: string; index: WorkspaceIndex }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(home, entry.name);
    const index = readWorkspaceIndex(path.join(dir, "workspace.json"));
    if (index !== undefined && isFile(index.configPath)) out.push({ dir, index });
  }
  return out;
}

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isStrictlyWithin(candidate: string, root: string): boolean {
  return candidate !== root && isWithin(candidate, root);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
