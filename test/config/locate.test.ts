/**
 * Finding the workspace — and the instance — a directory belongs to.
 *
 * Walking upward stops being enough once checkouts live away from the config,
 * so these build the state a daemon leaves behind (its index and its instance
 * records) and ask from the places a command is actually typed in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { locateWorkspace, serializeInstanceRecords, serializeWorkspaceIndex } from "../../src/config/index.js";
import type { InstanceRecord } from "../../src/config/types.js";
import { statePaths } from "../../src/util/paths.js";
import { cleanupWorkspaces, instanceRecord, tmpWorkspace } from "./helpers.js";

let previousHome: string | undefined;
let stateHome: string;

beforeEach(() => {
  previousHome = process.env.U8_STATE_HOME;
  stateHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-locate-")));
  process.env.U8_STATE_HOME = stateHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.U8_STATE_HOME;
  else process.env.U8_STATE_HOME = previousHome;
  fs.rmSync(stateHome, { recursive: true, force: true });
  cleanupWorkspaces();
});

/** What a daemon for `configPath` would have written into its state dir. */
function publish(configPath: string, repos: Record<string, string>, records: InstanceRecord[] = []): void {
  const paths = statePaths(configPath);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.workspaceFile, serializeWorkspaceIndex({ configPath, name: "ws", repos }));
  fs.writeFileSync(paths.instancesFile, serializeInstanceRecords(records));
}

/** A directory git would call a linked worktree of `main`. */
function linkWorktree(dir: string, main: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(main, ".git/worktrees", path.basename(dir))}\n`);
}

describe("locateWorkspace", () => {
  it("walks up to the config when no daemon has recorded anything", () => {
    const dir = tmpWorkspace({ "u8.jsonc": "{}", "a/b/.keep": "" });
    expect(locateWorkspace(path.join(dir, "a/b"))).toEqual({ configPath: path.join(dir, "u8.jsonc") });
    expect(locateWorkspace(os.tmpdir())).toBeUndefined();
  });

  it("finds the workspace and the instance from a checkout nowhere near the config", () => {
    const dir = tmpWorkspace({ "ws/u8.jsonc": "{}", "ws/api/.keep": "", "far/away/api/src/.keep": "" });
    const configPath = path.join(dir, "ws/u8.jsonc");
    publish(configPath, { api: path.join(dir, "ws/api") }, [
      instanceRecord("feat-x", { repos: { api: { path: path.join(dir, "far/away/api"), owned: false } } }),
    ]);

    expect(locateWorkspace(path.join(dir, "far/away/api/src"))).toEqual({ configPath, instance: "feat-x" });
    // Outside every checkout there is still nothing to find.
    expect(locateWorkspace(path.join(dir, "far"))).toBeUndefined();
  });

  it("recognises the worktree root, not only the repo inside it", () => {
    const dir = tmpWorkspace({ "ws/u8.jsonc": "{}", "wt/mono/services/api/.keep": "", "wt/mono/docs/.keep": "" });
    const configPath = path.join(dir, "ws/u8.jsonc");
    publish(configPath, {}, [
      instanceRecord("m", {
        repos: {
          api: { path: path.join(dir, "wt/mono/services/api"), owned: true, worktree: path.join(dir, "wt/mono") },
        },
      }),
    ]);
    expect(locateWorkspace(path.join(dir, "wt/mono/docs"))).toEqual({ configPath, instance: "m" });
  });

  it("finds base from a repo the config points at with a path outside the workspace", () => {
    const dir = tmpWorkspace({ "ws/u8.jsonc": "{}", "elsewhere/gateway/src/.keep": "" });
    const configPath = path.join(dir, "ws/u8.jsonc");
    publish(configPath, { gateway: path.join(dir, "elsewhere/gateway") });
    expect(locateWorkspace(path.join(dir, "elsewhere/gateway/src"))).toEqual({ configPath });
  });

  it("prefers the recorded checkout over the copy of u8.jsonc inside it", () => {
    // The repo holds its config, so a worktree of the repo holds a copy.
    const dir = tmpWorkspace({ "repo/u8.jsonc": "{}", "wt/task/u8.jsonc": "{}", "wt/task/src/.keep": "" });
    const configPath = path.join(dir, "repo/u8.jsonc");
    publish(configPath, { app: path.join(dir, "repo") }, [
      instanceRecord("task", { repos: { app: { path: path.join(dir, "wt/task"), owned: false } } }),
    ]);
    expect(locateWorkspace(path.join(dir, "wt/task/src"))).toEqual({ configPath, instance: "task" });
  });

  it("still lets a workspace of its own win when it sits strictly below a checkout", () => {
    const dir = tmpWorkspace({
      "ws/u8.jsonc": "{}",
      "wt/task/examples/demo/u8.jsonc": "{}",
      "wt/task/examples/demo/.keep": "",
    });
    publish(path.join(dir, "ws/u8.jsonc"), {}, [
      instanceRecord("task", { repos: { app: { path: path.join(dir, "wt/task"), owned: false } } }),
    ]);
    expect(locateWorkspace(path.join(dir, "wt/task/examples/demo"))).toEqual({
      configPath: path.join(dir, "wt/task/examples/demo/u8.jsonc"),
    });
  });

  it("reports a linked worktree that no instance covers, against the main checkout's workspace", () => {
    const dir = tmpWorkspace({ "repo/tools/u8.jsonc": "{}", "repo/.git/HEAD": "ref: refs/heads/main\n" });
    const top = path.join(dir, "repo/.claude/worktrees/fix");
    linkWorktree(top, path.join(dir, "repo"));
    // The worktree has the same files as the repo, config included.
    fs.mkdirSync(path.join(top, "tools"), { recursive: true });
    fs.writeFileSync(path.join(top, "tools/u8.jsonc"), "{}");

    expect(locateWorkspace(path.join(top, "tools"))).toEqual({
      configPath: path.join(dir, "repo/tools/u8.jsonc"),
      unregistered: top,
    });
  });

  it("does not mistake a submodule for a second checkout", () => {
    const dir = tmpWorkspace({ "repo/u8.jsonc": "{}", "repo/.git/HEAD": "x", "repo/vendor/lib/src/.keep": "" });
    fs.writeFileSync(path.join(dir, "repo/vendor/lib/.git"), "gitdir: ../../.git/modules/vendor/lib\n");
    expect(locateWorkspace(path.join(dir, "repo/vendor/lib/src"))).toEqual({
      configPath: path.join(dir, "repo/u8.jsonc"),
    });
  });

  it("ignores what a workspace recorded once its config is gone", () => {
    const dir = tmpWorkspace({ "ws/u8.jsonc": "{}", "far/api/.keep": "" });
    const configPath = path.join(dir, "ws/u8.jsonc");
    publish(configPath, {}, [
      instanceRecord("old", { repos: { api: { path: path.join(dir, "far/api"), owned: false } } }),
    ]);
    fs.rmSync(configPath);
    expect(locateWorkspace(path.join(dir, "far/api"))).toBeUndefined();
  });
});
