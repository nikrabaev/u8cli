/**
 * The commander program: argv in, one subcommand call out.
 *
 * Two conventions worth knowing before editing this file:
 *
 *  - **Nothing here talks to the process.** Output goes through the injected
 *    {@link CliIo}, `exitOverride` turns commander's own exits into throws, and
 *    the chosen exit code is written into a shared cell. That is what makes
 *    `run(argv, io)` a pure-ish function a test can call directly.
 *  - **Global options are accepted on both sides of the subcommand.** `u8
 *    --cwd x status` and `u8 status --cwd x` must both work, so the three
 *    globals are declared on the program *and* on every subcommand, then
 *    resolved by preferring whichever one the user actually typed
 *    ({@link resolveGlobals}) — a subcommand's *default* must never shadow a
 *    value given on the program.
 */
import { Command, InvalidArgumentError } from "commander";

import { VERSION } from "../version.js";
import { createContext, type CliContext, type GlobalOptions } from "./context.js";
import { daemonLogsCommand, daemonStatusCommand, daemonStopCommand } from "./daemon.js";
import { dashboardCommand } from "./dashboard.js";
import { EXIT_FAILURE } from "./errors.js";
import { initCommand } from "./init.js";
import type { CliIo } from "./io.js";
import { logsCommand } from "./logs.js";
import { profileListCommand, profileUseCommand } from "./profile.js";
import { statusCommand } from "./status.js";
import { taskCommand } from "./tasks.js";

/** Where an action reports its exit code and the context it built. */
export interface ProgramState {
  code: number;
  /** Kept so the top-level error printer styles with the user's colour choice. */
  ctx?: CliContext;
}

export function buildProgram(io: CliIo, state: ProgramState): Command {
  const program = new Command();
  const context = (cmd: Command): CliContext => {
    const ctx = createContext(io, resolveGlobals(cmd));
    state.ctx = ctx;
    return ctx;
  };

  program
    .name("u8")
    .description("workspace-scoped orchestrator for long-running microservice apps")
    .version(VERSION, "-V, --version", "print the u8 version")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => void io.stdout.write(str),
      writeErr: (str) => void io.stderr.write(str),
    })
    .showHelpAfterError("(run `u8 --help` for usage)")
    .showSuggestionAfterError()
    // The bare-`u8` action is what makes commander hand an unrecognised name to
    // the program instead of rejecting it; excess arguments are allowed through
    // so the action can call it what it is rather than let commander report
    // "too many arguments" for a plain typo.
    .allowExcessArguments(true);
  withGlobals(program);

  // `u8` alone: the TUI's slot until Phase 11 fills it.
  program.action(async (_opts: unknown, cmd: Command) => {
    const unknown = cmd.args[0];
    if (unknown !== undefined) {
      cmd.error(`error: unknown command '${unknown}'`, { exitCode: EXIT_FAILURE, code: "commander.unknownCommand" });
    }
    state.code = await dashboardCommand(context(cmd));
  });

  sub(program, "init")
    .description("write a commented u8.jsonc skeleton in the current directory")
    .action((_opts: unknown, cmd: Command) => {
      state.code = initCommand(context(cmd));
    });

  for (const kind of ["start", "stop", "restart"] as const) {
    withGlobals(
      sub(program, kind)
        .description(`${kind} services (defaults to the active profile)`)
        .argument("[targets...]", 'repos or "repo.app" ids')
        .option("--all", "every target in the workspace, not just the active profile"),
    ).action(async (targets: string[], opts: { all?: boolean }, cmd: Command) => {
      state.code = await taskCommand(context(cmd), { kind }, { targets, all: opts.all });
    });
  }

  withGlobals(
    sub(program, "run")
      .description("run a command against targets")
      .argument("<command>", "command name (e.g. test, git:pull)")
      .argument("[targets...]", 'repos or "repo.app" ids; defaults to the active profile')
      .option("--serial", "run one target at a time")
      .option("--concurrency <n>", "maximum targets running at once", positiveInt),
  ).action(
    async (
      command: string,
      targets: string[],
      opts: { serial?: boolean; concurrency?: number },
      cmd: Command,
    ) => {
      state.code = await taskCommand(
        context(cmd),
        { kind: "run", command, serial: opts.serial, concurrency: opts.concurrency },
        { targets },
      );
    },
  );

  withGlobals(
    sub(program, "status")
      .description("show the profile's repos and apps")
      .option("--json", "machine-readable output (never coloured)")
      .option("--profile <name>", "render this profile instead of the active one"),
  ).action(async (opts: { json?: boolean; profile?: string }, cmd: Command) => {
    state.code = await statusCommand(context(cmd), { json: opts.json, profile: opts.profile });
  });

  withGlobals(
    sub(program, "logs")
      .description("print (and optionally follow) a target's log")
      .argument("<target>", 'a repo or "repo.app" id')
      .option("-f, --follow", "keep streaming until interrupted")
      .option("-n, --lines <n>", "how many lines to backfill", nonNegativeInt)
      .option("--run <runId>", "read a task run's log instead of the service log"),
  ).action(
    async (
      target: string,
      opts: { follow?: boolean; lines?: number; run?: string },
      cmd: Command,
    ) => {
      state.code = await logsCommand(context(cmd), target, {
        follow: opts.follow,
        lines: opts.lines,
        run: opts.run,
      });
    },
  );

  const profile = sub(program, "profile").description("inspect and switch profiles");
  withGlobals(sub(profile, "list").description("list the workspace's profiles")).action(
    async (_opts: unknown, cmd: Command) => {
      state.code = await profileListCommand(context(cmd));
    },
  );
  withGlobals(
    sub(profile, "use").description("switch the active profile").argument("<name>", "profile name"),
  ).action(async (name: string, _opts: unknown, cmd: Command) => {
    state.code = await profileUseCommand(context(cmd), name);
  });

  const daemon = sub(program, "daemon").description("inspect and control the workspace daemon");
  withGlobals(sub(daemon, "status").description("report the daemon's state")).action(
    async (_opts: unknown, cmd: Command) => {
      state.code = await daemonStatusCommand(context(cmd));
    },
  );
  withGlobals(sub(daemon, "stop").description("stop the daemon and its services")).action(
    async (_opts: unknown, cmd: Command) => {
      state.code = await daemonStopCommand(context(cmd));
    },
  );
  withGlobals(
    sub(daemon, "logs")
      .description("print the daemon log")
      .option("-f, --follow", "keep streaming until interrupted")
      .option("-n, --lines <n>", "how many lines to print", nonNegativeInt),
  ).action(async (opts: { follow?: boolean; lines?: number }, cmd: Command) => {
    state.code = await daemonLogsCommand(context(cmd), { follow: opts.follow, lines: opts.lines });
  });

  return program;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Declares a subcommand that rejects arguments it has no use for.
 *
 * Commander copies a parent's settings into every command created under it, and
 * the program permits excess arguments so that a bare `u8 bogus` can be reported
 * as an unknown *command* rather than a stray operand. That permission must not
 * reach the subcommands: `u8 status api` is somebody expecting a filter, and
 * silently printing the whole profile with exit 0 is the one answer that teaches
 * them nothing.
 */
function sub(parent: Command, name: string): Command {
  return parent.command(name).allowExcessArguments(false);
}

function withGlobals(cmd: Command): Command {
  return cmd
    .option("--config <path>", "path to u8.jsonc, skipping upward discovery")
    .option("--cwd <dir>", "act as if u8 was started in <dir>")
    .option("--no-color", "never emit ANSI colour");
}

/**
 * The effective global options for the command that is running.
 *
 * Walks leaf → root and takes the first value the *user supplied* (commander
 * tracks that as the option's "source"), so the duplicated declarations never
 * fight: a subcommand's untouched default cannot override `u8 --no-color
 * status`, and typing it on either side wins over nothing.
 */
function resolveGlobals(leaf: Command): GlobalOptions {
  const chain: Command[] = [];
  for (let cmd: Command | null = leaf; cmd !== null; cmd = cmd.parent) chain.push(cmd);

  const supplied = (name: string): unknown => {
    for (const cmd of chain) {
      const source = cmd.getOptionValueSource(name);
      if (source !== undefined && source !== "default") return cmd.getOptionValue(name);
    }
    return undefined;
  };

  const config = supplied("config");
  const cwd = supplied("cwd");
  const color = supplied("color");
  return {
    config: typeof config === "string" ? config : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    color: typeof color === "boolean" ? color : undefined,
  };
}

function positiveInt(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return value;
}

function nonNegativeInt(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError("expected a non-negative integer");
  }
  return value;
}
