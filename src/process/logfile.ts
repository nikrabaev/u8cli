/**
 * On-disk logs for services and task runs.
 *
 * Two properties matter more than throughput here:
 *  - **Whole lines.** Rotation happens *before* a line that would overflow the
 *    cap, never in the middle of one, so a tail of any single file always parses.
 *  - **Serialized writes.** Several producers (stdout, stderr, u8 notices) share
 *    one file; an internal queue keeps their lines from interleaving mid-line.
 */
import { open, mkdir, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TargetId } from "../config/types.js";
import { errorMessage } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import { safeSegment } from "../util/paths.js";

/** Matches `Limits.logMaxBytes` / `Limits.logKeep`. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/** Read granularity of the backward tail scan. */
const TAIL_CHUNK = 16 * 1024;

/** Upper bound on how many rotated generations `readLastLines` will walk. */
const MAX_ROTATION_WALK = 64;

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;

export interface LogWriterOptions {
  path: string;
  /** Rotate before the file would grow past this. Defaults to 10 MiB. */
  maxBytes?: number;
  /** How many rotated generations (`.1` … `.keep`) to retain. Defaults to 3. */
  keep?: number;
  logger?: Logger;
}

export interface LogWriter {
  readonly path: string;
  /**
   * Queues one line. The returned promise resolves once it (and everything
   * queued before it) is on disk, and never rejects — I/O failures are logged,
   * because losing a log line must not take down a service.
   *
   * After {@link LogWriter.close} the line is dropped rather than reopening the
   * file: the caller owns lifecycle ordering, and a late line must not resurrect
   * a handle the supervisor believes it released.
   */
  write(line: string, ts?: number): Promise<void>;
  /** Flushes the queue and releases the file handle. */
  close(): Promise<void>;
}

/** The on-disk line format: an ISO timestamp, a space, then the text. */
export function formatLogLine(text: string, ts: number): string {
  return `${new Date(ts).toISOString()} ${text}\n`;
}

/** Inverse of {@link formatLogLine}; `ts` is null for lines written by anything else. */
export function parseLogLine(raw: string): { ts: number | null; text: string } {
  const m = TIMESTAMP_RE.exec(raw);
  if (!m || m[1] === undefined || m[2] === undefined) return { ts: null, text: raw };
  const ts = Date.parse(m[1]);
  return { ts: Number.isNaN(ts) ? null : ts, text: m[2] };
}

export function createLogWriter(opts: LogWriterOptions): LogWriter {
  const filePath = opts.path;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_KEEP;
  const logger = opts.logger ?? nullLogger;

  let handle: FileHandle | null = null;
  let size = 0;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const ensureOpen = async (): Promise<FileHandle> => {
    if (handle) return handle;
    await mkdir(path.dirname(filePath), { recursive: true });
    const fh = await open(filePath, "a");
    size = (await fh.stat()).size;
    handle = fh;
    return fh;
  };

  const rotate = async (): Promise<void> => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (keep <= 0) {
      await rm(filePath, { force: true });
    } else {
      await rm(`${filePath}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) await renameIfExists(`${filePath}.${i}`, `${filePath}.${i + 1}`);
      await renameIfExists(filePath, `${filePath}.1`);
    }
    size = 0;
  };

  const doWrite = async (text: string): Promise<void> => {
    const buf = Buffer.from(text, "utf8");
    await ensureOpen();
    // A line longer than the whole cap still goes out in one piece: an oversized
    // file beats a torn line.
    if (size > 0 && size + buf.byteLength > maxBytes) await rotate();
    const fh = await ensureOpen();
    await fh.write(buf);
    size += buf.byteLength;
  };

  return {
    path: filePath,
    write(line: string, ts?: number): Promise<void> {
      if (closed) return queue;
      const text = formatLogLine(line, ts ?? Date.now());
      queue = queue.then(() => doWrite(text)).catch((err: unknown) => {
        logger.warn(`log write failed (${filePath}): ${errorMessage(err)}`);
      });
      return queue;
    },
    close(): Promise<void> {
      closed = true;
      queue = queue
        .then(async () => {
          if (!handle) return;
          const fh = handle;
          handle = null;
          await fh.close();
        })
        .catch((err: unknown) => {
          logger.warn(`log close failed (${filePath}): ${errorMessage(err)}`);
        });
      return queue;
    },
  };
}

/**
 * Last `n` lines, oldest first and still timestamp-prefixed (see
 * {@link parseLogLine}), read backward in chunks so tailing a 10 MiB log costs
 * one read. Walks into rotated generations when the current file is shorter than
 * `n`, so a fresh rotation does not blank out the log view.
 */
export async function readLastLines(filePath: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const generations: string[][] = [];
  let remaining = n;

  for (let i = 0; i <= MAX_ROTATION_WALK && remaining > 0; i++) {
    const p = i === 0 ? filePath : `${filePath}.${i}`;
    const lines = await tailFile(p, remaining);
    if (lines === null) break; // no such generation; nothing older exists
    generations.unshift(lines);
    remaining -= lines.length;
  }

  return generations.flat();
}

/** Last `n` lines of one file, or null when the file does not exist. */
async function tailFile(filePath: string, n: number): Promise<string[] | null> {
  let fh: FileHandle;
  try {
    fh = await open(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    let pos = (await fh.stat()).size;
    if (pos === 0) return [];

    let acc = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines <= n) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      const { bytesRead } = await fh.read(chunk, 0, len, pos);
      const read = chunk.subarray(0, bytesRead);
      acc = Buffer.concat([read, acc]);
      newlines += countNewlines(read);
    }

    let text = acc.toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    let lines = text.length === 0 ? [] : text.split("\n");
    // Stopped mid-file: the first element starts wherever the chunk boundary fell.
    if (pos > 0 && lines.length > 0) lines = lines.slice(1);
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
  return count;
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** `<serviceLogDir>/<target>.log` — one rotating file per subapp. */
export function serviceLogPath(dir: string, targetId: TargetId): string {
  return path.join(dir, `${safeSegment(targetId)}.log`);
}

/** `<taskLogDir>/<command>/<runId>/` — the unit `pruneTaskRuns` deletes. */
export function taskRunDir(dir: string, command: string, runId: string): string {
  return path.join(dir, safeSegment(command), safeSegment(runId));
}

/** `<taskLogDir>/<command>/<runId>/<target>.log` — one file per (run, target). */
export function taskRunLogPath(dir: string, command: string, runId: string, targetId: TargetId): string {
  return path.join(taskRunDir(dir, command, runId), `${safeSegment(targetId)}.log`);
}

/**
 * Drops the oldest run directories for a command, keeping the newest `keep`.
 *
 * Ordered by directory mtime rather than name: run ids are opaque to this layer
 * and need not sort chronologically.
 *
 * @returns the run ids that were deleted.
 */
export async function pruneTaskRuns(dir: string, command: string, keep: number): Promise<string[]> {
  const base = path.join(dir, safeSegment(command));
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const runs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => ({ name: e.name, mtimeMs: (await stat(path.join(base, e.name))).mtimeMs })),
  );
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const doomed = runs.slice(Math.max(0, keep));
  await Promise.all(doomed.map((r) => rm(path.join(base, r.name), { recursive: true, force: true })));
  return doomed.map((r) => r.name);
}
