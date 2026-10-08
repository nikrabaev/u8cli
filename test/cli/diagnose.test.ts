/**
 * What the CLI says after a run, judged by one question: does the command it
 * prints actually lead to the reason?
 *
 * A supervised process writes to its *service* log; the per-(run, target) log
 * gets only u8's own verdict ("exited with code 3"). So a failed `u8 start`
 * that points at `u8 logs <target> --run <id>` sends a first-time user to a
 * one-line file that repeats what they already read — the reason is in
 * `u8 logs <target>`, and every assertion here follows the printed command to
 * the end to prove it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanup,
  cleanupStateHome,
  cli,
  createWorkspace,
  service,
  type Workspace,
} from "./helpers.js";

let ws: Workspace;

/** The reason a start fails; it only ever reaches the service log. */
const CRITICAL = "CRITICAL: could not bind port 5432";

beforeAll(() => {
  ws = createWorkspace(
    {
      name: "diagnose",
      repos: {
        boom: { path: "boom", scripts: { start: `printf '%s\\n' '${CRITICAL}' >&2; exit 3` } },
        quiet: { path: "quiet", scripts: { start: service("quiet-ready") } },
        fleet: {
          path: "fleet",
          scripts: { start: "exit 1" },
          apps: { a: { path: "." }, b: { path: "." }, c: { path: "." }, d: { path: "." } },
        },
        // A `path` that resolves to a file: the shell is never spawned at all,
        // so this is the one start that has no process to hang a lifecycle on.
        nodir: { path: "u8.jsonc", scripts: { start: "true" } },
      },
      commands: {
        serve: {
          kind: "service",
          targets: {
            boom: `printf '%s\\n' 'SERVE: ${CRITICAL}' >&2; exit 4`,
            quiet: "sleep 30",
          },
          // Refuses `quiet` only, so one run carries a service failure *and* a
          // target aborted before anything was spawned for it.
          hooks: { pre: 'test "$(basename "$PWD")" != quiet || { printf \'hook refused\\n\' >&2; exit 9; }' },
        },
        unit: { script: "printf 'unit output here\\n'" },
        fails: { script: "printf 'unit blew up\\n' >&2; exit 5" },
      },
      profiles: { all: { default: true, targets: ["boom"] }, broken: { targets: ["nodir"] } },
    },
    ["boom", "quiet", "fleet"],
  );
});

afterAll(async () => {
  await cleanup();
  cleanupStateHome();
});

/** The hint the CLI printed, without the label in front of it. */
function hints(stderr: string): string[] {
  return [...stderr.matchAll(/u8 logs [^\s]+(?: --run [^\s]+)?/g)].map((m) => m[0]);
}

/** Runs a printed `u8 logs …` command exactly as it was printed. */
async function follow(hint: string): Promise<string> {
  const result = await cli(hint.split(" ").slice(1), { cwd: ws.dir });
  expect(result.code).toBe(0);
  return result.out;
}

describe("a failed service start", () => {
  it("points at the service log, which is where the reason is", async () => {
    const started = await cli(["start"], { cwd: ws.dir });

    expect(started.code).toBe(1);
    expect(hints(started.err)).toEqual(["u8 logs boom"]);
    expect(await follow("u8 logs boom")).toContain(CRITICAL);
  });

  it("points there for restart too", async () => {
    const restarted = await cli(["restart", "boom"], { cwd: ws.dir });

    expect(restarted.code).toBe(1);
    expect(hints(restarted.err)).toEqual(["u8 logs boom"]);
  });

  it('points there for a kind:"service" command as well', async () => {
    const run = await cli(["run", "serve", "boom"], { cwd: ws.dir });

    expect(run.code).toBe(1);
    expect(hints(run.err)).toEqual(["u8 logs boom"]);
    expect(await follow("u8 logs boom")).toContain(`SERVE: ${CRITICAL}`);
  });

  it("stops naming targets before the hints outgrow the table above them", async () => {
    const started = await cli(["start", "fleet"], { cwd: ws.dir });

    expect(started.code).toBe(1);
    expect(hints(started.err)).toEqual(["u8 logs fleet.a", "u8 logs fleet.b", "u8 logs fleet.c"]);
    // Truncation is announced, never silent: the table listed the fourth.
    expect(started.err).toContain("and 1 more");
    expect(started.out).toContain("fleet.d");
  });

  it("gives each target the form that fits it when a run mixes both", async () => {
    const run = await cli(["run", "serve", "boom", "quiet"], { cwd: ws.dir });
    const runId = /\(run ([^)]+)\)/.exec(run.out)?.[1] ?? "";

    expect(run.code).toBe(1);
    // `quiet` never reached the supervisor: its pre hook's output is in the run
    // log, and its service log holds nothing about this run at all.
    expect(hints(run.err)).toEqual(["u8 logs boom", `u8 logs quiet --run ${runId}`]);
    expect(await follow(`u8 logs quiet --run ${runId}`)).toContain("hook refused");
  });
});

describe("a task command", () => {
  it("keeps the --run form, where a task's output really is", async () => {
    const run = await cli(["run", "fails", "boom"], { cwd: ws.dir });
    const runId = /\(run ([^)]+)\)/.exec(run.out)?.[1] ?? "";

    expect(run.code).toBe(1);
    expect(hints(run.err)).toEqual([`u8 logs boom --run ${runId}`]);
    expect(await follow(`u8 logs boom --run ${runId}`)).toContain("unit blew up");
  });

  it("says where the output went when it succeeded", async () => {
    const run = await cli(["run", "unit", "boom"], { cwd: ws.dir });
    const runId = /\(run ([^)]+)\)/.exec(run.out)?.[1] ?? "";

    expect(run.code).toBe(0);
    expect(hints(run.err)).toEqual([`u8 logs boom --run ${runId}`]);
    expect(await follow(`u8 logs boom --run ${runId}`)).toContain("unit output here");
  });

  it("stays out of the way of the summary the run already printed", async () => {
    const run = await cli(["run", "unit", "boom"], { cwd: ws.dir });

    // The hint is a diagnostic: stdout stays the run's own report.
    expect(run.out).toContain("unit: 1 ok");
    expect(run.out).not.toContain("u8 logs");
  });
});

/**
 * The failure with no process behind it. `spawn(2)` rejects an unusable `cwd`
 * before there is anything to attach a lifecycle to, so this path never reaches
 * the exit handler every other failure goes through — and it must not therefore
 * skip what that handler is *for*: a line in the target's log, and a status that
 * is not the one a target nobody has touched shows.
 */
describe("a start that never got as far as a process", () => {
  it("still leaves the reason in the log its hint names", async () => {
    const started = await cli(["start", "nodir"], { cwd: ws.dir });

    expect(started.code).toBe(1);
    expect(hints(started.err)).toEqual(["u8 logs nodir"]);
    expect(await follow("u8 logs nodir")).toContain(`not a directory: ${ws.configPath}`);
  });

  it("leaves the target crashed rather than indistinguishable from untouched", async () => {
    await cli(["start", "nodir"], { cwd: ws.dir });
    const result = await cli(["status", "--json", "--profile", "broken"], { cwd: ws.dir });
    const json = JSON.parse(result.out) as {
      repos: Array<{ apps: Array<{ id: string; status: string; error: string | null }> }>;
    };
    const target = json.repos.flatMap((r) => r.apps).find((a) => a.id === "nodir");

    expect(target?.status).toBe("crashed");
    expect(target?.error).toContain(`not a directory: ${ws.configPath}`);
  });
});

describe("a successful service start", () => {
  it("says nothing about logs — there is no failure to explain", async () => {
    const started = await cli(["start", "quiet"], { cwd: ws.dir });

    expect(started.code).toBe(0);
    expect(hints(started.err)).toEqual([]);

    const stopped = await cli(["stop", "quiet"], { cwd: ws.dir });
    expect(stopped.code).toBe(0);
    expect(hints(stopped.err)).toEqual([]);
  });
});
