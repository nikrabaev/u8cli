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
  it("renders app headers, subapp rows and a merged row through the templates", async () => {
    const lines = await settledRows();

    expect(lines[0]).toContain("fixture");
    expect(lines[0]).toContain("profile all");
    expect(lines[0]).toContain("0/3 running");

    // `api` has one subapp, so it is one merged row rendered with the subapp
    // template — no "APP api" header above it.
    expect(lines).toContain("SUB api        stopped 1.2.3");
    expect(lines).not.toContain("APP api");

    // `platform` has two, so it gets a header plus a child row each.
    expect(lines).toContain("APP platform");
    expect(lines).toContain("SUB web        stopped 1.2.3");
    expect(lines).toContain("SUB admin      stopped 1.2.3");
  });

  it("marks an unknown token, and resolves app-scoped ones on a subapp row", async () => {
    const other = createWorkspace(
      {
        // `git@branch` is app-scoped; a subapp row that mentions it must fall
        // back to the app's cell rather than render the red unknown marker —
        // which is what the merged row of every one-app workspace depends on.
        templates: { subapp: "{app@name} {nope@zilch} [{git@branch}]" },
        apps: {
          solo: { path: "." },
          pair: { path: ".", subapps: { one: { path: "." }, two: { path: "." } } },
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
    const broken = createWorkspace({ plugins: ["./boom.mjs"], apps: { solo: { path: "." } } }, []);
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
    expect(result.out).toContain("SUB web");
    expect(result.out).not.toContain("SUB api");
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
    expect(result.out).toContain("SUB api");
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

    const api = json.apps.find((a) => a.name === "api");
    expect(api?.status).toBe("stopped");
    expect(api?.subapps).toHaveLength(1);
    const subapp = api?.subapps[0];
    expect(subapp?.id).toBe("api");
    expect(subapp?.implicit).toBe(true);
    expect(subapp?.status).toBe("stopped");
    expect(subapp?.pid).toBeNull();
    expect(subapp?.cwd).toBe(ws.file("api"));
    expect(subapp?.scripts).toEqual(["start"]);
    // Raw values, never the pre-rendered display.
    expect(subapp?.indicators["app@status"]).toBe("stopped");
    expect(subapp?.indicators["app@name"]).toBe("api");
    expect(subapp?.indicators["x@ver"]).toBe("1.2.3");

    const platform = json.apps.find((a) => a.name === "platform");
    expect(platform?.subapps.map((s) => s.id)).toEqual(["platform.web", "platform.admin"]);
  });

  it("reports the profile that was rendered and the one that is active", async () => {
    const result = await cli(["status", "--json", "--profile", "frontend"], { cwd: ws.dir });
    const json = JSON.parse(result.out) as StatusJson;

    expect(json.profile.name).toBe("frontend");
    expect(json.profile.active).toBe("all");
    expect(json.apps.map((a) => a.name)).toEqual(["platform"]);
    expect(json.apps[0]?.subapps.map((s) => s.id)).toEqual(["platform.web"]);
  });
});

describe("workspace selection", () => {
  it("--config drives a workspace from anywhere", async () => {
    const elsewhere = createWorkspace({ apps: { other: { path: "." } } });
    const result = await cli(["status", "--json", "--config", ws.configPath], { cwd: elsewhere.dir });

    const json = JSON.parse(result.out) as StatusJson;
    expect(json.workspace.configPath).toBe(ws.configPath);
  });

  it("--cwd moves discovery, and a relative --config resolves against it", async () => {
    const elsewhere = createWorkspace({ apps: { other: { path: "." } } });
    const viaCwd = await cli(["status", "--json", "--cwd", ws.dir], { cwd: elsewhere.dir });
    expect((JSON.parse(viaCwd.out) as StatusJson).workspace.name).toBe("fixture");

    const viaBoth = await cli(["status", "--json", "--cwd", ws.dir, "--config", "u8.jsonc"], {
      cwd: elsewhere.dir,
    });
    expect((JSON.parse(viaBoth.out) as StatusJson).workspace.configPath).toBe(ws.configPath);
  });
});
