/**
 * Per-workspace local state: the active profile (`paths.stateFile`) and the
 * journal of processes the daemon owns (`supervised.json`).
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
 *
 * The journal exists for the harder problem: a daemon that is SIGKILLed takes
 * its memory of every service it spawned with it, and those services keep
 * running with nothing left that knows about them. What survives a `kill -9` is
 * what was already on disk, so every spawn and every exit is recorded before
 * anything else happens, and the next daemon reads it back (see
 * `supervisor.reconcile`).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { serializeWorkspaceIndex } from "../config/index.js";
import { BASE_INSTANCE, type NormalizedWorkspace } from "../config/types.js";
import { errorMessage } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import type { StatePaths } from "../util/paths.js";

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

/**
 * Records which config a state dir belongs to and where its base repos are.
 *
 * The state dir is named after a hash, which cannot be turned back into a path:
 * without this file a client standing in one of the workspace's checkouts —
 * a worktree far from `u8.jsonc`, or a repo the config points at with an
 * absolute path — has no way to learn which workspace it is in. Rewritten only
 * when it would change, so a reload does not touch the disk for nothing.
 */
export async function writeWorkspaceIndex(paths: StatePaths, ws: NormalizedWorkspace): Promise<void> {
  const text = serializeWorkspaceIndex({
    configPath: ws.configPath,
    name: ws.name,
    repos: Object.fromEntries(ws.repos.filter((r) => r.instance === BASE_INSTANCE).map((r) => [r.name, r.path])),
  });
  try {
    if (fs.readFileSync(paths.workspaceFile, "utf8") === text) return;
  } catch {
    // Missing or unreadable: write it.
  }
  await mkdir(path.dirname(paths.workspaceFile), { recursive: true });
  const tmp = `${paths.workspaceFile}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, paths.workspaceFile);
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

// ---------------------------------------------------------------------------
// Supervised-process journal
// ---------------------------------------------------------------------------

/** Bumped if the record shape changes; a foreign version is ignored wholesale. */
const JOURNAL_VERSION = 1;

/** Where the journal lives inside a workspace's state dir. */
export function supervisedFile(stateDir: string): string {
  return path.join(stateDir, "supervised.json");
}

/**
 * One process the daemon spawned and still owns.
 *
 * `pgid` is the leader's own pid — services are spawned detached, so the leader
 * *is* the group — but it is recorded separately because signalling the group is
 * a different act from identifying the leader, and conflating the two is how a
 * reaper ends up killing a stranger.
 *
 * `startedAt` is the identity half of the record: a pid alone proves nothing
 * once the daemon has been dead long enough for the number to be handed out
 * again, so recovery compares this against the process's real start time.
 */
export interface SupervisedProcess {
  targetId: string;
  pid: number;
  pgid: number;
  /** Epoch ms of the spawn, as the supervisor saw it. */
  startedAt: number;
  /** The `kind: "service"` command that owns the process, if any. */
  via?: string;
  /** Enough of the definition to recognise it, and to report it honestly. */
  script: string;
  cwd: string;
  /** The supervisor's spawn-time fingerprint; recovery compares it for staleness. */
  fingerprint: string;
}

export interface SupervisedJournal {
  readonly file: string;
  /**
   * What the *previous* daemon left behind, frozen at construction. Reading it
   * later would return this daemon's own set, which is never what a recovery
   * pass wants.
   */
  inherited(): SupervisedProcess[];
  /** Records a spawn. Written through to disk before returning. */
  record(proc: SupervisedProcess): void;
  /** Drops a record once the process is gone; ignored if a newer spawn replaced it. */
  forget(targetId: string, pid: number): void;
  /** Flushes anything pending and stops the coalescing timer. */
  dispose(): Promise<void>;
}

export interface SupervisedJournalOptions {
  file: string;
  logger?: Logger;
}

/**
 * Never throws, and never guesses: a missing, truncated or foreign-version file
 * reads as "this daemon inherited nothing", and a record missing any field
 * recovery would act on is dropped rather than half-believed. Every field here
 * is used to decide whether to signal a process, so a partial record is worse
 * than no record.
 */
export function readSupervised(file: string): SupervisedProcess[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const doc = parsed as { version?: unknown; processes?: unknown };
  if (doc.version !== JOURNAL_VERSION || !Array.isArray(doc.processes)) return [];
  return doc.processes.filter(isSupervisedProcess);
}

function isSupervisedProcess(value: unknown): value is SupervisedProcess {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["targetId"] === "string" &&
    typeof rec["pid"] === "number" &&
    Number.isInteger(rec["pid"]) &&
    rec["pid"] > 0 &&
    typeof rec["pgid"] === "number" &&
    Number.isInteger(rec["pgid"]) &&
    rec["pgid"] > 0 &&
    typeof rec["startedAt"] === "number" &&
    Number.isFinite(rec["startedAt"]) &&
    typeof rec["script"] === "string" &&
    typeof rec["cwd"] === "string" &&
    typeof rec["fingerprint"] === "string" &&
    (rec["via"] === undefined || typeof rec["via"] === "string")
  );
}

/**
 * The on-disk record of what this daemon owns.
 *
 * A spawn is written **synchronously**, before the supervisor does anything
 * else with the handle: the window between `spawn()` returning and the record
 * landing is exactly the window in which a `kill -9` strands a service forever,
 * and it is worth a sub-millisecond write to a file the size of the service
 * list to close it. Removals are coalesced onto a timer instead — a record for
 * a process that has already exited is harmless (recovery finds the pid dead
 * and drops it), so `stopAll` over twenty services costs one write, not twenty.
 *
 * This is per *process*, not per log line: it moves only when a service starts
 * or stops.
 */
export function createSupervisedJournal(opts: SupervisedJournalOptions): SupervisedJournal {
  const logger = opts.logger ?? nullLogger;
  const previous = readSupervised(opts.file);
  const live = new Map<string, SupervisedProcess>();
  let pending: NodeJS.Timeout | undefined;
  let warned = false;

  const serialize = (): string =>
    `${JSON.stringify({ version: JOURNAL_VERSION, daemonPid: process.pid, processes: [...live.values()] }, null, 2)}\n`;

  /**
   * Atomic, and quiet about a state dir that has been deleted underneath us:
   * the daemon notices that separately and shuts down: see the watchdog in
   * `daemon.ts`. Failing a spawn over it would be a worse answer.
   */
  const flush = (): void => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
    const tmp = `${opts.file}.${process.pid.toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, serialize(), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, opts.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing further to do; the rename is what mattered.
      }
      // Once per daemon: a missing state dir would otherwise warn per transition.
      if (!warned) {
        warned = true;
        logger.warn(`cannot record supervised processes in ${opts.file}: ${errorMessage(err)}`);
      }
    }
  };

  const schedule = (): void => {
    if (pending !== undefined) return;
    pending = setTimeout(flush, 0);
    // Background, like every other daemon timer: nothing here may hold the
    // event loop open, and `dispose` flushes whatever is still queued.
    pending.unref();
  };

  return {
    file: opts.file,
    inherited: () => previous.map((proc) => ({ ...proc })),
    record(proc: SupervisedProcess): void {
      live.set(proc.targetId, { ...proc });
      flush();
    },
    forget(targetId: string, pid: number): void {
      // Only the record this exit belongs to: a target restarted while the
      // previous process was still winding down must not lose its new pid.
      if (live.get(targetId)?.pid !== pid) return;
      live.delete(targetId);
      schedule();
    },
    /** `flush` clears the timer itself, so a queued removal still lands. */
    async dispose(): Promise<void> {
      if (pending !== undefined) flush();
    },
  };
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/**
 * How far a live process's real start time may sit from the recorded spawn time
 * and still be believed to be the same process.
 *
 * `ps` reports whole seconds, and the supervisor stamps `startedAt` a
 * hair before `spawn()` returns, so the honest gap is milliseconds; two seconds
 * is slack for a loaded machine. A *recycled* pid cannot land inside it — that
 * would need the kernel to wrap the entire pid space within two seconds of our
 * own spawn.
 */
export const PID_IDENTITY_SLACK_MS = 2_000;

export interface ProcessInfo {
  pid: number;
  /** Epoch ms the kernel started this process, from `ps -o lstart`. */
  startedAt: number;
}

const run = promisify(execFile);

/**
 * Start times of whichever of `pids` are alive, keyed by pid.
 *
 * Rejects (rather than reporting an empty map) when `ps` itself could not run:
 * "no such process" and "I could not ask" have opposite consequences here — one
 * means a record is stale, the other must never be read as permission to signal
 * a process group.
 */
export async function inspectProcesses(pids: readonly number[]): Promise<Map<number, ProcessInfo>> {
  const out = new Map<number, ProcessInfo>();
  const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (wanted.length === 0) return out;

  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-p", wanted.join(","), "-o", "pid=,lstart="], { timeout: 5_000 }));
  } catch (err) {
    // `ps` exits non-zero when *none* of the pids exist, with nothing on stderr;
    // that is an answer, not a failure.
    const failure = err as { code?: unknown; stderr?: string; stdout?: string };
    const noMatch = typeof failure.code === "number" && (failure.stderr ?? "").trim().length === 0;
    if (!noMatch) throw err;
    stdout = failure.stdout ?? "";
  }

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const split = trimmed.indexOf(" ");
    if (split <= 0) continue;
    const pid = Number(trimmed.slice(0, split));
    // `lstart` prints local time without a zone, and a bare date string is what
    // `Date.parse` reads as local time — the two agree by construction.
    const startedAt = Date.parse(trimmed.slice(split + 1).trim());
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) continue;
    out.set(pid, { pid, startedAt });
  }
  return out;
}

/**
 * Pids of this user's processes whose command line *begins with* `needle`, or
 * `undefined` when the process table could not be read at all.
 *
 * The distinction is the whole point: "nothing matched" and "I could not look"
 * lead to opposite decisions in {@link file://./entry.ts}, where this is how a
 * starting daemon finds a predecessor whose pid file has been deleted.
 *
 * Anchored at the start, and not a substring search, because the consequence of
 * a false positive is a workspace that refuses to start a daemon at all — and a
 * substring matches every shell, editor, `grep` and `pgrep -f` whose own command
 * line quotes the title, including the one typed by whoever is debugging that
 * refusal. `process.title` replaces the argv area, so a real daemon's command
 * line starts with the title and nothing that merely mentions it does.
 *
 * Restricted to the calling user: the workspace id in a daemon's process title
 * is derived from the config path alone, so two people working in the same
 * checkout would otherwise each look like the other's rival.
 */
export async function findProcessesMatching(needle: string): Promise<number[] | undefined> {
  const uid = process.getuid?.();
  const args = uid === undefined ? ["-A"] : ["-U", String(uid)];
  let stdout: string;
  try {
    ({ stdout } = await run("ps", [...args, "-o", "pid=,command="], { timeout: 5_000, maxBuffer: 8 << 20 }));
  } catch {
    return undefined;
  }
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const split = trimmed.indexOf(" ");
    if (split <= 0) continue;
    if (!commandIs(trimmed.slice(split + 1), needle)) continue;
    const pid = Number(trimmed.slice(0, split));
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
}

/**
 * Whether a `ps` command line is `title`'s process rather than one that happens
 * to name it.
 *
 * The tail is whatever the platform leaves in the argv area after a shorter
 * title is written over it — the inherited environment block on macOS, padding
 * on Linux — so the match is "starts with, at a word boundary", never equality.
 */
export function commandIs(command: string, title: string): boolean {
  const trimmed = command.trimStart();
  return trimmed === title || trimmed.startsWith(`${title} `);
}

/** The command line of a live process, or `undefined` if it is gone or unreadable. */
export async function processCommand(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
    const command = stdout.trim();
    return command.length === 0 ? undefined : command;
  } catch {
    return undefined;
  }
}

/** True when the pid exists — including when it belongs to another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a process group still has members.
 *
 * `"foreign"` (EPERM) is kept apart from `"alive"` deliberately: a group we are
 * not allowed to signal is one we must not pretend to own.
 */
export function processGroupState(pgid: number): "alive" | "gone" | "foreign" {
  if (!Number.isInteger(pgid) || pgid <= 0) return "gone";
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return code === "EPERM" ? "foreign" : "gone";
  }
}
