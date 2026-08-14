/**
 * Per-workspace local state (`paths.stateFile`).
 *
 * The active profile is a *local* choice, not a shared one: it lives in the
 * state dir so switching profiles never dirties the checked-in `u8.jsonc`
 * (SPEC §2.4). Two properties matter more than anything else here:
 *
 *  - **Writes are atomic.** A daemon killed mid-write must not leave a half
 *    file behind — the next start would then lose the setting *and* log a
 *    parse error. Write to a temp file in the same directory, then rename.
 *  - **Reads are tolerant.** A missing file is the default state, and a corrupt
 *    one is the default state plus a single warning. Nothing about a stray byte
 *    in a convenience file may stop a daemon from starting.
 */
import fs from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";

export interface LocalState {
  /** Profile selected with `u8 profile use`; absent means "the config default". */
  activeProfile?: string;
}

export interface ReadLocalState {
  state: LocalState;
  /** Human-readable reason the file was ignored; absent when it read cleanly. */
  problem?: string;
}

export interface StateStore {
  readonly file: string;
  /** In-memory view: loaded once at construction, updated by every write. */
  current(): LocalState;
  /** Re-reads from disk, tolerating a missing or unparsable file. */
  reload(): LocalState;
  /** Persists before resolving, so a caller may answer an RPC on it. */
  setActiveProfile(name: string | undefined): Promise<void>;
}

/** Never throws: an unreadable state file degrades to defaults plus a reason. */
export function readLocalState(file: string): ReadLocalState {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: {} };
    return { state: {}, problem: `cannot read ${file}: ${errorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { state: {}, problem: `${file} is not valid JSON: ${errorMessage(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: {}, problem: `${file} does not contain a JSON object` };
  }

  const activeProfile = (parsed as { activeProfile?: unknown }).activeProfile;
  if (activeProfile !== undefined && typeof activeProfile !== "string") {
    return { state: {}, problem: `${file} has a non-string "activeProfile"` };
  }
  return { state: activeProfile === undefined ? {} : { activeProfile } };
}

/**
 * Atomic replace: a reader either sees the previous file or the new one, never
 * a partial write. The temp file is a sibling so `rename` stays within one
 * filesystem, and it is removed if the rename itself fails.
 */
export async function writeLocalState(file: string, state: LocalState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface StateStoreOptions {
  file: string;
  logger?: Logger;
}

export function createStateStore(opts: StateStoreOptions): StateStore {
  const logger = opts.logger ?? nullLogger;
  let warned = false;

  const load = (): LocalState => {
    const { state, problem } = readLocalState(opts.file);
    // Once per daemon: the same broken file is re-read on every reload, and a
    // warning per read would bury the one that matters.
    if (problem !== undefined && !warned) {
      warned = true;
      logger.warn(`ignoring local state: ${problem}`);
    }
    return state;
  };

  let state = load();

  return {
    file: opts.file,
    current: () => ({ ...state }),
    reload: () => {
      state = load();
      return { ...state };
    },
    async setActiveProfile(name: string | undefined): Promise<void> {
      const next: LocalState = name === undefined ? {} : { activeProfile: name };
      await writeLocalState(opts.file, next);
      state = next;
    },
  };
}
