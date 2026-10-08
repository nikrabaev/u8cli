/**
 * Loading: where a plugin comes from, what shapes are accepted, and what
 * happens to the ones that are broken (SPEC §2.8, §6 isolation-lite).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedWorkspace } from "../../src/config/types.js";
import type { SnapshotPlugin } from "../../src/ipc/protocol.js";
import { builtinAvailable, BUILTIN_SPEC_PREFIX, pluginSources } from "../../src/plugins/index.js";
import { cleanupPlugins, createFixture, installPackage, PLUGIN_SDK, type Fixture } from "./helpers.js";

afterEach(async () => {
  await cleanupPlugins();
});

/**
 * Resolves package specs in a child `node` started with `NODE_PATH` set.
 *
 * Node reads `NODE_PATH` once, at startup, so nothing done inside this process
 * can stand in for it — and a real child is also exactly how the leak happens:
 * a package manager's bin shim exports `NODE_PATH` before it execs u8.
 */
function resolveUnderNodePath(fixture: Fixture, nodePath: string, specs: string[]): Array<{ file?: string; error?: string }> {
  const require = createRequire(import.meta.url);
  const register = path.join(path.dirname(require.resolve("jiti/package.json")), "lib", "jiti-register.mjs");
  const loadModule = new URL("../../src/plugins/load.ts", import.meta.url).href;
  const script = `
    // jiti hands a TypeScript module to a plain importer under \`default\`.
    const { resolveSourceFile } = (await import(${JSON.stringify(loadModule)})).default;
    const [rootDir, ...specs] = process.argv.slice(1);
    const out = specs.map((spec) => {
      try { return { file: resolveSourceFile({ spec, kind: "package" }, rootDir) }; }
      catch (err) { return { error: err.message }; }
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", register, "--input-type=module", "-e", script, fixture.dir, ...specs],
    { cwd: path.dirname(fileURLToPath(import.meta.url)), env: { ...process.env, NODE_PATH: nodePath }, encoding: "utf8" },
  );
  if (child.status !== 0) throw new Error(`resolver child failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Array<{ file?: string; error?: string }>;
}

function record(list: SnapshotPlugin[], spec: string): SnapshotPlugin {
  const found = list.find((p) => p.spec === spec);
  if (!found) throw new Error(`no record for "${spec}" (have: ${list.map((p) => p.spec).join(", ")})`);
  return found;
}

describe("plugin sources", () => {
  it("loads a local .js plugin from its default export", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/demo.js"] },
      files: {
        "plugins/demo.js": `export default {
          name: "demo",
          commands: { greet: { run: () => undefined } },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(host.list()).toEqual([{ name: "demo", spec: "./plugins/demo.js", ok: true }]);
    expect(host.commands().map((c) => c.name)).toEqual(["demo:greet"]);
  });

  it("loads a local .ts plugin through jiti, including the real SDK import", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/typed.ts"] },
      files: {
        "plugins/typed.ts": `import { definePlugin } from ${JSON.stringify(PLUGIN_SDK)};
        import type { IndicatorContext } from ${JSON.stringify(PLUGIN_SDK)};

        export default definePlugin({
          name: "typed",
          indicators: {
            answer: {
              update: { mode: "poll", intervalMs: 1000 },
              value(_ctx: IndicatorContext): string {
                return "42";
              },
            },
          },
        });`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/typed.ts")).toEqual({
      name: "typed",
      spec: "./plugins/typed.ts",
      ok: true,
    });
    expect(host.indicators().map((i) => `${i.ns}@${i.name}`)).toEqual(["typed@answer"]);
  });

  it("unwraps a CommonJS plugin's module.exports", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/legacy.cjs"] },
      files: { "plugins/legacy.cjs": `module.exports = { name: "legacy" };` },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/legacy.cjs")).toMatchObject({ name: "legacy", ok: true });
  });

  it("accepts a module-shaped plugin with no default export", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/flat.js"] },
      files: {
        "plugins/flat.js": `export const name = "flat";
        export const hooks = { "*": { pre: () => undefined } };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/flat.js").ok).toBe(true);
    expect(host.hooksFor("app:start").map((h) => h.plugin)).toEqual(["flat"]);
  });

  it("resolves a bare spec from the workspace's own node_modules", async () => {
    const fixture = createFixture({ config: { plugins: ["u8-fixture-plugin"] } });
    installPackage(
      fixture,
      "u8-fixture-plugin",
      `export default { name: "packaged", commands: { ship: { run: () => undefined } } };`,
    );

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "u8-fixture-plugin")).toEqual({
      name: "packaged",
      spec: "u8-fixture-plugin",
      ok: true,
    });
    expect(host.commands().map((c) => c.name)).toEqual(["packaged:ship"]);
  });

  it("resolves an ESM-only package through its exports map", async () => {
    const fixture = createFixture({ config: { plugins: ["u8-esm-plugin"] } });
    installPackage(fixture, "u8-esm-plugin", `export default { name: "esmonly" };`, {
      main: undefined,
      exports: { ".": { import: "./index.js" } },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "u8-esm-plugin").ok).toBe(true);
  });

  it("reports a package that is not installed instead of loading u8cli's own copy", async () => {
    const fixture = createFixture({ config: { plugins: ["vitest"] } });

    const host = fixture.host();
    await host.load();

    const entry = record(host.list(), "vitest");
    expect(entry.ok).toBe(false);
    expect(entry.error).toContain("cannot resolve plugin package");
    expect(entry.error).toContain("node_modules");
  });

  it("ignores NODE_PATH, which a launcher points at u8cli's own dependency tree", () => {
    const fixture = createFixture();
    installPackage(fixture, "u8-installed-plugin", `export default { name: "installed" };`);
    // A directory the way NODE_PATH names one: packages directly inside it, and
    // nowhere on the node_modules chain above the workspace.
    const elsewhere = fixture.file("elsewhere");
    for (const name of ["u8-stray-plugin", "u8-installed-plugin"]) {
      fs.mkdirSync(path.join(elsewhere, name), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, name, "index.js"), `module.exports = { name: "stray" };`);
    }

    const [stray, installed] = resolveUnderNodePath(fixture, elsewhere, ["u8-stray-plugin", "u8-installed-plugin"]);

    // Reachable only through NODE_PATH: not installed, whatever Node would say.
    expect(stray?.file).toBeUndefined();
    expect(stray?.error).toContain('cannot resolve plugin package "u8-stray-plugin"');
    // Installed in the workspace: its own copy, not the one NODE_PATH offers.
    expect(installed?.file).toBe(fixture.file("node_modules/u8-installed-plugin/index.js"));
  });

  it("names the file it looked for when a local spec does not exist", async () => {
    const fixture = createFixture({ config: { plugins: ["./plugins/missing.ts"] } });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/missing.ts").error).toContain("no plugin file at");
  });
});

describe("built-ins", () => {
  /** The specs a source list should carry, given which built-ins are enabled. */
  const specs = (fixture: ReturnType<typeof createFixture>): string[] =>
    pluginSources(fixture.ws).map((s) => s.spec);

  it("comes before the configured plugins, git before health", () => {
    const fixture = createFixture({
      config: { builtins: {}, plugins: ["./plugins/demo.js", "pkg"] },
    });

    expect(specs(fixture)).toEqual([
      `${BUILTIN_SPEC_PREFIX}git`,
      `${BUILTIN_SPEC_PREFIX}health`,
      "./plugins/demo.js",
      "pkg",
    ]);
  });

  it("drops the one the config disables", () => {
    expect(specs(createFixture({ config: { builtins: { git: false } } }))).toEqual([
      `${BUILTIN_SPEC_PREFIX}health`,
    ]);
    expect(specs(createFixture({ config: { builtins: { git: false, health: false } } }))).toEqual([]);
  });

  it("loads nothing at all when both are disabled", async () => {
    const host = createFixture().host();
    await host.load();

    expect(host.list()).toEqual([]);
  });

  it("only records the built-ins this install actually ships", async () => {
    const fixture = createFixture({ config: { builtins: {} } });
    const host = fixture.host();
    await host.load();

    const shipped = pluginSources(fixture.ws).filter((s) => s.builtin !== undefined && builtinAvailable(s.builtin));
    expect(host.list().map((p) => p.spec)).toEqual(shipped.map((s) => s.spec));
    // Whatever ships must load: a built-in that throws is a u8cli bug.
    expect(host.list().every((p) => p.ok)).toBe(true);
  });

  /**
   * `protos` ships with u8cli like the other two, but a workspace that never
   * mentions it must not pay for it — not an import, not a record, not a cell.
   * The gate is the source list: a disabled built-in is never even resolved.
   */
  it("leaves protos out of the load order until the workspace enables it", async () => {
    const fixture = createFixture({ config: { builtins: {} } });
    expect(specs(fixture)).not.toContain(`${BUILTIN_SPEC_PREFIX}protos`);

    const host = fixture.host();
    await host.load();
    expect(host.list().map((p) => p.spec)).not.toContain(`${BUILTIN_SPEC_PREFIX}protos`);

    const enabled: NormalizedWorkspace = {
      ...fixture.ws,
      builtins: { git: false, health: false, protos: true },
    };
    expect(pluginSources(enabled).map((s) => s.spec)).toEqual([`${BUILTIN_SPEC_PREFIX}protos`]);
  });
});

/**
 * Options ride along with the source, so the one place that knows what a
 * workspace asked for is the one place that says what a plugin is built from.
 */
describe("options on a source", () => {
  it("carries a declared plugin's options and a built-in's alike", () => {
    const fixture = createFixture();
    const ws: NormalizedWorkspace = {
      ...fixture.ws,
      builtins: { git: false, health: false, protos: true },
      builtinOptions: { protos: { packages: ["@myorg/protos"] } },
      plugins: [{ spec: "./plugins/demo.js", options: { verbose: true } }, { spec: "pkg" }],
    };

    expect(pluginSources(ws).map((s) => [s.spec, s.options])).toEqual([
      [`${BUILTIN_SPEC_PREFIX}protos`, { packages: ["@myorg/protos"] }],
      ["./plugins/demo.js", { verbose: true }],
      ["pkg", undefined],
    ]);
  });

  /**
   * An empty options object is the same as none: the host only refuses a plugin
   * with no factory when a *setting* would otherwise be silently dropped.
   */
  it("treats an empty options object as no options at all", () => {
    const fixture = createFixture();
    const ws: NormalizedWorkspace = {
      ...fixture.ws,
      builtins: { git: false, health: false, protos: true },
      builtinOptions: { protos: {} },
      plugins: [{ spec: "./plugins/demo.js", options: {} }],
    };

    expect(pluginSources(ws).every((s) => s.options === undefined)).toBe(true);
  });
});

describe("isolation-lite", () => {
  /** Every failure mode, side by side with a healthy plugin declared after it. */
  const brokenWorkspace = () =>
    createFixture({
      config: {
        plugins: [
          "./plugins/boom.js",
          "./plugins/setup.js",
          "./plugins/malformed.js",
          "./plugins/nameless.js",
          "./plugins/good.js",
        ],
      },
      files: {
        "plugins/boom.js": `throw new Error("exploded at import");`,
        "plugins/setup.js": `export default {
          name: "setupper",
          setup() { throw new Error("setup refused"); },
        };`,
        "plugins/malformed.js": `export default { name: "malformed", commands: { go: { kind: "task" } } };`,
        "plugins/nameless.js": `export default { indicators: {} };`,
        "plugins/good.js": `export default {
          name: "good",
          commands: { go: { run: () => undefined } },
        };`,
      },
    });

  it("disables a plugin that throws at import and keeps loading the rest", async () => {
    const host = brokenWorkspace().host();
    await host.load();

    const entry = record(host.list(), "./plugins/boom.js");
    expect(entry.ok).toBe(false);
    expect(entry.error).toContain("exploded at import");
    expect(host.commands().map((c) => c.name)).toEqual(["good:go"]);
  });

  it("disables a plugin whose setup throws", async () => {
    const host = brokenWorkspace().host();
    await host.load();

    const entry = record(host.list(), "./plugins/setup.js");
    expect(entry).toMatchObject({ name: "setupper", ok: false });
    expect(entry.error).toContain("setup refused");
  });

  it("disables a malformed definition with a message naming the key", async () => {
    const host = brokenWorkspace().host();
    await host.load();

    expect(record(host.list(), "./plugins/malformed.js").error).toContain("commands.go must define a run() function");
    expect(record(host.list(), "./plugins/nameless.js").error).toContain('"name" is required');
  });

  /**
   * An array passes `typeof x === "object"` while satisfying nothing an author
   * meant by it: taken as a map it would contribute a command named `0`.
   */
  it("rejects a section declared as an array instead of naming its entries", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/arr.js", "./plugins/list.js"] },
      files: {
        "plugins/arr.js": `export default { name: "arr", commands: [{ run: () => undefined }] };`,
        "plugins/list.js": `export default ["not", "a", "plugin"];`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/arr.js").error).toContain(`"commands" must be an object, got an array`);
    expect(record(host.list(), "./plugins/list.js").error).toContain("got an array");
    expect(host.commands()).toEqual([]);
  });

  it("records every attempted plugin, in load order, and contributes nothing from the failures", async () => {
    const host = brokenWorkspace().host();
    await host.load();

    expect(host.list().map((p) => [p.spec, p.ok])).toEqual([
      ["./plugins/boom.js", false],
      ["./plugins/setup.js", false],
      ["./plugins/malformed.js", false],
      ["./plugins/nameless.js", false],
      ["./plugins/good.js", true],
    ]);
    expect(host.indicators()).toEqual([]);
    expect(host.hooksFor("app:start")).toEqual([]);
  });

  it("reports each failure once, with the name it could be attributed to", async () => {
    const seen: Array<[string, string]> = [];
    const host = brokenWorkspace().host({ onError: (plugin, error) => seen.push([plugin, error]) });
    await host.load();

    expect(seen).toHaveLength(4);
    expect(seen.map(([name]) => name)).toEqual(["boom", "setupper", "malformed", "nameless"]);
    expect(seen.every(([, error]) => error.length > 0)).toBe(true);
  });

  it("survives a plugin that never finishes importing", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/hang.js", "./plugins/good.js"] },
      files: {
        "plugins/hang.js": `await new Promise(() => {});
        export default { name: "hang" };`,
        "plugins/good.js": `export default { name: "good" };`,
      },
    });

    const host = fixture.host({ loadTimeoutMs: 150 });
    await host.load();

    expect(record(host.list(), "./plugins/hang.js").error).toContain("timed out after 150ms");
    expect(record(host.list(), "./plugins/good.js").ok).toBe(true);
  });

  it("only loads once, however often it is asked", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/counter.js"] },
      files: {
        "plugins/counter.js": `let setups = 0;
        export default {
          name: "counter",
          setup(ctx) { ctx.store.set("setups", ++setups); },
        };`,
      },
    });

    const host = fixture.host();
    await Promise.all([host.load(), host.load()]);
    await host.load();

    expect(host.list()).toHaveLength(1);
  });
});

/**
 * What a plugin may call the things it contributes. The namespace is added for
 * it either way; the question is what may follow the namespace.
 */
describe("contributed names", () => {
  it("accepts a sub-command spelled with a colon, and namespaces the whole of it", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/shared.js"] },
      files: {
        "plugins/shared.js": `export default {
          name: "shared",
          commands: {
            link: { run: () => undefined },
            "link:protos": { run: () => undefined },
            "unlink:react-query": { run: () => undefined },
          },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/shared.js").ok).toBe(true);
    expect(host.commands().map((c) => c.name)).toEqual([
      "shared:link",
      "shared:link:protos",
      "shared:unlink:react-query",
    ]);
  });

  it("rejects a colon with nothing on one side of it", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/half.js"] },
      files: {
        "plugins/half.js": `export default { name: "half", commands: { "link:": { run: () => undefined } } };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/half.js").error).toContain("invalid name in commands.link:");
    expect(host.commands()).toEqual([]);
  });

  /**
   * `:` introduces a modifier inside a template token (`{git@branch:max(20)}`),
   * so an indicator that used one could never be rendered — the parser would
   * read the tail as a modifier it has never heard of.
   */
  it("still refuses a colon in an indicator name", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/cells.js"] },
      files: {
        "plugins/cells.js": `export default {
          name: "cells",
          indicators: { "linked:protos": { value: () => "1" } },
        };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/cells.js").error).toContain("invalid name in indicators.linked:protos");
    expect(host.indicators()).toEqual([]);
  });
});

describe("namespace collisions", () => {
  it("rejects a plugin claiming a core namespace", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/app.js", "./plugins/repo.js"] },
      files: {
        "plugins/app.js": `export default { name: "app" };`,
        "plugins/repo.js": `export default { name: "repo" };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/app.js")).toMatchObject({ name: "app", ok: false });
    expect(record(host.list(), "./plugins/app.js").error).toContain("reserved by u8cli");
    // `repo@` is the header row's namespace, exactly as `app@` is the app row's.
    expect(record(host.list(), "./plugins/repo.js").error).toContain("reserved by u8cli");
  });

  it("reserves nothing for config indicators, which are written without a namespace", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/x.js"], indicators: { version: { cmd: "echo 1" } } },
      files: {
        "plugins/x.js": `export default { name: "x", indicators: { version: { value: () => "p" } } };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/x.js")).toMatchObject({ name: "x", ok: true });
    expect(host.indicators().map((i) => `${i.ns}@${i.name}`)).toEqual(["x@version"]);
  });

  it("rejects the second plugin to claim a name and keeps the first", async () => {
    const fixture = createFixture({
      config: { plugins: ["./plugins/first.js", "./plugins/second.js"] },
      files: {
        "plugins/first.js": `export default { name: "dup", commands: { a: { run: () => undefined } } };`,
        "plugins/second.js": `export default { name: "dup", commands: { b: { run: () => undefined } } };`,
      },
    });

    const host = fixture.host();
    await host.load();

    expect(record(host.list(), "./plugins/first.js").ok).toBe(true);
    const clash = record(host.list(), "./plugins/second.js");
    expect(clash).toMatchObject({ name: "dup", ok: false });
    expect(clash.error).toContain('already taken by "./plugins/first.js"');
    expect(host.commands().map((c) => c.name)).toEqual(["dup:a"]);
  });

  it("rejects a plugin colliding with a built-in name", async () => {
    const fixture = createFixture({
      config: { builtins: { git: true, health: false }, plugins: ["./plugins/mine.js"] },
      files: { "plugins/mine.js": `export default { name: "git" };` },
    });

    const host = fixture.host();
    await host.load();

    const builtin = host.list().find((p) => p.spec === `${BUILTIN_SPEC_PREFIX}git`);
    const mine = record(host.list(), "./plugins/mine.js");
    // The built-in ships with u8cli; when it is present it owns the name, and
    // when it is not this plugin is free to take it.
    expect(mine.ok).toBe(builtin?.ok !== true);
    if (builtin?.ok === true) expect(mine.error).toContain("already taken");
  });
});
