import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, loadWorkspaceFrom } from "../../src/config/index.js";
import { U8Error } from "../../src/util/errors.js";
import {
  cleanupWorkspaces,
  configErrorFrom,
  issueLines,
  loadFixture,
  sub,
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
      "apps": {
        "gateway": {
          "path": ".",
          "scripts": { "start": "pnpm dev", }, // trailing comma
        },
      },
    }`);

    expect(ws.name).toBe("demo");
    expect(sub(ws, "gateway").scripts).toEqual({ start: "pnpm dev" });
  });

  it("tolerates a byte-order mark, which editors add invisibly", () => {
    const { ws } = loadFixture(`\uFEFF${JSON.stringify({ name: "bom", apps: { db: { path: "." } } })}`);
    expect(ws.name).toBe("bom");
  });

  it("reports parse errors with line and column", () => {
    const dir = writeConfig(`{
  "apps": {
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
    const e = configErrorFrom(() => loadFixture('{\n  "apps": {\n'));
    expect(e.issues).toEqual(uniqueIssues(e));
  });
});

describe("validation", () => {
  it("requires apps", () => {
    const e = configErrorFrom(() => loadFixture({ name: "demo" }));
    expect(e.issues.map((i) => i.path)).toEqual(["apps"]);
  });

  it("addresses type errors by dotted path, arrays by index", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { gateway: { path: 3, dependsOn: ["ok", 7] } } }),
    );
    expect(e.issues.map((i) => i.path).sort()).toEqual(["apps.gateway.dependsOn[1]", "apps.gateway.path"]);
  });

  it("rejects unknown keys so typos never pass silently", () => {
    const e = configErrorFrom(() => loadFixture({ apps: { gateway: { path: ".", scriptz: {} } } }));
    expect(issueLines(e)).toEqual(['apps.gateway: Unrecognized key: "scriptz"']);
  });

  it("rejects app names that would make a target id ambiguous", () => {
    const e = configErrorFrom(() => loadFixture({ apps: { "web.api": { path: "." } } }));
    expect(e.issues[0]?.path).toBe("apps.web.api");
    expect(e.issues[0]?.message).toContain("invalid app name");
  });

  it("rejects a health check with both http and cmd", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: ".", health: { http: "http://x", cmd: "pg_isready" } } } }),
    );
    expect(issueLines(e)).toEqual([
      'apps.db.health: a health check must set exactly one of "http" or "cmd"',
    ]);
  });

  it("rejects a health check with neither http nor cmd", () => {
    const e = configErrorFrom(() => loadFixture({ apps: { db: { path: ".", health: { interval: 1000 } } } }));
    expect(e.issues.map((i) => i.path)).toEqual(["apps.db.health"]);
  });

  it("rejects empty strings where a path or command is expected", () => {
    expect(configErrorFrom(() => loadFixture({ apps: { db: { path: "" } } })).issues[0]?.path).toBe(
      "apps.db.path",
    );
    // An empty URL would otherwise satisfy the http-XOR-cmd rule while probing nothing.
    expect(
      configErrorFrom(() => loadFixture({ apps: { db: { path: ".", health: { http: "" } } } })).issues[0]
        ?.path,
    ).toBe("apps.db.health.http");
  });

  it("explains what a union expected instead of just 'Invalid input'", () => {
    const targets = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: "." } }, commands: { t: { targets: { db: 3 } } } }),
    );
    expect(issueLines(targets)).toEqual([
      "commands.t.targets.db: expected a shell command string, or null to skip this target",
    ]);

    const hooks = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: "." } }, commands: { t: { hooks: { pre: 3 } } } }),
    );
    expect(issueLines(hooks)).toEqual([
      "commands.t.hooks.pre: expected a shell command string, or an array of them",
    ]);
  });

  it("collects every problem in one pass", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps: { a: { path: 1 }, b: { path: "." } },
        profiles: { p: { targets: ["ghost"] } },
      }),
    );
    // The type error aborts before normalization, so only schema issues here.
    expect(e.issues.length).toBeGreaterThanOrEqual(1);
    expect(e.issues[0]?.path).toBe("apps.a.path");
  });
});

/**
 * `builtins` and `plugins` both accept a plain value or the same value carrying
 * options. Every message here has to name the offending key: a union that only
 * says "Invalid input" is exactly what this layer exists to prevent.
 */
describe("builtin and plugin options", () => {
  const apps = { db: { path: "." } };

  it("rejects options for a built-in that takes none", () => {
    const e = configErrorFrom(() => loadFixture({ apps, builtins: { git: { verbose: true } } }));
    expect(issueLines(e)).toEqual(['builtins.git: the "git" built-in takes no options: use true or false']);

    const health = configErrorFrom(() => loadFixture({ apps, builtins: { health: {} } }));
    expect(issueLines(health)).toEqual([
      'builtins.health: the "health" built-in takes no options: use true or false',
    ]);
  });

  it("still reports a non-boolean built-in as a type error", () => {
    const e = configErrorFrom(() => loadFixture({ apps, builtins: { git: "yes" } }));
    expect(issueLines(e)).toEqual(["builtins.git: Invalid input: expected boolean, received string"]);
  });

  it("names the missing packages instead of the failed union", () => {
    const e = configErrorFrom(() => loadFixture({ apps, builtins: { protos: {} } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages: the protos built-in needs "packages": the shared packages it links, e.g. ["@myorg/protos"]',
    ]);
  });

  it("rejects an empty package list", () => {
    const e = configErrorFrom(() => loadFixture({ apps, builtins: { protos: { packages: [] } } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages: "packages" must name at least one shared package, e.g. ["@myorg/protos"]',
    ]);
  });

  it("rejects anything that is not a package name, addressed by index", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps, builtins: { protos: { packages: ["@myorg/protos", "../local/protos"] } } }),
    );
    expect(issueLines(e)).toEqual([
      'builtins.protos.packages[1]: invalid shared package name: expected "name" or "@scope/name"',
    ]);
  });

  it("rejects a duplicate package, pointing at the entry to delete", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps,
        builtins: { protos: { packages: ["@myorg/protos", "@myorg/react-query", "@myorg/protos"] } },
      }),
    );
    expect(issueLines(e)).toEqual(['builtins.protos.packages[2]: duplicate package "@myorg/protos"']);
  });

  it("rejects a non-positive interval and an unknown option key", () => {
    const interval = configErrorFrom(() =>
      loadFixture({ apps, builtins: { protos: { packages: ["p"], interval: 0 } } }),
    );
    expect(interval.issues.map((i) => i.path)).toEqual(["builtins.protos.interval"]);

    const unknown = configErrorFrom(() =>
      loadFixture({ apps, builtins: { protos: { packages: ["p"], intervall: 10 } } }),
    );
    expect(issueLines(unknown)).toEqual(['builtins.protos: Unrecognized key: "intervall"']);
  });

  it("falls back to the union summary when nothing matched the shape", () => {
    const e = configErrorFrom(() => loadFixture({ apps, builtins: { protos: 3 } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos: expected false, or options like { "packages": ["@myorg/protos"] }',
    ]);
  });

  it("addresses a malformed plugin entry inside the entry", () => {
    const noSpec = configErrorFrom(() => loadFixture({ apps, plugins: [{ options: { a: 1 } }] }));
    expect(noSpec.issues.map((i) => i.path)).toEqual(["plugins[0].spec"]);

    const typo = configErrorFrom(() =>
      loadFixture({ apps, plugins: ["./ok.ts", { spec: "./x.ts", optionz: {} }] }),
    );
    expect(issueLines(typo)).toEqual(['plugins[1]: Unrecognized key: "optionz"']);

    const notAnObject = configErrorFrom(() =>
      loadFixture({ apps, plugins: [{ spec: "./x.ts", options: 3 }] }),
    );
    expect(notAnObject.issues.map((i) => i.path)).toEqual(["plugins[0].options"]);
  });

  it("explains what a plugin entry may be when it is neither shape", () => {
    const e = configErrorFrom(() => loadFixture({ apps, plugins: [3] }));
    expect(issueLines(e)).toEqual([
      'plugins[0]: expected a package name or path, or { "spec": "…", "options": { … } }',
    ]);
  });
});

describe("entry points", () => {
  it("loads a config by explicit path", () => {
    const dir = writeConfig({ apps: { db: { path: "." } } });
    const ws = loadWorkspaceFrom(path.join(dir, "u8.jsonc"));
    expect(ws.rootDir).toBe(dir);
  });

  it("reports a missing file as CONFIG_NOT_FOUND", () => {
    const dir = writeConfig({ apps: { db: { path: "." } } });
    const e = u8ErrorFrom(() => loadWorkspaceFrom(path.join(dir, "nope.jsonc")));
    expect(e).toBeInstanceOf(U8Error);
    expect(e.code).toBe("CONFIG_NOT_FOUND");
  });
});
