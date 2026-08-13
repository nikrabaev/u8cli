import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConfig, findConfigPath, loadWorkspace } from "../../src/config/index.js";
import { cleanupWorkspaces, tmpWorkspace, u8ErrorFrom, writeConfig } from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("discovery", () => {
  it("walks up from a nested directory", () => {
    const dir = writeConfig({ apps: { db: { path: "." } } }, { "a/b/c/.keep": "" });
    const nested = path.join(dir, "a/b/c");

    expect(discoverConfig(nested)).toBe(path.join(dir, "u8.jsonc"));
    expect(loadWorkspace(nested).rootDir).toBe(dir);
  });

  it("stops at the nearest config", () => {
    const outer = writeConfig({ name: "outer", apps: { db: { path: "." } } }, { "inner/.keep": "" });
    fs.writeFileSync(
      path.join(outer, "inner/u8.jsonc"),
      JSON.stringify({ name: "inner", apps: { db: { path: "." } } }),
    );
    expect(loadWorkspace(path.join(outer, "inner")).name).toBe("inner");
  });

  it("resolves symlinked routes to the same real path", () => {
    const dir = writeConfig({ apps: { db: { path: "." } } });
    const link = path.join(path.dirname(dir), `${path.basename(dir)}-link`);
    fs.symlinkSync(dir, link);
    try {
      expect(discoverConfig(link)).toBe(path.join(dir, "u8.jsonc"));
      expect(loadWorkspace(link).id).toBe(loadWorkspace(dir).id);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("ignores a config in a sibling directory", () => {
    const dir = tmpWorkspace({ "with/u8.jsonc": '{ "apps": {} }', "without/.keep": "" });
    expect(findConfigPath(path.join(dir, "without"))).toBeUndefined();
  });

  it("throws CONFIG_NOT_FOUND with an actionable message", () => {
    const dir = tmpWorkspace({ ".keep": "" });
    const e = u8ErrorFrom(() => discoverConfig(dir));
    expect(e.code).toBe("CONFIG_NOT_FOUND");
    expect(e.message).toContain("u8 init");
  });
});
