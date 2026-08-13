/**
 * Workspace discovery: walk upward from a directory looking for `u8.jsonc`,
 * git-style. The returned path is always symlink-resolved because the workspace
 * id — and therefore the state dir and the daemon socket — is a hash of it; two
 * routes to the same file must land on the same daemon.
 */
import fs from "node:fs";
import path from "node:path";
import { U8Error } from "../util/errors.js";
import { CONFIG_FILENAME } from "../util/paths.js";

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

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
