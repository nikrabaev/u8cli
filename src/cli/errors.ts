/**
 * How a failure reaches the user.
 *
 * The rule (SPEC §9.2): anything u8 anticipated prints as a message, never as a
 * stack — a `U8Error` is a diagnosis, and a stack trace on top of it only buries
 * the sentence that matters. A `ConfigError` prints its whole issue list, and an
 * error nobody anticipated prints its stack, because that one is a bug report.
 *
 * Codes also carry a *next step*: the same taxonomy the daemon answers with is
 * where the hints below hang, so `CONFIG_NOT_FOUND` always ends up suggesting
 * `u8 init` no matter which layer raised it.
 */
import { ConfigError, isU8Error, type U8ErrorCode } from "../util/errors.js";
import type { Styler } from "./format.js";
import { writeLine, type CliIo } from "./io.js";

/** Exit code for any handled failure. `run` uses 1 for task failures too. */
export const EXIT_FAILURE = 1;

/** Ctrl-C: the shell convention (128 + SIGINT), so scripts can tell it apart. */
export const EXIT_INTERRUPTED = 130;

const HINTS: Partial<Record<U8ErrorCode, string>> = {
  CONFIG_NOT_FOUND: "run `u8 init` to create one",
  UNKNOWN_TARGET: "run `u8 status` to see the targets in this workspace",
  UNKNOWN_COMMAND: "run `u8 status --json` to see the commands this workspace defines",
  DAEMON_UNREACHABLE: "run `u8 daemon logs` to see why the daemon did not come up",
  DAEMON_VERSION_MISMATCH: "run `u8 daemon stop` once its services can be interrupted",
};

/** Prints `err` on stderr and returns the exit code the CLI should end with. */
export function reportError(err: unknown, io: CliIo, style: Styler): number {
  if (err instanceof ConfigError) {
    writeLine(io.stderr, style.red(err.format()));
    hint(io, style, err.code);
    return EXIT_FAILURE;
  }

  if (isU8Error(err)) {
    writeLine(io.stderr, `${style.red("error:")} ${err.message}`);
    known(io, style, err.details);
    // A message that already spells the next step out (config discovery does)
    // must not be told twice.
    const suggestion = HINTS[err.code];
    if (suggestion !== undefined && !err.message.includes(firstWords(suggestion))) {
      writeLine(io.stderr, style.dim(`  ${suggestion}`));
    }
    return EXIT_FAILURE;
  }

  const failure = err instanceof Error ? (err.stack ?? err.message) : String(err);
  writeLine(io.stderr, `${style.red("unexpected error:")} ${failure}`);
  return EXIT_FAILURE;
}

/** Daemon errors carry the valid alternatives; showing them saves a round trip. */
function known(io: CliIo, style: Styler, details: unknown): void {
  if (typeof details !== "object" || details === null) return;
  const list = (details as { known?: unknown }).known;
  if (!Array.isArray(list) || list.length === 0) return;
  const names = list.filter((v): v is string => typeof v === "string");
  if (names.length === 0) return;
  writeLine(io.stderr, style.dim(`  known: ${names.join(", ")}`));
}

function hint(io: CliIo, style: Styler, code: U8ErrorCode): void {
  const suggestion = HINTS[code];
  if (suggestion !== undefined) writeLine(io.stderr, style.dim(`  ${suggestion}`));
}

function firstWords(suggestion: string): string {
  return suggestion.split(" ").slice(0, 3).join(" ");
}
