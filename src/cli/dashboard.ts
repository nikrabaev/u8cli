/**
 * `u8` with no arguments — the interactive dashboard (SPEC §9.1).
 *
 * The only decision this module makes is whether a dashboard is possible at
 * all. Ink needs a real terminal on both ends: raw-mode input to read keys and a
 * TTY to redraw over. When it does not have one — a pipe, a CI job, a test
 * driving `run(argv, io)` with captured streams — bare `u8` degrades to the
 * status view, which is the same rows the dashboard would have drawn.
 *
 * The check is deliberately about *identity*, not just `isTTY`: an injected
 * {@link CliIo} may claim to be a terminal while pointing at a capture buffer,
 * and rendering to `process.stdout` behind its back would scribble over whatever
 * the caller was building.
 */
import { loadWorkspaceFrom } from "../config/index.js";
import { ConfigError, isU8Error } from "../util/errors.js";
import { configPathOf, type CliContext } from "./context.js";
import { writeLine, type OutputStream } from "./io.js";
import { statusCommand, type StatusOptions } from "./status.js";

/** Streams for a dashboard, or `undefined` when this is not a real terminal. */
interface Terminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export async function dashboardCommand(ctx: CliContext, opts: StatusOptions = {}): Promise<number> {
  const terminal = terminalOf(ctx);
  if (terminal === undefined) {
    const code = await statusCommand(ctx, opts);
    writeLine(
      ctx.io.stderr,
      ctx.style.dim("(no terminal here — showing `u8 status`; run `u8` in a terminal for the interactive dashboard)"),
    );
    return code;
  }

  // Loaded on demand: Ink and React cost ~150ms to import, and `u8 status` in a
  // shell loop must not pay for a screen it will never draw.
  const { runDashboard } = await import("../tui/index.js");
  const configPath = configPathOf(ctx);
  try {
    return await runDashboard({
      configPath,
      ...terminal,
      color: ctx.color,
      signal: ctx.io.signal,
    });
  } catch (err) {
    throw explainLaunchFailure(err, configPath);
  }
}

/**
 * The same courtesy `withClient` does for every other subcommand: when the
 * daemon never came up, say what is wrong with `u8.jsonc` instead of quoting a
 * log tail (SPEC §5.1). Duplicated rather than imported because the CLI's copy
 * is private to `context.ts`, and this path does not go through it.
 */
function explainLaunchFailure(err: unknown, configPath: string): unknown {
  if (!isU8Error(err) || err.code !== "DAEMON_UNREACHABLE") return err;
  try {
    loadWorkspaceFrom(configPath);
  } catch (configErr) {
    return configErr instanceof ConfigError ? configErr : err;
  }
  return err;
}

function terminalOf(ctx: CliContext): Terminal | undefined {
  // The escape hatch for a terminal that cannot host the TUI (a dumb terminal,
  // an editor's embedded shell) — `u8` still has something useful to print.
  const disabled = ctx.io.env["U8_NO_TUI"];
  if (disabled !== undefined && disabled !== "" && disabled !== "0") return undefined;

  if (ctx.io.tty !== true) return undefined;
  if (ctx.io.stdout !== (process.stdout as unknown as OutputStream)) return undefined;
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return undefined;
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
}
