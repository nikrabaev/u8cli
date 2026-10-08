/**
 * One-shot command execution — the primitive behind health `cmd` probes,
 * config-defined indicators and the plugin SDK's `exec()`.
 *
 * Two decisions worth remembering:
 *  - Commands run **detached**, in their own process group, so a `timeoutMs`
 *    kill takes out the whole tree. A script that backgrounds children would
 *    otherwise leak them past the timeout and keep our pipes open forever.
 *  - A non-zero exit is *data*, not an exception: probes and indicators fail
 *    constantly by design. The returned promise only rejects when the shell
 *    itself could not be spawned.
 */
import { spawn } from "node:child_process";
import { U8Error } from "../util/errors.js";
import type { ExecOptions, ExecResult } from "./types.js";

/** Captured output cap per stream when the caller does not set `maxBuffer`. */
export const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Default grace between the SIGTERM and the SIGKILL that follow a timeout/abort. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * How long to wait for stdio to close after the process exits. Normally `close`
 * follows `exit` within a tick; it never arrives at all when a backgrounded
 * grandchild inherited the pipes, and we must not hang on that.
 */
const EXIT_LINGER_MS = 250;

/** Appended to captured output that hit `maxBuffer`, so callers can see it happened. */
export const TRUNCATION_NOTICE = "[u8] output truncated";

/** The user's interactive shell, which is what config authors write scripts for. */
export function defaultShell(): string {
  const shell = process.env.SHELL;
  return shell !== undefined && shell.length > 0 ? shell : "/bin/sh";
}

/**
 * Head-biased output buffer: the first `cap` bytes are kept and the tail is
 * dropped, because the beginning of a failing command's output is what explains
 * the failure. Slicing happens on byte boundaries, so a multi-byte character
 * straddling the cap decodes to a replacement char.
 */
class Capture {
  private readonly chunks: Buffer[] = [];
  private len = 0;
  private dropped = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.len;
    if (room <= 0) {
      this.dropped += chunk.byteLength;
      return;
    }
    if (chunk.byteLength <= room) {
      this.chunks.push(chunk);
      this.len += chunk.byteLength;
      return;
    }
    this.chunks.push(chunk.subarray(0, room));
    this.len = this.cap;
    this.dropped += chunk.byteLength - room;
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8");
    if (this.dropped === 0) return body;
    return `${body}\n${TRUNCATION_NOTICE} at ${this.cap} bytes (${this.dropped} more dropped)\n`;
  }
}

/**
 * Runs `cmd` through a shell and resolves with its outcome.
 *
 * Unlike {@link spawnManaged}, `env` here is *merged over* `process.env`: callers
 * pass a handful of overrides and still expect `PATH` to work.
 *
 * @throws U8Error `PROCESS_FAILED` when the shell could not be spawned.
 */
export function exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const shell = opts.shell ?? defaultShell();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const startedAt = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    const stdin: "ignore" | "pipe" = opts.input === undefined ? "ignore" : "pipe";
    const child = spawn(shell, ["-c", cmd], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: true,
      stdio: [stdin, "pipe", "pipe"],
    });

    const stdout = new Capture(maxBuffer);
    const stderr = new Capture(maxBuffer);

    let settled = false;
    let timedOut = false;
    let code: number | null = null;
    let signal: string | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;
    let lingerTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(lingerTimer);
    };

    const killTree = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Already gone between the check and the signal — nothing to do.
        }
      }
    };

    let terminating = false;
    /**
     * Idempotent: a timeout and an abort can both fire, and a second SIGTERM
     * would only orphan the first escalation timer — which would then SIGKILL a
     * pid the OS may already have handed to someone else.
     */
    const terminate = (): void => {
      if (settled || terminating) return;
      terminating = true;
      killTree("SIGTERM");
      escalateTimer = setTimeout(() => {
        if (settled) return;
        killTree("SIGKILL");
      }, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };

    opts.signal?.addEventListener("abort", terminate, { once: true });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      opts.signal?.removeEventListener("abort", terminate);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      opts.signal?.removeEventListener("abort", terminate);
      reject(new U8Error("PROCESS_FAILED", `failed to spawn \`${cmd}\`: ${err.message}`, { cmd, cwd: opts.cwd }));
    });

    child.on("exit", (exitCode, exitSignal) => {
      code = exitCode;
      signal = exitSignal;
      lingerTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, EXIT_LINGER_MS);
    });

    child.on("close", (exitCode, exitSignal) => {
      code = exitCode ?? code;
      signal = exitSignal ?? signal;
      finish();
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // A command that exits without reading stdin gives us EPIPE; not a failure.
      });
      child.stdin.end(opts.input);
    }

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }

    // An already-aborted signal never dispatches to the listener above.
    if (opts.signal?.aborted === true) terminate();
  });
}
