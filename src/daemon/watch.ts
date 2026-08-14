/**
 * The config-file watcher — SPEC §8, PLAN 12.1.
 *
 * `watchConfig` answers exactly one question — "did `u8.jsonc` change?" — and
 * calls back when it did. What a change *means* is the daemon's business; this
 * module only has to be impossible to fool.
 *
 * Four rules shape it:
 *  - **Watch the directory, not only the file.** Editors do not write configs in
 *    place: vim and VS Code write a temp file and rename it over the target, so
 *    a watcher bound to the file holds a deleted inode from the first save on
 *    and goes deaf. The directory watch survives that, reports the file's
 *    disappearance and its return, and is what re-arms the file watch on the new
 *    inode.
 *  - **Never trust a watch alone.** `fs.watch` is unreliable on network and
 *    container filesystems, where events arrive late or never, so a slow stat
 *    poll compares (inode, mtime, size) as a backstop.
 *  - **One save is one change.** Events are debounced, and every path — watch
 *    event and poll tick alike — ends in the same signature comparison, so a
 *    save both of them notice still produces exactly one callback, and an event
 *    that changed nothing produces none.
 *  - **Dispose leaves nothing behind.** Both watchers are `persistent: false`
 *    and both timers are unref'd, so watching is never the reason a daemon stays
 *    alive, and the returned disposer closes all four exactly once.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { errorMessage } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

/**
 * Quiet time after the last event before the file is inspected. One `:w` can
 * produce a create, a rename and two writes within a few milliseconds; the
 * daemon should reload once for all of them.
 */
export const CONFIG_DEBOUNCE_MS = 200;

/** Cadence of the fallback stat poll (SPEC §8, PLAN "watch items"). */
export const CONFIG_POLL_MS = 2_000;

export interface WatchConfigOptions {
  /** Path to `u8.jsonc`; symlink-resolved by the caller. */
  configPath: string;
  /** Called once per observed change. Never called after the disposer runs. */
  onChange(): void;
  logger: Logger;
  /** Test seam: quiet period before a burst of events is inspected. */
  debounceMs?: number;
  /**
   * Test seam: stat-poll cadence. `0` disables the fallback poll. Must stay
   * longer than the debounce: a tick only *schedules* an inspection, so a poll
   * that outpaces the debounce would keep re-arming it and never settle.
   */
  pollMs?: number;
  /**
   * Test seam: `false` skips `fs.watch` entirely, leaving only the stat poll —
   * which is what a filesystem whose events never arrive looks like, and the
   * whole reason the poll exists.
   */
  nativeWatch?: boolean;
  /**
   * What the file looked like when the caller last read it, from
   * {@link configSignature}.
   *
   * A daemon reads its config seconds before this call — plugins are imported
   * and set up in between — and a save landing in that window is invisible to a
   * watch that takes its own baseline here: the poll compares against the same
   * late reading, so nothing ever recovers it and the daemon serves a config
   * that is already wrong. Handing over the earlier reading turns that window
   * into an ordinary change, reported once the watch is armed.
   */
  baseline?: string;
}

/** Signature of a file that is not there; no real one can collide with it. */
const MISSING = "missing";

interface FileState {
  /** Changes whenever the content could have changed: inode, mtime, size. */
  signature: string;
  /** `undefined` when the file is absent — nothing to bind a file watch to. */
  ino?: number;
}

/**
 * Starts watching. Returns a disposer that is safe to call more than once.
 *
 * The callback is invoked from a timer, so it must not throw; one that does is
 * logged and swallowed rather than left to become an uncaught exception in
 * whatever tick the debounce happened to land in.
 */
export function watchConfig(opts: WatchConfigOptions): () => void {
  const configPath = path.resolve(opts.configPath);
  const dir = path.dirname(configPath);
  const filename = path.basename(configPath);
  const log = opts.logger.child("config");
  const debounceMs = Math.max(0, opts.debounceMs ?? CONFIG_DEBOUNCE_MS);
  const pollMs = Math.max(0, opts.pollMs ?? CONFIG_POLL_MS);
  const nativeWatch = opts.nativeWatch ?? true;

  let disposed = false;
  let fileWatcher: FSWatcher | undefined;
  let dirWatcher: FSWatcher | undefined;
  let watchedIno: number | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  /** The state the last callback described — what everything is compared to. */
  let known = inspect(configPath);
  /** True while an observed disappearance is being given a second chance. */
  let missingSeen = false;

  // --- watchers -------------------------------------------------------------

  const closeFileWatch = (): void => {
    const watcher = fileWatcher;
    fileWatcher = undefined;
    watchedIno = undefined;
    close(watcher, log, configPath);
  };

  const closeDirWatch = (): void => {
    const watcher = dirWatcher;
    dirWatcher = undefined;
    close(watcher, log, dir);
  };

  /**
   * Binds the file watch to the inode the config currently has. A rename-over
   * replaces that inode, and the watcher holding the old one never reports
   * anything again — so every inspection re-checks it.
   */
  const syncFileWatch = (ino: number | undefined): void => {
    if (!nativeWatch || disposed) return;
    if (fileWatcher !== undefined && watchedIno === ino) return;
    closeFileWatch();
    if (ino === undefined) return;
    try {
      const watcher = watch(configPath, { persistent: false }, () => {
        schedule();
      });
      watcher.on("error", (err) => {
        // The file was replaced or removed under us. The directory watch and the
        // poll both still see it, and either re-arms this one.
        log.debug(`watch on ${configPath} failed: ${errorMessage(err)}`);
        closeFileWatch();
      });
      fileWatcher = watcher;
      watchedIno = ino;
    } catch (err) {
      log.debug(`cannot watch ${configPath}: ${errorMessage(err)}`);
    }
  };

  const syncDirWatch = (): void => {
    if (!nativeWatch || disposed || dirWatcher !== undefined) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        // A platform that does not name the entry reports `null`; inspecting
        // then costs one stat and tells us whether it mattered.
        if (name === null || name === filename) schedule();
      });
      watcher.on("error", (err) => {
        log.debug(`watch on ${dir} failed: ${errorMessage(err)}`);
        closeDirWatch();
      });
      dirWatcher = watcher;
    } catch (err) {
      log.debug(`cannot watch ${dir}: ${errorMessage(err)}`);
    }
  };

  // --- change detection -----------------------------------------------------

  /** Trailing-edge debounce: one inspection once the writes have stopped. */
  const schedule = (): void => {
    if (disposed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      settle();
    }, debounceMs);
    debounceTimer.unref();
  };

  const settle = (): void => {
    if (disposed) return;
    const now = inspect(configPath);

    if (now.signature === MISSING && known.signature !== MISSING && !missingSeen) {
      // An atomic save leaves the target absent for a moment. Reporting that
      // window would flap the whole workspace into "config not found" and back
      // on every `:w`, so a disappearance is only believed the second time.
      missingSeen = true;
      schedule();
      return;
    }
    missingSeen = false;

    syncFileWatch(now.ino);
    if (now.signature === known.signature) return;
    known = now;

    try {
      opts.onChange();
    } catch (err) {
      log.error(`config change listener threw: ${errorMessage(err)}`);
    }
  };

  /**
   * The backstop. It only *schedules* an inspection, so a tick landing on the
   * same save a watch event already reported collapses into that one callback
   * instead of doubling it.
   */
  const poll = (): void => {
    if (disposed) return;
    syncDirWatch();
    const now = inspect(configPath);
    syncFileWatch(now.ino);
    if (now.signature !== known.signature) schedule();
  };

  // --- start ----------------------------------------------------------------

  syncDirWatch();
  syncFileWatch(known.ino);
  if (opts.baseline !== undefined && opts.baseline !== known.signature) {
    // The file moved between the caller's read and this call. Adopting its
    // reading as the baseline makes the inspection below find the difference,
    // so the save is reported through the same debounce as any other — the
    // watch is armed by now, and cannot miss what happens next either.
    known = { signature: opts.baseline, ino: known.ino };
    schedule();
  }
  if (pollMs > 0) {
    pollTimer = setInterval(poll, pollMs);
    pollTimer.unref();
  }
  log.debug(`watching ${configPath}`, { poll: pollMs, debounce: debounceMs, events: nativeWatch });

  return (): void => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    closeFileWatch();
    closeDirWatch();
  };
}

/**
 * The reading {@link WatchConfigOptions.baseline} expects: what the config
 * looked like at the moment of the call. A caller that reads the file long
 * before it starts watching captures this alongside the read, so the watch can
 * tell whether anything happened in between.
 */
export function configSignature(configPath: string): string {
  return inspect(path.resolve(configPath)).signature;
}

/**
 * What the file looks like right now. Anything that is not a readable regular
 * file reads as absent: a config replaced by a directory, or one on a mount that
 * has gone away, is exactly as unusable as a deleted one, and the daemon's
 * reload reports the real reason when it tries to load it.
 */
function inspect(file: string): FileState {
  let stats;
  try {
    stats = statSync(file, { throwIfNoEntry: false });
  } catch {
    return { signature: MISSING };
  }
  if (stats === undefined || !stats.isFile()) return { signature: MISSING };
  return { signature: `${stats.ino}:${stats.mtimeMs}:${stats.size}`, ino: stats.ino };
}

function close(watcher: FSWatcher | undefined, log: Logger, what: string): void {
  if (!watcher) return;
  try {
    watcher.close();
  } catch (err) {
    log.debug(`closing the watch on ${what} threw: ${errorMessage(err)}`);
  }
}
