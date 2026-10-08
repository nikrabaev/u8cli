/**
 * The parts of `u8` that must work before a workspace or a daemon exists:
 * argv handling, `init`, and the errors a user hits on their first run.
 *
 * Every case here asserts that no daemon was spawned — `u8 init` and
 * `u8 --version` on a machine with no config must not leave a state dir, let
 * alone a background process, behind.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadWorkspaceFrom } from "../../src/config/index.js";
import { VERSION } from "../../src/version.js";
import { cleanup, cleanupStateHome, cli, createEmptyDir, createWorkspace } from "./helpers.js";

afterEach(cleanup);
afterAll(cleanupStateHome);

describe("u8 --version / --help", () => {
  it("prints the version and starts nothing", async () => {
    const ws = createEmptyDir();
    const result = await cli(["--version"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(VERSION);
    expect(fs.existsSync(ws.paths.dir)).toBe(false);
  });

  it("lists every subcommand", async () => {
    const ws = createEmptyDir();
    const result = await cli(["--help"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    for (const name of ["init", "start", "stop", "restart", "run", "status", "logs", "profile", "daemon"]) {
      expect(result.out).toContain(name);
    }
  });

  it("names an unknown command instead of guessing", async () => {
    const ws = createEmptyDir();
    const result = await cli(["bogus"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain("unknown command 'bogus'");
    expect(result.err).toContain("u8 --help");
  });

  it("refuses arguments a subcommand has no use for", async () => {
    // `u8 status api` is somebody expecting a filter. Printing the whole
    // profile and exiting 0 would teach them nothing.
    const real = createWorkspace({ repos: { api: { path: "." } } });
    const status = await cli(["status", "api"], { cwd: real.dir });
    expect(status.code).not.toBe(0);
    expect(status.err).toContain("too many arguments");
    expect(status.out).toBe("");

    // And the refusal comes before any daemon is spawned to serve the request.
    const ws = createEmptyDir();
    for (const argv of [
      ["status", "api"],
      ["logs", "api", "extra"],
      ["profile", "use", "dev", "extra"],
      ["daemon", "status", "extra"],
      ["init", "extra"],
    ]) {
      const result = await cli(argv, { cwd: ws.dir });
      expect(result.code, argv.join(" ")).not.toBe(0);
      expect(result.err, argv.join(" ")).toContain("too many arguments");
    }
    expect(fs.existsSync(ws.paths.dir)).toBe(false);
    expect(fs.existsSync(ws.configPath)).toBe(false);

    // The variadic commands still take as many targets as they are given.
    expect((await cli(["start", "a", "b", "c"], { cwd: ws.dir })).err).not.toContain("too many arguments");
  });

  it("rejects a nonsensical option value with a usage error", async () => {
    const ws = createEmptyDir();
    const result = await cli(["run", "greet", "--concurrency", "0"], { cwd: ws.dir });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("positive integer");
    expect(fs.existsSync(ws.paths.dir)).toBe(false);
  });
});

describe("u8 init", () => {
  it("writes a config that loads cleanly, without a daemon", async () => {
    const ws = createEmptyDir();
    const result = await cli(["init"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(result.out).toContain("created u8.jsonc");
    expect(fs.existsSync(ws.configPath)).toBe(true);
    expect(fs.existsSync(ws.paths.dir)).toBe(false);

    const loaded = loadWorkspaceFrom(ws.configPath);
    expect(loaded.repos.map((r) => r.name)).toContain("example");
  });

  it("refuses to clobber an existing config", async () => {
    const ws = createEmptyDir();
    await cli(["init"], { cwd: ws.dir });
    const second = await cli(["init"], { cwd: ws.dir });

    expect(second.code).toBe(1);
    expect(second.err).toContain("already exists");
    expect(second.err).not.toContain("at Object.");
  });

  it("honours --cwd", async () => {
    const ws = createEmptyDir();
    fs.mkdirSync(path.join(ws.dir, "nested"));
    const result = await cli(["init", "--cwd", "nested"], { cwd: ws.dir });

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(ws.dir, "nested", "u8.jsonc"))).toBe(true);
    expect(fs.existsSync(ws.configPath)).toBe(false);
  });
});

describe("errors", () => {
  it("suggests `u8 init` when there is no workspace", async () => {
    const ws = createEmptyDir();
    const result = await cli(["status"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain("no u8.jsonc");
    expect(result.err).toContain("u8 init");
    // A diagnosis, not a bug report: no stack trace.
    expect(result.err).not.toContain("    at ");
    expect(fs.existsSync(ws.paths.dir)).toBe(false);
  });

  it("reports a missing --config path without walking upward", async () => {
    const ws = createEmptyDir();
    const result = await cli(["status", "--config", "nope/u8.jsonc"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain("config file not found");
    expect(result.err).toContain(path.join(ws.dir, "nope", "u8.jsonc"));
  });

  it("prints a config's whole issue list instead of a stack", async () => {
    const ws = createWorkspace({
      repos: { web: { path: ".", scripts: { start: 42 } } },
    });
    const result = await cli(["status"], { cwd: ws.dir });

    expect(result.code).toBe(1);
    expect(result.err).toContain("invalid workspace config");
    expect(result.err).toContain("repos.web.scripts.start");
    expect(result.err).not.toContain("    at ");
  });
});
