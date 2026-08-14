/**
 * Supervised spawning of long-running services.
 *
 * The whole point of this module is that a service is a *tree*, not a process:
 * `pnpm dev` forks a bundler which forks a server. Spawning detached gives the
 * tree its own process group, and every signal we send goes to the group
 * (`kill(-pid)`) so nothing survives a stop.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { LogStream } from "../ipc/protocol.js";
import { nullLogger, type Logger } from "../util/logger.js";
import { defaultShell } from "./exec.js";
import type { ProcessExit, ProcessHandle, SpawnSpec, StopOptions } from "./types.js";

/** Matches `Limits.stopTimeoutMs`; callers normally pass the workspace's value. */
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** A single output line longer than this is split rather than buffered. */
const DEFAULT_MAX_LINE_LENGTH = 64 * 1024;

/** See the same constant in `exec.ts`: a leaked grandchild can hold the pipes open. */
const EXIT_LINGER_MS = 250;

export interface SpawnManagedOptions {
  /** Fallback grace for `stop()` when the call site does not supply one. */
  stopTimeoutMs?: number;
  /** Cap on one emitted line, in characters. Longer lines arrive as several. */
  maxLineLength?: number;
  logger?: Logger;
}

type OutputListener = (stream: LogStream, text: string, ts: number) => void;

/**
 * Spawns `spec.script` under a shell and returns a handle to the resulting group.
 *
 * `spec.env` is used **verbatim** — this layer never injects `process.env`. The
 * daemon owns that merge (daemon env → workspace → app → subapp) so that what
 * gets recorded as the spawn-time definition is exactly what the process saw.
 *
 * Spawn failures (a missing cwd, an unusable shell) surface as a `"u8"` output
 * line followed by `exited` resolving with a `null` code, because `ProcessHandle`
 * has no separate error channel.
 */
export function spawnManaged(spec: SpawnSpec, opts: SpawnManagedOptions = {}): ProcessHandle {
  const logger = opts.logger ?? nullLogger;
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const maxLineLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const startedAt = Date.now();

  const listeners = new Set<OutputListener>();
  const emit = (stream: LogStream, text: string, ts: number): void => {
    for (const cb of [...listeners]) {
      try {
        cb(stream, text, ts);
      } catch (err) {
        logger.warn("output listener threw", err);
      }
    }
  };

  const child = spawn(spec.shell ?? defaultShell(), ["-c", spec.script], {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    // stdin is /dev/null: a service that reads it should see EOF, never our tty.
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outReader = lineReader(child.stdout, "stdout", emit, maxLineLength);
  const errReader = lineReader(child.stderr, "stderr", emit, maxLineLength);

  let exit: ProcessExit | null = null;
  let requested = false;
  let pendingCode: number | null = null;
  let pendingSignal: string | null = null;
  let lingerTimer: NodeJS.Timeout | undefined;
  let resolveExited!: (e: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExited = resolve;
  });

  const settle = (code: number | null, signal: string | null): void => {
    if (exit) return;
    clearTimeout(lingerTimer);
    outReader.flush();
    errReader.flush();
    exit = { code, signal, durationMs: Date.now() - startedAt, requested };
    // A leader that exits on its own (`something & ...`) leaves its group behind,
    // and this handle is the last thing that knows the group's pgid: the
    // supervisor drops the handle as soon as `exited` resolves, so a later stop
    // has nothing to signal and the survivors are orphaned for good. Sweeping
    // here — not only in `doStop` — covers the self-exit path too. The exit is
    // already recorded, so the reported code/signal/`requested` are untouched.
    signalGroup("SIGKILL");
    resolveExited(exit);
  };

  child.on("exit", (code, signal) => {
    pendingCode = code;
    pendingSignal = signal;
    lingerTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(code, signal);
    }, EXIT_LINGER_MS);
  });

  child.on("close", (code, signal) => {
    settle(code ?? pendingCode, signal ?? pendingSignal);
  });

  child.on("error", (err) => {
    emit("u8", `spawn failed: ${err.message}`, Date.now());
    logger.error("spawn failed", { script: spec.script, cwd: spec.cwd, error: err.message });
    settle(null, null);
  });

  /**
   * Signals the whole group. Only ever called while the leader is alive, or in
   * the instant after it exits (`settle`, and `stop` once `exited` resolved):
   * POSIX keeps a pid reserved as a pgid for as long as the group still has
   * members, so `-pid` is either our survivors or nobody (ESRCH). Signalling any
   * later would risk addressing a stranger's group, once the OS is free to hand
   * the pid out again.
   */
  const signalGroup = (sig: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined || pid <= 0) return;
    try {
      process.kill(-pid, sig);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return; // already gone
      try {
        child.kill(sig);
      } catch {
        // Racing with exit; the caller's `exited` promise is the source of truth.
      }
    }
  };

  let stopping: Promise<ProcessExit> | null = null;

  const doStop = async (o?: StopOptions): Promise<ProcessExit> => {
    if (exit) return exit;
    requested = true;
    const grace = o?.timeoutMs ?? stopTimeoutMs;
    signalGroup(o?.signal ?? "SIGTERM");
    const escalate = setTimeout(() => signalGroup("SIGKILL"), grace);
    try {
      const result = await exited;
      // The leader may have obeyed SIGTERM while a child ignored it; sweep the
      // group before its members get orphaned.
      signalGroup("SIGKILL");
      return result;
    } finally {
      clearTimeout(escalate);
    }
  };

  return {
    pid: child.pid ?? -1,
    startedAt,
    exited,
    stop(o?: StopOptions): Promise<ProcessExit> {
      stopping ??= doStop(o);
      return stopping;
    },
    kill(signal: NodeJS.Signals = "SIGTERM"): void {
      if (exit) return;
      signalGroup(signal);
    },
    onOutput(cb: OutputListener): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * Turns a byte stream into lines: buffers partial lines across chunks, strips a
 * trailing `\r` so CRLF output is not rendered with stray carriage returns, and
 * hard-splits anything longer than `max` so a binary blob on stdout cannot grow
 * the buffer without bound.
 */
function lineReader(
  stream: Readable | null,
  tag: LogStream,
  emit: (stream: LogStream, text: string, ts: number) => void,
  max: number,
): { flush(): void } {
  let buf = "";

  const push = (raw: string, ts: number): void => {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    while (line.length > max) {
      emit(tag, line.slice(0, max), ts);
      line = line.slice(max);
    }
    emit(tag, line, ts);
  };

  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const ts = Date.now();
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      push(buf.slice(0, idx), ts);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
    while (buf.length > max) {
      emit(tag, buf.slice(0, max), ts);
      buf = buf.slice(max);
    }
  });

  return {
    /** Emits whatever the process wrote without a final newline. */
    flush(): void {
      if (buf.length === 0) return;
      const rest = buf;
      buf = "";
      push(rest, Date.now());
    },
  };
}
