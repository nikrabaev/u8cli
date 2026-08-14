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
import { cleanupWorkspaces, sub, tmpWorkspace, u8ErrorFrom, writeConfig } from "./helpers.js";

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
    for (const feature of [
      "subapps",
      "profiles",
      "commands",
      "hooks",
      "health",
      "indicators",
      "plugins",
      "builtins",
      "protos",
    ]) {
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

  /**
   * The line-by-line uncommenting above only ever produces *empty* blocks, so it
   * proves the punctuation and nothing about the bodies. These two blocks are
   * the config reference for shapes that carry configuration, and a stale
   * example there teaches the wrong thing — so they are enabled whole and put
   * through a real load.
   */
  it("keeps its plugin and built-in examples loadable as written", () => {
    const skeleton = skeletonConfig("demo");
    const ws = loadWorkspace(
      writeConfig(
        `{
  "apps": { "example": { "path": "." } },
  ${uncommentBlock(skeleton, "plugins")}
  ${uncommentBlock(skeleton, "builtins")}
}`,
      ),
    );

    expect(ws.builtins.protos).toBe(true);
    expect(ws.builtinOptions["protos"]).toEqual({
      packages: ["@myorg/protos", "@myorg/react-query"],
      intervalMs: 10_000,
    });
    expect(ws.plugins.map((p) => p.spec)).toEqual(["./plugins/deploy.ts", "@acme/u8-metrics"]);
    expect(ws.plugins[1]?.options).toEqual({ endpoint: "http://localhost:9090" });
  });
});

/** Lifts one commented `"key": …` block out of the skeleton, comment markers off. */
function uncommentBlock(skeleton: string, key: string): string {
  const lines = skeleton.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(`// "${key}"`));
  if (start < 0) throw new Error(`the skeleton documents no "${key}" block`);

  const out: string[] = [];
  for (const line of lines.slice(start)) {
    const bare = line.replace(/^\s*\/\/ ?/, "");
    out.push(bare);
    // The closing brace of the block itself is the only one at column zero.
    if (/^[}\]],?$/.test(bare)) return out.join("\n");
  }
  throw new Error(`the "${key}" block is never closed`);
}
