import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkspace,
  parseConfigText,
  skeletonConfig,
  validateConfig,
  writeSkeletonConfig,
} from "../../src/config/index.js";
import { cleanupWorkspaces, sub, tmpWorkspace, u8ErrorFrom } from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("writeSkeletonConfig", () => {
  it("writes a config that loads cleanly", () => {
    const dir = tmpWorkspace({});
    const written = writeSkeletonConfig(dir);
    expect(written).toBe(path.join(dir, "u8.jsonc"));

    const ws = loadWorkspace(dir);
    expect(ws.name).toBe(path.basename(dir));
    expect(ws.apps.map((a) => a.name)).toEqual(["example"]);
    expect(sub(ws, "example").implicit).toBe(true);
    expect(sub(ws, "example").cwd).toBe(dir);
    expect(sub(ws, "example").scripts.start).toBeTruthy();
    // No profiles declared: the synthesized one covers everything.
    expect(ws.profiles).toHaveLength(1);
    expect(ws.defaultProfile).toBe("all");
    expect(ws.commands.map((c) => c.name)).toEqual(["app:start", "app:stop", "app:restart"]);
  });

  it("documents every optional feature as a commented example", () => {
    const dir = tmpWorkspace({});
    const text = fs.readFileSync(writeSkeletonConfig(dir), "utf8");
    for (const feature of ["subapps", "profiles", "commands", "hooks", "health", "indicators", "plugins"]) {
      expect(text).toMatch(new RegExp(`//.*"?${feature}"?`));
    }
  });

  it("refuses to overwrite an existing config", () => {
    const dir = tmpWorkspace({ "u8.jsonc": '{ "apps": {} }' });
    const e = u8ErrorFrom(() => writeSkeletonConfig(dir));
    expect(e.message).toContain("already exists");
    expect(fs.readFileSync(path.join(dir, "u8.jsonc"), "utf8")).toBe('{ "apps": {} }');
  });

  it("refuses a symlinked config instead of writing through it", () => {
    const dir = tmpWorkspace({ "elsewhere.jsonc": '{ "apps": {} }' });
    fs.symlinkSync(path.join(dir, "elsewhere.jsonc"), path.join(dir, "u8.jsonc"));
    expect(u8ErrorFrom(() => writeSkeletonConfig(dir)).message).toContain("already exists");
    expect(fs.readFileSync(path.join(dir, "elsewhere.jsonc"), "utf8")).toBe('{ "apps": {} }');
  });

  it("stays valid when its documented examples are uncommented", () => {
    // Every commented example is a member the user is invited to enable, so the
    // surrounding punctuation has to already be right — a missing comma after
    // "apps" would turn the first uncommented block into a parse error.
    const uncommented = skeletonConfig("demo")
      .split("\n")
      .map((line) => line.replace(/^(\s*)\/\/ (?=["{}[\]])/, "$1"))
      .join("\n");

    expect(uncommented).toContain('"profiles"');
    expect(uncommented).toContain('"subapps"');
    validateConfig(parseConfigText(uncommented));
  });
});
