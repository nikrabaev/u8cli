import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, loadWorkspaceFrom } from "../../src/config/index.js";
import { U8Error } from "../../src/util/errors.js";
import {
  app,
  cleanupWorkspaces,
  configErrorFrom,
  issueLines,
  loadFixture,
  u8ErrorFrom,
  uniqueIssues,
  writeConfig,
} from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("JSONC", () => {
  it("accepts comments and trailing commas", () => {
    const { ws } = loadFixture(`{
      // line comment
      "name": "demo", /* block comment */
      "repos": {
        "gateway": {
          "path": ".",
          "scripts": { "start": "pnpm dev", }, // trailing comma
        },
      },
    }`);

    expect(ws.name).toBe("demo");
    expect(app(ws, "gateway").scripts).toEqual({ start: "pnpm dev" });
  });

  it("tolerates a byte-order mark, which editors add invisibly", () => {
    const { ws } = loadFixture(`\uFEFF${JSON.stringify({ name: "bom", repos: { db: { path: "." } } })}`);
    expect(ws.name).toBe("bom");
  });

  it("reports parse errors with line and column", () => {
    const dir = writeConfig(`{
  "repos": {
    "gateway": { "path": }
  }
}`);
    const e = configErrorFrom(() => loadWorkspace(dir));
    expect(e.message).toBe("invalid JSONC");
    expect(e.configPath).toBe(path.join(dir, "u8.jsonc"));
    expect(e.issues[0]?.path).toBe("3:26");
    expect(e.format()).toContain("value expected");
  });

  it("reports each parse problem once, however the scanner recovers", () => {
    const e = configErrorFrom(() => loadFixture('{\n  "repos": {\n'));
    expect(e.issues).toEqual(uniqueIssues(e));
  });
});

describe("validation", () => {
  it("requires repos", () => {
    const e = configErrorFrom(() => loadFixture({ name: "demo" }));
    expect(e.issues.map((i) => i.path)).toEqual(["repos"]);
  });

  it("explains the rename when a config still uses the old apps/subapps keys", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { platform: { path: ".", subapps: { shell: {} } } } }),
    );
    // One sentence that says what to do, in place of "repos missing" plus
    // "apps unrecognized" — each true, neither pointing at the other.
    expect(e.issues.map((i) => i.path)).toEqual(["apps"]);
    expect(e.issues[0]?.message).toContain('renamed to "repos"');
    expect(e.issues[0]?.message).toContain('"subapps" to "apps"');
  });

  it("keeps the other problems of an old-style config next to the rename hint", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { api: { path: "." } }, templates: { subapp: "{app@name}" }, nope: 1 }),
    );
    expect(e.issues[0]?.path).toBe("apps");
    expect(e.issues.slice(1).map((i) => i.message).sort()).toEqual([
      'Unrecognized key: "subapp"',
      'Unrecognized keys: "apps", "nope"',
    ]);
  });

  it("does not mistake a repo's own apps for the old top-level key", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { platform: { path: ".", apps: { shell: { scriptz: {} } } } } }),
    );
    expect(issueLines(e)).toEqual(['repos.platform.apps.shell: Unrecognized key: "scriptz"']);
  });

  it("addresses type errors by dotted path, arrays by index", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { gateway: { path: 3, dependsOn: ["ok", 7] } } }),
    );
    expect(e.issues.map((i) => i.path).sort()).toEqual(["repos.gateway.dependsOn[1]", "repos.gateway.path"]);
  });

  it("rejects unknown keys so typos never pass silently", () => {
    const e = configErrorFrom(() => loadFixture({ repos: { gateway: { path: ".", scriptz: {} } } }));
    expect(issueLines(e)).toEqual(['repos.gateway: Unrecognized key: "scriptz"']);
  });

  it("rejects repo names that would make a target id ambiguous", () => {
    const e = configErrorFrom(() => loadFixture({ repos: { "web.api": { path: "." } } }));
    expect(e.issues[0]?.path).toBe("repos.web.api");
    expect(e.issues[0]?.message).toContain("invalid repo name");
  });

  it("rejects a health check with both http and cmd", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: ".", health: { http: "http://x", cmd: "pg_isready" } } } }),
    );
    expect(issueLines(e)).toEqual([
      'repos.db.health: a health check must set exactly one of "http" or "cmd"',
    ]);
  });

  it("rejects a health check with neither http nor cmd", () => {
    const e = configErrorFrom(() => loadFixture({ repos: { db: { path: ".", health: { interval: 1000 } } } }));
    expect(e.issues.map((i) => i.path)).toEqual(["repos.db.health"]);
  });

  it("rejects empty strings where a path or command is expected", () => {
    expect(configErrorFrom(() => loadFixture({ repos: { db: { path: "" } } })).issues[0]?.path).toBe(
      "repos.db.path",
    );
    // An empty URL would otherwise satisfy the http-XOR-cmd rule while probing nothing.
    expect(
      configErrorFrom(() => loadFixture({ repos: { db: { path: ".", health: { http: "" } } } })).issues[0]
        ?.path,
    ).toBe("repos.db.health.http");
  });

  it("explains what a union expected instead of just 'Invalid input'", () => {
    const targets = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: "." } }, commands: { t: { targets: { db: 3 } } } }),
    );
    expect(issueLines(targets)).toEqual([
      "commands.t.targets.db: expected a shell command string, or null to skip this target",
    ]);

    const hooks = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: "." } }, commands: { t: { hooks: { pre: 3 } } } }),
    );
    expect(issueLines(hooks)).toEqual([
      "commands.t.hooks.pre: expected a shell command string, or an array of them",
    ]);
  });

  it("collects every problem in one pass", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos: { a: { path: 1 }, b: { path: "." } },
        profiles: { p: { targets: ["ghost"] } },
      }),
    );
    // The type error aborts before normalization, so only schema issues here.
    expect(e.issues.length).toBeGreaterThanOrEqual(1);
    expect(e.issues[0]?.path).toBe("repos.a.path");
  });
});

/**
 * `builtins` and `plugins` both accept a plain value or the same value carrying
 * options. Every message here has to name the offending key: a union that only
 * says "Invalid input" is exactly what this layer exists to prevent.
 */
describe("builtin and plugin options", () => {
  const repos = { db: { path: "." } };

  it("rejects options for a built-in that takes none", () => {
    const e = configErrorFrom(() => loadFixture({ repos, builtins: { git: { verbose: true } } }));
    expect(issueLines(e)).toEqual(['builtins.git: the "git" built-in takes no options: use true or false']);

    const health = configErrorFrom(() => loadFixture({ repos, builtins: { health: {} } }));
    expect(issueLines(health)).toEqual([
      'builtins.health: the "health" built-in takes no options: use true or false',
    ]);
  });

  it("still reports a non-boolean built-in as a type error", () => {
    const e = configErrorFrom(() => loadFixture({ repos, builtins: { git: "yes" } }));
    expect(issueLines(e)).toEqual(["builtins.git: Invalid input: expected boolean, received string"]);
  });

  it("names the missing packages instead of the failed union", () => {
    const e = configErrorFrom(() => loadFixture({ repos, builtins: { protos: {} } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages: the protos built-in needs "packages": the shared packages it links, e.g. ["@myorg/protos"]',
    ]);
  });

  it("rejects an empty package list", () => {
    const e = configErrorFrom(() => loadFixture({ repos, builtins: { protos: { packages: [] } } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages: "packages" must name at least one shared package, e.g. ["@myorg/protos"]',
    ]);
  });

  it("rejects anything that is not a package name, addressed by index", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos, builtins: { protos: { packages: ["@myorg/protos", "../local/protos"] } } }),
    );
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages[1]: invalid shared package name: expected "name" or "@scope/name"',
    ]);
  });

  it("rejects a duplicate package, pointing at the entry to delete", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos,
        builtins: { protos: { packages: ["@myorg/protos", "@myorg/react-query", "@myorg/protos"] } },
      }),
    );
    expect(issueLines(e)).toEqual(['builtins.protos.packages[2]: duplicate package "@myorg/protos"']);
  });

  it("rejects a non-positive interval and an unknown option key", () => {
    const interval = configErrorFrom(() =>
      loadFixture({ repos, builtins: { protos: { packages: ["p"], interval: 0 } } }),
    );
    expect(interval.issues.map((i) => i.path)).toEqual(["builtins.protos.interval"]);

    const unknown = configErrorFrom(() =>
      loadFixture({ repos, builtins: { protos: { packages: ["p"], intervall: 10 } } }),
    );
    expect(issueLines(unknown)).toEqual(['builtins.protos: Unrecognized key: "intervall"']);
  });

  it("falls back to the union summary when nothing matched the shape", () => {
    const e = configErrorFrom(() => loadFixture({ repos, builtins: { protos: 3 } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos: expected false, or options like { "packages": ["@myorg/protos"] }',
    ]);
  });

  it("addresses a malformed plugin entry inside the entry", () => {
    const noSpec = configErrorFrom(() => loadFixture({ repos, plugins: [{ options: { a: 1 } }] }));
    expect(noSpec.issues.map((i) => i.path)).toEqual(["plugins[0].spec"]);

    const typo = configErrorFrom(() =>
      loadFixture({ repos, plugins: ["./ok.ts", { spec: "./x.ts", optionz: {} }] }),
    );
    expect(issueLines(typo)).toEqual(['plugins[1]: Unrecognized key: "optionz"']);

    const notAnObject = configErrorFrom(() =>
      loadFixture({ repos, plugins: [{ spec: "./x.ts", options: 3 }] }),
    );
    expect(notAnObject.issues.map((i) => i.path)).toEqual(["plugins[0].options"]);
  });

  it("explains what a plugin entry may be when it is neither shape", () => {
    const e = configErrorFrom(() => loadFixture({ repos, plugins: [3] }));
    expect(issueLines(e)).toEqual([
      'plugins[0]: expected a package name or path, or { "spec": "…", "options": { … } }',
    ]);
  });
});

describe("entry points", () => {
  it("loads a config by explicit path", () => {
    const dir = writeConfig({ repos: { db: { path: "." } } });
    const ws = loadWorkspaceFrom(path.join(dir, "u8.jsonc"));
    expect(ws.rootDir).toBe(dir);
  });

  it("reports a missing file as CONFIG_NOT_FOUND", () => {
    const dir = writeConfig({ repos: { db: { path: "." } } });
    const e = u8ErrorFrom(() => loadWorkspaceFrom(path.join(dir, "nope.jsonc")));
    expect(e).toBeInstanceOf(U8Error);
    expect(e.code).toBe("CONFIG_NOT_FOUND");
  });
});
