/**
 * `u8` with no arguments.
 *
 * This is the seam the TUI lands on (PLAN Phase 11): the interactive dashboard
 * replaces the body of {@link dashboardCommand} and nothing else in the CLI
 * moves. Until then a bare `u8` prints the status view — the same rows the
 * dashboard will draw — plus one line saying where the interactive version is.
 */
import { statusCommand, type StatusOptions } from "./status.js";
import type { CliContext } from "./context.js";
import { writeLine } from "./io.js";

export async function dashboardCommand(ctx: CliContext, opts: StatusOptions = {}): Promise<number> {
  const code = await statusCommand(ctx, opts);
  writeLine(
    ctx.io.stderr,
    ctx.style.dim("(the interactive dashboard arrives with the TUI; showing `u8 status` for now)"),
  );
  return code;
}
