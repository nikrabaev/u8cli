/**
 * The CLI's single entry point: argv + io → exit code.
 *
 * `main.ts` is a four-line wrapper over this, and the tests drive it directly —
 * which is the reason it returns a code instead of exiting: an in-process test
 * can assert on the code and the captured streams without spawning node for
 * every case.
 */
import { CommanderError } from "commander";

import { reportError } from "./errors.js";
import { createStyler, shouldUseColor } from "./format.js";
import type { CliIo } from "./io.js";
import { buildProgram, type ProgramState } from "./program.js";

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const state: ProgramState = { code: 0 };
  const program = buildProgram(io, state);

  try {
    await program.parseAsync([...argv], { from: "user" });
    return state.code;
  } catch (err) {
    // Help, `--version` and usage errors: commander has already written the
    // text through our streams and decided the code (0 for help/version).
    if (err instanceof CommanderError) return err.exitCode;
    // The action may have built a context (and with it the colour decision)
    // before failing; fall back to the environment when it did not get that far.
    const style = state.ctx?.style ?? createStyler(shouldUseColor(io, undefined));
    return reportError(err, io, style);
  }
}
