/**
 * `u8 init` — the one command that must work before anything else exists, and
 * therefore the one command that must never touch the daemon: there is no
 * workspace to run one for yet.
 */
import path from "node:path";

import { writeSkeletonConfig } from "../config/index.js";
import type { CliContext } from "./context.js";
import { writeLine } from "./io.js";

export function initCommand(ctx: CliContext): number {
  const written = writeSkeletonConfig(ctx.cwd);
  writeLine(ctx.io.stdout, `created ${path.relative(ctx.io.cwd, written) || written}`);
  writeLine(ctx.io.stdout, ctx.style.dim("edit the apps you want u8 to run, then: u8 status"));
  return 0;
}
