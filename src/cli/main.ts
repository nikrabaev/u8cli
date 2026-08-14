#!/usr/bin/env node
/**
 * The `u8` binary.
 *
 * All it owns is the process: argv, the streams, and what Ctrl-C means. The
 * first interrupt is *not* a kill — it aborts the signal the streaming commands
 * race, so `u8 logs -f` and a task run detach cleanly while the daemon and its
 * services keep running (SPEC §5.1). A second one is the escape hatch for a
 * command that is stuck somewhere it cannot check the signal.
 *
 * The handlers come off before the process is allowed to end: a registered
 * signal listener is a live handle, and leaving one on would keep an otherwise
 * finished CLI resident.
 */
import { createProcessIo } from "./io.js";
import { EXIT_FAILURE, EXIT_INTERRUPTED } from "./errors.js";
import { run } from "./run.js";

/**
 * A closed pipe is not a crash.
 *
 * `u8 status | head -3` closes stdout while u8 is still writing; Node turns that
 * into an asynchronous `EPIPE` error event, and an unhandled one prints a stack
 * trace for a completely ordinary shell idiom. The reader is gone, so there is
 * nothing left to say and no stream left to say it on: end quietly, the way a
 * SIGPIPE-terminated program would.
 */
const onStreamError = (err: NodeJS.ErrnoException): void => {
  process.exit(err.code === "EPIPE" ? 0 : EXIT_FAILURE);
};
process.stdout.on("error", onStreamError);
process.stderr.on("error", onStreamError);

const controller = new AbortController();
let interrupts = 0;

const onInterrupt = (): void => {
  interrupts += 1;
  if (interrupts === 1) {
    controller.abort();
    return;
  }
  process.exit(EXIT_INTERRUPTED);
};

process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

const done = (code: number): void => {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  process.exitCode = code;
};

run(process.argv.slice(2), createProcessIo(controller.signal)).then(done, (err: unknown) => {
  process.stderr.write(`u8 crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  done(1);
});
