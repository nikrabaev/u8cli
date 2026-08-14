/**
 * The CLI's view of the process.
 *
 * Every command writes through a {@link CliIo} rather than touching
 * `process.stdout` directly, which is what lets the whole surface be driven
 * in-process by a test: `run(argv, io)` with captured streams behaves exactly
 * like the real binary, minus the fork. The fields are deliberately the *inputs*
 * a command may branch on — streams, cwd, env, TTY-ness, the interrupt signal —
 * so nothing below this module has to ask the process anything.
 */

/** The slice of a writable stream the CLI uses. `process.stdout` satisfies it. */
export interface OutputStream {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: OutputStream;
  stderr: OutputStream;
  /** Base directory for discovery and for resolving `--config` / `--cwd`. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Whether *stdout* is a terminal. Colour and any human-only decoration hang
   * off this alone: stderr being a terminal says nothing about the pipe the rows
   * are going into.
   */
  tty: boolean;
  /**
   * Aborted on Ctrl-C. Commands that stream (`logs -f`, a task run) race it and
   * return; everything else finishes normally, and a second Ctrl-C is the
   * process-level escape hatch (see `main.ts`).
   */
  signal?: AbortSignal;
}

/** The real process, wired to `process.stdout`/`stderr`. */
export function createProcessIo(signal?: AbortSignal): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    env: process.env,
    tty: process.stdout.isTTY === true,
    signal,
  };
}

export function writeLine(stream: OutputStream, text = ""): void {
  stream.write(`${text}\n`);
}

/** Writes each line separately so a captured stream keeps line boundaries. */
export function writeLines(stream: OutputStream, lines: readonly string[]): void {
  for (const line of lines) writeLine(stream, line);
}
