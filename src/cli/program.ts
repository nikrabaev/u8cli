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
import {
  envCommand,
  execCommand,
  instanceAddCommand,
  instanceCreateCommand,
  instanceDestroyCommand,
  instanceInitCommand,
  instanceListCommand,
  instanceRemoveCommand,
  portsCommand,
  upCommand,
} from "./instance.js";
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
    const declared = sub(program, kind)
      .description(`${kind} services (defaults to the active profile, or the instance's apps)`)
      .argument("[targets...]", 'repos or "repo.app" ids')
      .option("--all", "every target of the instance, not just the active profile");
    // Stopping has nothing to wait for: it already reports once the process is gone.
    if (kind !== "stop") declared.option("--wait", "report only once each service is ready, not merely running");
    withGlobals(declared).action(
      async (targets: string[], opts: { all?: boolean; wait?: boolean }, cmd: Command) => {
        state.code = await taskCommand(context(cmd), { kind }, { targets, all: opts.all, wait: opts.wait });
      },
    );
  }

  withGlobals(
    sub(program, "up")
      .description("create this directory's instance if needed, initialise it, start it and wait until it is ready")
      .argument("[targets...]", "apps the instance runs when it is created; what to start otherwise")
      .option("--branch <name>", "branch for the worktrees a new instance needs (default: its name)")
      .option("--from <ref>", "where a new branch starts (default: the base checkout's HEAD)"),
  ).action(async (targets: string[], opts: { branch?: string; from?: string }, cmd: Command) => {
    state.code = await upCommand(context(cmd), targets, { branch: opts.branch, from: opts.from });
  });

  withGlobals(
    sub(program, "ports")
      .description("print the addresses of this instance's apps")
      .argument("[targets...]", 'repos or "repo.app" ids; defaults to every app of the instance')
      .option("--json", "machine-readable output"),
  ).action((targets: string[], opts: { json?: boolean }, cmd: Command) => {
    state.code = portsCommand(context(cmd), targets, { json: opts.json });
  });

  withGlobals(
    sub(program, "env")
      .description("print the environment the config gives an app in this instance")
      .argument("[target]", 'a repo or "repo.app" id; optional when the instance has one app')
      .option("--json", "machine-readable output"),
  ).action((target: string | undefined, opts: { json?: boolean }, cmd: Command) => {
    state.code = envCommand(context(cmd), target, { json: opts.json });
  });

  withGlobals(
    sub(program, "exec")
      .description("run a command in an app's directory with its environment: u8 exec api -- pnpm test")
      .argument("<target>", 'a repo or "repo.app" id')
      .argument("<command...>", "the command and its arguments, after --"),
  ).action(async (target: string, command: string[], _opts: unknown, cmd: Command) => {
    state.code = await execCommand(context(cmd), target, command);
  });

  const instance = sub(program, "instance").description("create, list, change and remove parallel copies of the workspace");
  withGlobals(sub(instance, "list").description("list the workspace's instances").option("--json", "machine-readable output")).action(
    async (opts: { json?: boolean }, cmd: Command) => {
      state.code = await instanceListCommand(context(cmd), { json: opts.json });
    },
  );
  withGlobals(
    sub(instance, "create")
      .description("create an instance: a worktree per repo, its own ports, then its init steps")
      .argument("<name>", "instance name")
      .argument("[targets...]", "repos or apps it runs; defaults to the active profile")
      .option("--branch <name>", "branch for its worktrees (default: the instance name)")
      .option("--from <ref>", "where a new branch starts (default: the base checkout's HEAD)")
      .option("--adopt <dir>", "use an existing git worktree instead of creating one (repeatable)", collect, [])
      .option("--path <repo=dir>", "use an existing directory for one repo (repeatable)", collect, [])
      .option("--set <name=value>", "override a ${vars.<name>} for this instance (repeatable)", collect, []),
  ).action(
    async (
      name: string,
      targets: string[],
      opts: { branch?: string; from?: string; adopt: string[]; path: string[]; set: string[] },
      cmd: Command,
    ) => {
      state.code = await instanceCreateCommand(context(cmd), name, targets, opts);
    },
  );
  withGlobals(
    sub(instance, "init").description("re-run an instance's init steps").argument("[name]", "defaults to this directory's instance"),
  ).action(async (name: string | undefined, _opts: unknown, cmd: Command) => {
    state.code = await instanceInitCommand(context(cmd), name);
  });
  withGlobals(
    sub(instance, "add")
      .description("add apps to an instance: a worktree for any repo it has none of, their own ports, then their init steps")
      .argument("<targets...>", "repos or apps to add, named as the config names them")
      .option("--branch <name>", "branch for a worktree it has to create (default: the branch the instance is on)")
      .option("--from <ref>", "where a new branch starts (default: the base checkout's HEAD)")
      .option("--adopt <dir>", "use an existing git worktree instead of creating one (repeatable)", collect, [])
      .option("--path <repo=dir>", "use an existing directory for one repo (repeatable)", collect, []),
  ).action(
    async (
      targets: string[],
      opts: { branch?: string; from?: string; adopt: string[]; path: string[] },
      cmd: Command,
    ) => {
      state.code = await instanceAddCommand(context(cmd), targets, opts);
    },
  );
  withGlobals(
    sub(instance, "remove")
      .description("take apps out of an instance: stop them, run their teardown and free their ports")
      .argument("<targets...>", "repos or apps to remove, named as the config names them")
      .option("--force", "remove them even if a teardown step fails")
      .option("--prune", "also give up the checkout of a repo left with no apps; a worktree u8 created must be clean")
      .option("--discard", "with --prune: remove the worktree even if it has uncommitted changes"),
  ).action(
    async (targets: string[], opts: { force?: boolean; prune?: boolean; discard?: boolean }, cmd: Command) => {
      state.code = await instanceRemoveCommand(context(cmd), targets, opts);
    },
  );
  withGlobals(
    sub(instance, "destroy")
      .description("stop an instance, run its teardown, remove the worktrees u8 created and free its ports")
      .argument("[name]", "defaults to this directory's instance")
      .option("--force", "remove it even if a teardown step fails"),
  ).action(async (name: string | undefined, opts: { force?: boolean }, cmd: Command) => {
    state.code = await instanceDestroyCommand(context(cmd), name, { force: opts.force });
  });

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
  withGlobals(
    sub(daemon, "stop")
      .description("stop the daemon and every instance's services")
      .option("--force", "also when other instances have services running"),
  ).action(async (opts: { force?: boolean }, cmd: Command) => {
    state.code = await daemonStopCommand(context(cmd), { force: opts.force });
  });
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
    .option("-i, --instance <name>", "act on this instance, not the one this directory belongs to")
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
  const instance = supplied("instance");
  return {
    config: typeof config === "string" ? config : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    color: typeof color === "boolean" ? color : undefined,
    instance: typeof instance === "string" ? instance : undefined,
  };
}

/** Accumulates a repeatable option into a list. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
