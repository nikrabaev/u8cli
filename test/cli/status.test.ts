/**
 * `u8 status` — the rows, the `--json` contract, and the colour rules.
 *
 * The rows must come out of the template engine fed by the daemon's indicator
 * cache, so these tests use a workspace whose templates are distinctive enough
 * that a hand-rolled formatter could not accidentally produce them.
 */
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { STATUS_SCHEMA_VERSION, type StatusJson } from "../../src/cli/status.js";
import { stripAnsi } from "../../src/template/index.js";
import { VERSION } from "../../src/version.js";
import {
  cleanup,
  cleanupStateHome,
  cli,
  createWorkspace,
  fixtureConfig,
  fixtureDirs,
  waitFor,
  type Workspace,
} from "./helpers.js";

let ws: Workspace;

beforeAll(() => {
  ws = createWorkspace(fixtureConfig(), fixtureDirs());
});
afterAll(async () => {
  await cleanup();
  cleanupStateHome();
});
afterEach(() => undefined);

const ESC = "[";

/**
 * The rows, once every `x@ver` cell has been polled at least once.
 *
 * Config-defined indicators are staggered across targets at daemon start, so a
 * status taken in the first moments of a cold daemon legitimately shows a cell
 * that has not been evaluated yet. Polling for the settled view keeps the row
 * assertions exact instead of racy.
 */
async function settledRows(): Promise<string[]> {
  let lines: string[] = [];
  await waitFor(async () => {
    const result = await cli(["status"], { cwd: ws.dir });
    expect(result.code).toBe(0);
    lines = result.out.trimEnd().split("\n");
    return lines.filter((line) => line.includes("1.2.3")).length === 3;
  }, "every x@ver cell to be polled once");
  return lines;
}

describe("rows", () => {
  it("renders repo headers, app rows and a merged row through the templates", async () => {
    const lines = await settledRows();

    expect(lines[0]).toContain("fixture");
    expect(lines[0]).toContain("profile all");
    expect(lines[0]).toContain("0/3 running");

    // `api` has one app, so it is one merged row rendered with the app
    // template — no "REPO api" header above it.
    expect(lines).toContain("APP api        stopped 1.2.3");
    expect(lines).not.toContain("REPO api");

    // `platform` has two, so it gets a header plus a child row each.
    expect(lines).toContain("REPO platform");
    expect(lines).toContain("APP web        stopped 1.2.3");
    expect(lines).toContain("APP admin      stopped 1.2.3");
  });

  it("marks an unknown token, and resolves repo-scoped ones on an app row", async () => {
    const other = createWorkspace(
      {
        // `git@branch` is repo-scoped; an app row that mentions it must fall
        // back to the repo's cell rather than render the red unknown marker —
        // which is what the merged row of every one-repo workspace depends on.
        templates: { app: "{app@name} {nope@zilch} [{git@branch}]" },
        repos: {
          solo: { path: "." },
          pair: { path: ".", apps: { one: { path: "." }, two: { path: "." } } },
        },
      },
      [],
    );
    const result = await cli(["status"], { cwd: other.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("{nope@zilch!}");
    expect(result.out).not.toContain("{git@branch!}");
    // Not a git repo, so the cell exists and is empty: three rows, three `[]`.
    expect(result.out.match(/\[\]/g)).toHaveLength(3);
  });

  it("says on stderr when a plugin was disabled, and reports it in --json", async () => {
    const broken = createWorkspace({ plugins: ["./boom.mjs"], repos: { solo: { path: "." } } }, []);
    fs.writeFileSync(broken.file("boom.mjs"), "throw new Error('plugin exploded');\n", "utf8");

    const rows = await cli(["status"], { cwd: broken.dir });
    expect(rows.code).toBe(0);
    expect(rows.err).toContain("plugin");
    expect(rows.err).toContain("disabled");
    expect(rows.err).toContain("plugin exploded");
    // Diagnostics never contaminate the rows a pipe is reading.
    expect(rows.out).not.toContain("disabled");

    const json = JSON.parse((await cli(["status", "--json"], { cwd: broken.dir })).out) as StatusJson;
    const failed = json.plugins.find((p) => !p.ok);
    expect(failed?.spec).toBe("./boom.mjs");
    expect(failed?.error).toContain("plugin exploded");
  });

  it("renders only the requested profile, without switching it", async () => {
    const result = await cli(["status", "--profile", "frontend"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("APP web");
    expect(result.out).not.toContain("APP api");
    expect(result.out).toContain("(active: all)");
  });

  it("lists the known profiles when asked for one that does not exist", async () => {
    const result = await cli(["status", "--profile", "nope"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown profile "nope"');
    expect(result.err).toContain("known: all, frontend");
  });

  it("shows the status view and a TUI note for a bare `u8`", async () => {
    const result = await cli([], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("APP api");
    // The note is on stderr so `u8 | …` still sees rows only.
    expect(result.err).toContain("interactive dashboard");
    expect(result.out).not.toContain("interactive dashboard");
  });
});

describe("colour", () => {
  it("emits none when stdout is not a terminal", async () => {
    const result = await cli(["status"], { cwd: ws.dir });
    expect(result.out).not.toContain(ESC);
    expect(result.err).not.toContain(ESC);
  });

  it("emits colour on a terminal, including the status dot", async () => {
    const result = await cli(["status"], { cwd: ws.dir, tty: true });
    expect(result.out).toContain(ESC);
    expect(result.out).toContain("●");
  });

  it("obeys NO_COLOR and --no-color even on a terminal", async () => {
    const noColorEnv = await cli(["status"], { cwd: ws.dir, tty: true, env: { NO_COLOR: "1" } });
    expect(noColorEnv.out).not.toContain(ESC);

    const flag = await cli(["status", "--no-color"], { cwd: ws.dir, tty: true });
    expect(flag.out).not.toContain(ESC);

    // Global options work on either side of the subcommand.
    const before = await cli(["--no-color", "status"], { cwd: ws.dir, tty: true });
    expect(before.out).not.toContain(ESC);
  });

  it("spells the status out when it cannot colour the dot", async () => {
    const piped = await cli(["status"], { cwd: ws.dir });
    expect(piped.out).toContain("stopped");
    expect(piped.out).not.toContain("●");

    const terminal = await cli(["status"], { cwd: ws.dir, tty: true });
    expect(stripAnsi(terminal.out)).not.toContain("stopped");
  });
});

describe("--json", () => {
  it("is a stable, documented, never-coloured shape", async () => {
    const result = await cli(["status", "--json"], { cwd: ws.dir, tty: true, env: { FORCE_COLOR: "1" } });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(ESC);

    const json = JSON.parse(result.out) as StatusJson;
    expect(json.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(json.version).toBe(VERSION);
    expect(json.daemonVersion).toBe(VERSION);
    expect(json.workspace.name).toBe("fixture");
    expect(json.workspace.configPath).toBe(ws.configPath);
    expect(json.profile).toEqual({
      name: "all",
      active: "all",
      targets: ["api", "platform.web", "platform.admin"],
    });
    expect(json.profiles.map((p) => p.name)).toEqual(["all", "frontend"]);
    expect(json.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(["app:start", "app:stop", "app:restart", "greet", "flaky"]),
    );
    expect(json.configError).toBeNull();

    const api = json.repos.find((r) => r.name === "api");
    expect(api?.status).toBe("stopped");
    expect(api?.apps).toHaveLength(1);
    const app = api?.apps[0];
    expect(app?.id).toBe("api");
    expect(app?.implicit).toBe(true);
    expect(app?.status).toBe("stopped");
    expect(app?.pid).toBeNull();
    expect(app?.cwd).toBe(ws.file("api"));
    expect(app?.scripts).toEqual(["start"]);
    // Raw values, never the pre-rendered display.
    expect(app?.indicators["app@status"]).toBe("stopped");
    expect(app?.indicators["app@name"]).toBe("api");
    expect(app?.indicators["x@ver"]).toBe("1.2.3");

    const platform = json.repos.find((r) => r.name === "platform");
    expect(platform?.apps.map((a) => a.id)).toEqual(["platform.web", "platform.admin"]);
  });

  it("reports the profile that was rendered and the one that is active", async () => {
    const result = await cli(["status", "--json", "--profile", "frontend"], { cwd: ws.dir });
    const json = JSON.parse(result.out) as StatusJson;

    expect(json.profile.name).toBe("frontend");
    expect(json.profile.active).toBe("all");
    expect(json.repos.map((r) => r.name)).toEqual(["platform"]);
    expect(json.repos[0]?.apps.map((a) => a.id)).toEqual(["platform.web"]);
  });
});

describe("workspace selection", () => {
  it("--config drives a workspace from anywhere", async () => {
    const elsewhere = createWorkspace({ repos: { other: { path: "." } } });
    const result = await cli(["status", "--json", "--config", ws.configPath], { cwd: elsewhere.dir });

    const json = JSON.parse(result.out) as StatusJson;
    expect(json.workspace.configPath).toBe(ws.configPath);
  });

  it("--cwd moves discovery, and a relative --config resolves against it", async () => {
    const elsewhere = createWorkspace({ repos: { other: { path: "." } } });
    const viaCwd = await cli(["status", "--json", "--cwd", ws.dir], { cwd: elsewhere.dir });
    expect((JSON.parse(viaCwd.out) as StatusJson).workspace.name).toBe("fixture");

    const viaBoth = await cli(["status", "--json", "--cwd", ws.dir, "--config", "u8.jsonc"], {
      cwd: elsewhere.dir,
    });
    expect((JSON.parse(viaBoth.out) as StatusJson).workspace.configPath).toBe(ws.configPath);
  });
});

// ---------------------------------------------------------------------------
// Directories that are not there
// ---------------------------------------------------------------------------

/**
 * A `path` that names nothing is the likeliest mistake in a first config, and
 * the one the status table is least able to show: a target that cannot possibly
 * start renders as `stopped`, which is exactly how a target nobody has started
 * yet renders. The rows cannot say it — they are templated, and the template is
 * the user's — so the diagnostic goes to stderr beside the config and plugin
 * ones, and `--json` stays byte-for-byte what a script already parses.
 */
describe("a target whose directory is not there", () => {
  it("says so rather than presenting it as an ordinary stopped target", async () => {
    const broken = createWorkspace(
      {
        name: "broken",
        repos: {
          api: { path: "api", scripts: { start: "true" } },
          legacy: { path: "legacy", scripts: { start: "true" } },
        },
        profiles: { all: { default: true, targets: ["api", "legacy"] } },
      },
      // `legacy` is deliberately not created: the repo that was never cloned.
      ["api"],
    );

    const result = await cli(["status"], { cwd: broken.dir });

    expect(result.code).toBe(0);
    expect(stripAnsi(result.out)).toContain("legacy");
    expect(stripAnsi(result.err)).toContain(
      `legacy cannot start: no such directory: ${broken.file("legacy")}`,
    );
    // And nothing at all about the repo that is fine.
    expect(stripAnsi(result.err)).not.toContain("api cannot start");
  });

  it("distinguishes a path that exists but is a file", async () => {
    const broken = createWorkspace(
      {
        name: "notdir",
        repos: { api: { path: "u8.jsonc", scripts: { start: "true" } } },
        profiles: { all: { default: true, targets: ["api"] } },
      },
      [],
    );

    const result = await cli(["status"], { cwd: broken.dir });

    expect(stripAnsi(result.err)).toContain(
      `api cannot start: not a directory: ${broken.file("u8.jsonc")}`,
    );
  });

  it("names the app when the app's own path is the missing one", async () => {
    const broken = createWorkspace(
      {
        name: "sub",
        repos: {
          platform: {
            path: "platform",
            apps: {
              web: { path: "web", scripts: { start: "true" } },
              admin: { path: "admin", scripts: { start: "true" } },
            },
          },
        },
        profiles: { all: { default: true, targets: ["platform"] } },
      },
      ["platform/web"],
    );

    const result = await cli(["status"], { cwd: broken.dir });
    const err = stripAnsi(result.err);

    expect(err).toContain(`platform.admin cannot start: no such directory: ${broken.file("platform/admin")}`);
    expect(err).not.toContain("platform.web cannot start");
  });

  it("stays silent when every directory is really there", async () => {
    const result = await cli(["status"], { cwd: ws.dir });
    expect(stripAnsi(result.err)).not.toContain("cannot start");
  });
});
