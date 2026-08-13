/**
 * Contract for the process layer. Kept type-only so the plugin SDK and the
 * engine can depend on it without pulling in node child_process machinery.
 */
import type { LogStream } from "../ipc/protocol.js";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the command after this many ms (SIGTERM, then SIGKILL). */
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  /** Defaults to `$SHELL`, falling back to `/bin/sh`. */
  shell?: string;
  /** Cap on captured output per stream; excess is dropped from the tail. */
  maxBuffer?: number;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
  durationMs: number;
  /** True when the exit was caused by an explicit stop() rather than the process itself. */
  requested: boolean;
}

export interface SpawnSpec {
  /** Shell string executed verbatim via `$SHELL -c`. */
  script: string;
  cwd: string;
  env: Record<string, string>;
  shell?: string;
}

export interface StopOptions {
  /** Grace period between SIGTERM and SIGKILL. */
  timeoutMs?: number;
  signal?: NodeJS.Signals;
}

/**
 * A running process owned by the supervisor. Implementations spawn into their own
 * process group so `stop()` can signal the whole tree.
 */
export interface ProcessHandle {
  readonly pid: number;
  readonly startedAt: number;
  /** Resolves once the process (and its group) has exited. */
  readonly exited: Promise<ProcessExit>;
  /** SIGTERM the group, escalating to SIGKILL after the grace period. */
  stop(opts?: StopOptions): Promise<ProcessExit>;
  /** Fire-and-forget signal to the group. */
  kill(signal?: NodeJS.Signals): void;
  /** Subscribe to line-oriented output; returns an unsubscribe function. */
  onOutput(cb: (stream: LogStream, text: string, ts: number) => void): () => void;
}
