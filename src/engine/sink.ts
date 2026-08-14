/**
 * Per-(run, target) output sink: one log file plus the live push stream.
 *
 * The writer is created lazily so a run that produces no output — the common
 * case for `app:start`, which delegates to the supervisor — leaves no empty
 * directory behind for `pruneTaskRuns` to shuffle around.
 */
import type { TargetId } from "../config/types.js";
import type { LogLine, LogStream } from "../ipc/protocol.js";
import { createLogWriter, type LogWriter } from "../process/index.js";
import type { Logger } from "../util/logger.js";

export interface TargetSink {
  readonly path: string;
  /** True once a line was written; decides whether a `logPath` is reported. */
  readonly written: boolean;
  line(stream: LogStream, text: string, ts?: number): void;
  /** An engine-authored notice (hook failure, exit code) on the `u8` stream. */
  note(text: string): void;
  close(): Promise<void>;
}

export interface TargetSinkOptions {
  path: string;
  runId: string;
  targetId: TargetId;
  maxBytes: number;
  logger: Logger;
  emit(line: LogLine): void;
}

export function createTargetSink(opts: TargetSinkOptions): TargetSink {
  let writer: LogWriter | null = null;
  let written = false;
  let closed = false;

  const write = (stream: LogStream, text: string, ts: number): void => {
    if (closed) return;
    written = true;
    // `keep: 1` bounds a runaway task without discarding the whole log: the run
    // directory is pruned as a unit later anyway.
    writer ??= createLogWriter({ path: opts.path, maxBytes: opts.maxBytes, keep: 1, logger: opts.logger });
    void writer.write(text, ts);
    opts.emit({ targetId: opts.targetId, runId: opts.runId, stream, ts, text });
  };

  return {
    path: opts.path,
    get written(): boolean {
      return written;
    },
    line(stream: LogStream, text: string, ts?: number): void {
      write(stream, text, ts ?? Date.now());
    },
    note(text: string): void {
      write("u8", text, Date.now());
    },
    async close(): Promise<void> {
      closed = true;
      await writer?.close();
      writer = null;
    },
  };
}
