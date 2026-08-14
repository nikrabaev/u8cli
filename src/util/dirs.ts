/**
 * One phrasing for "that directory is not usable".
 *
 * The same fact is discovered in three unrelated places — the config layer at
 * load time, the process layer when a spawn fails, and `u8 status` when it is
 * about to render a target as ordinarily stopped — and a reader who meets it
 * twice must not have to work out whether they are looking at the same problem.
 * So the sentence lives here and the three call it.
 */
import fs from "node:fs";

/**
 * `undefined` when `dir` is usable — **including when it cannot be checked**.
 *
 * A stat that fails for its own reasons (EACCES on a parent, a symlink loop, a
 * hung network mount) proves nothing about the directory: it may be perfectly
 * fine and merely unreadable from here. Crying wolf over a working app would be
 * worse than staying quiet about a broken one, so only a definite answer speaks.
 */
export function describeDirectory(dir: string): string | undefined {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(dir, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (stat === undefined) return `no such directory: ${dir}`;
  return stat.isDirectory() ? undefined : `not a directory: ${dir}`;
}
