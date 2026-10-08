import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  DEFAULT_PROTOS_INTERVAL_MS,
  DEFAULT_TEMPLATES,
} from "../../src/config/types.js";
import { app, cleanupWorkspaces, cmd, configErrorFrom, issueLines, loadFixture } from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("implicit apps", () => {
  it("turns a repo without apps into a single implicit app", () => {
    const { dir, ws } = loadFixture({
      repos: {
        gateway: {
          path: "./gw",
          scripts: { start: "pnpm dev", stop: "pkill gw" },
          health: { http: "http://localhost:3000/healthz" },
          restart: "on-crash",
        },
      },
    });

    expect(ws.apps.map((a) => a.id)).toEqual(["gateway"]);
    expect(app(ws, "gateway")).toMatchObject({
      id: "gateway",
      repoName: "gateway",
      name: "gateway",
      implicit: true,
      cwd: path.join(dir, "gw"),
      scripts: { start: "pnpm dev", stop: "pkill gw" },
      restart: "on-crash",
    });
    expect(app(ws, "gateway").health).toEqual({
      http: "http://localhost:3000/healthz",
      intervalMs: 5_000,
      timeoutMs: 2_000,
      threshold: 2,
    });
  });

  it("treats an empty apps map as no apps, with quiet defaults", () => {
    const { ws } = loadFixture({ repos: { gateway: { path: ".", apps: {} } } });
    expect(ws.apps.map((a) => a.id)).toEqual(["gateway"]);
    expect(app(ws, "gateway")).toMatchObject({
      implicit: true,
      restart: "no",
      dependsOn: [],
      scripts: {},
      env: {},
    });
    expect(app(ws, "gateway").health).toBeUndefined();
  });

  it("ids explicit apps as repo.app and keeps config order", () => {
    const { ws } = loadFixture({
      repos: {
        platform: { path: ".", apps: { shell: {}, "auth-mfe": {} } },
        gateway: { path: "." },
      },
    });
    expect(ws.apps.map((a) => a.id)).toEqual(["platform.shell", "platform.auth-mfe", "gateway"]);
    expect(app(ws, "platform.shell").implicit).toBe(false);
  });
});

describe("repo defaults inherited by apps", () => {
  const fixture = () =>
    loadFixture({
      repos: {
        platform: {
          path: "./mono",
          scripts: { start: "pnpm dev", build: "pnpm build" },
          health: { http: "http://localhost:1/health" },
          restart: "on-crash",
          readyTimeout: 1_000,
          stopTimeout: 2_000,
          dependsOn: [],
          apps: {
            shell: { path: "apps/shell" },
            api: {
              path: "apps/api",
              scripts: { start: "pnpm dev --port 3001" },
              health: { cmd: "curl -sf localhost:3001", threshold: 5 },
              restart: "no",
              readyTimeout: 9_000,
            },
          },
        },
      },
    });

  it("inherits repo-level values when the app says nothing", () => {
    const { ws } = fixture();
    const shell = app(ws, "platform.shell");
    expect(shell.scripts).toEqual({ start: "pnpm dev", build: "pnpm build" });
    expect(shell.restart).toBe("on-crash");
    expect(shell.readyTimeoutMs).toBe(1_000);
    expect(shell.stopTimeoutMs).toBe(2_000);
    expect(shell.health?.http).toBe("http://localhost:1/health");
  });

  it("lets the app override, merging scripts key by key", () => {
    const { ws } = fixture();
    const api = app(ws, "platform.api");
    expect(api.scripts).toEqual({ start: "pnpm dev --port 3001", build: "pnpm build" });
    expect(api.restart).toBe("no");
    expect(api.readyTimeoutMs).toBe(9_000);
    // Inherited from the repo, since the app sets no stopTimeout.
    expect(api.stopTimeoutMs).toBe(2_000);
  });

  it("replaces health wholesale so http and cmd never mix", () => {
    const { ws } = fixture();
    expect(app(ws, "platform.api").health).toEqual({
      cmd: "curl -sf localhost:3001",
      intervalMs: 5_000,
      timeoutMs: 2_000,
      threshold: 5,
    });
  });

  it("falls back to the workspace limits for timeouts nobody set", () => {
    const { ws } = loadFixture({ repos: { gateway: { path: "." } } });
    expect(app(ws, "gateway").readyTimeoutMs).toBe(DEFAULT_LIMITS.readyTimeoutMs);
    expect(app(ws, "gateway").stopTimeoutMs).toBe(DEFAULT_LIMITS.stopTimeoutMs);
  });
});

describe("env", () => {
  it("merges workspace → repo → app, last writer winning", () => {
    const { ws } = loadFixture({
      env: { SHARED: "workspace", FROM_WS: "1" },
      repos: {
        platform: {
          path: ".",
          env: { SHARED: "repo", FROM_REPO: "1" },
          apps: {
            shell: { env: { SHARED: "app", FROM_APP: "1" } },
            api: {},
          },
        },
      },
    });

    expect(app(ws, "platform.shell").env).toEqual({
      SHARED: "app",
      FROM_WS: "1",
      FROM_REPO: "1",
      FROM_APP: "1",
    });
    expect(app(ws, "platform.api").env).toEqual({ SHARED: "repo", FROM_WS: "1", FROM_REPO: "1" });
  });

  it("gives an implicit app the workspace + repo env", () => {
    const { ws } = loadFixture({
      env: { A: "ws" },
      repos: { gateway: { path: ".", env: { B: "repo" } } },
    });
    expect(app(ws, "gateway").env).toEqual({ A: "ws", B: "repo" });
  });
});

describe("paths", () => {
  it("expands ~ and resolves repo paths against the workspace root", () => {
    const { dir, ws } = loadFixture({
      repos: {
        home: { path: "~/Work/proj" },
        rel: { path: "./services/api" },
        abs: { path: "/opt/thing" },
      },
    });
    expect(ws.rootDir).toBe(dir);
    expect(app(ws, "home").cwd).toBe(path.join(os.homedir(), "Work/proj"));
    expect(app(ws, "rel").cwd).toBe(path.join(dir, "services/api"));
    expect(app(ws, "abs").cwd).toBe("/opt/thing");
  });

  it("resolves app paths against the repo path, defaulting to the repo dir", () => {
    const { dir, ws } = loadFixture({
      repos: {
        platform: {
          path: "./mono",
          apps: { shell: { path: "apps/shell" }, root: {}, up: { path: "../sibling" } },
        },
      },
    });
    expect(app(ws, "platform.shell").cwd).toBe(path.join(dir, "mono/apps/shell"));
    expect(app(ws, "platform.root").cwd).toBe(path.join(dir, "mono"));
    expect(app(ws, "platform.up").cwd).toBe(path.join(dir, "sibling"));
  });
});

/**
 * The likeliest mistake in a first config is a `path` that names nothing on
 * disk. Reported as warnings rather than `ConfigError` issues on purpose — see
 * `directoryWarnings` in `normalize.ts` — so the check is pinned here as
 * *non-fatal*: the workspace must still load, apps and all.
 */
describe("directories that are not there", () => {
  it("warns with the dotted config path and the absolute directory, and still loads", () => {
    const { dir, ws } = loadFixture({
      repos: { web: { path: "services/web", scripts: { start: "npm run dev" } } },
    });

    expect(ws.warnings).toEqual([`repos.web.path: no such directory: ${path.join(dir, "services/web")}`]);
    expect(ws.apps.map((a) => a.id)).toEqual(["web"]);
    expect(app(ws, "web").scripts).toEqual({ start: "npm run dev" });
  });

  it("says nothing when every resolved directory is really there", () => {
    const { ws } = loadFixture(
      { repos: { mono: { path: "mono", apps: { shell: { path: "apps/shell" }, root: {} } } } },
      { "mono/apps/shell/.keep": "" },
    );
    expect(ws.warnings).toEqual([]);
  });

  it("names the app entry when the app's own path is the missing one", () => {
    const { dir, ws } = loadFixture({
      repos: { mono: { path: ".", apps: { shell: { path: "apps/shell" } } } },
    });
    expect(ws.warnings).toEqual([
      `repos.mono.apps.shell.path: no such directory: ${path.join(dir, "apps/shell")}`,
    ]);
  });

  it("reports the repo once rather than once per app beneath it", () => {
    const { dir, ws } = loadFixture({
      repos: { mono: { path: "gone", apps: { shell: { path: "apps/shell" }, root: {} } } },
    });
    expect(ws.warnings).toEqual([`repos.mono.path: no such directory: ${path.join(dir, "gone")}`]);
  });

  it("still checks an app whose path escapes the missing repo directory", () => {
    const { dir, ws } = loadFixture({
      repos: { mono: { path: "gone", apps: { away: { path: "../elsewhere" } } } },
    });
    expect(ws.warnings).toEqual([
      `repos.mono.path: no such directory: ${path.join(dir, "gone")}`,
      `repos.mono.apps.away.path: no such directory: ${path.join(dir, "elsewhere")}`,
    ]);
  });

  it("distinguishes a path that exists but is a file", () => {
    const { dir, ws } = loadFixture({ repos: { web: { path: "package.json" } } }, { "package.json": "{}" });
    expect(ws.warnings).toEqual([`repos.web.path: not a directory: ${path.join(dir, "package.json")}`]);
  });

  it("collects directory problems ahead of template typos", () => {
    const { dir, ws } = loadFixture({
      repos: { web: { path: "services/web" } },
      templates: { repo: "{gti@branch}" },
    });
    expect(ws.warnings[0]).toBe(`repos.web.path: no such directory: ${path.join(dir, "services/web")}`);
    expect(ws.warnings[1]).toContain("templates.repo");
  });
});

describe("dependsOn", () => {
  it("expands a repo dependency to every one of its apps and dedupes", () => {
    const { ws } = loadFixture({
      repos: {
        db: { path: "." },
        platform: { path: ".", apps: { shell: {}, api: {} } },
        gateway: { path: ".", dependsOn: ["platform", "db", "platform.shell"] },
      },
    });
    expect(app(ws, "gateway").dependsOn).toEqual(["platform.shell", "platform.api", "db"]);
  });

  it("applies a repo-level dependsOn to each app unless overridden", () => {
    const { ws } = loadFixture({
      repos: {
        db: { path: "." },
        cache: { path: "." },
        platform: { path: ".", dependsOn: ["db"], apps: { shell: {}, api: { dependsOn: ["cache"] } } },
      },
    });
    expect(app(ws, "platform.shell").dependsOn).toEqual(["db"]);
    expect(app(ws, "platform.api").dependsOn).toEqual(["cache"]);
  });

  it("rejects an unknown dependency, naming the config path", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { gateway: { path: ".", dependsOn: ["db", "nope"] } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["repos.gateway.dependsOn[0]", "repos.gateway.dependsOn[1]"]);
    expect(e.format()).toContain('unknown target "nope"');
  });

  it("reports a bad repo-level reference once, not once per inheriting app", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos: { platform: { path: ".", dependsOn: ["ghost"], apps: { a: {}, b: {}, c: {} } } },
      }),
    );
    expect(issueLines(e)).toEqual([
      'repos.platform.dependsOn[0]: unknown target "ghost" — expected a repo name or "repo.app"',
    ]);
  });

  it("gives each app its own dependency list, not a shared one", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." }, platform: { path: ".", dependsOn: ["db"], apps: { a: {}, b: {} } } },
    });
    app(ws, "platform.a").dependsOn.push("db");
    expect(app(ws, "platform.b").dependsOn).toEqual(["db"]);
  });

  it("detects a cycle across the expanded graph", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos: {
          a: { path: ".", dependsOn: ["b"] },
          b: { path: ".", apps: { x: { dependsOn: ["c"] } } },
          c: { path: ".", dependsOn: ["a"] },
        },
      }),
    );
    const message = e.issues[0]?.message ?? "";
    expect(message).toContain("dependency cycle");
    for (const id of ["a", "b.x", "c"]) expect(message).toContain(id);
  });

  it("accepts a diamond that is not a cycle", () => {
    const { ws } = loadFixture({
      repos: {
        db: { path: "." },
        a: { path: ".", dependsOn: ["db"] },
        b: { path: ".", dependsOn: ["db"] },
        top: { path: ".", dependsOn: ["a", "b"] },
      },
    });
    expect(app(ws, "top").dependsOn).toEqual(["a", "b"]);
  });
});

describe("profiles", () => {
  it("synthesizes a default 'all' profile when none are declared", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." }, platform: { path: ".", apps: { shell: {}, api: {} } } },
    });
    expect(ws.profiles).toEqual([
      {
        name: "all",
        isDefault: true,
        targets: ["db", "platform"],
        appIds: ["db", "platform.shell", "platform.api"],
      },
    ]);
    expect(ws.defaultProfile).toBe("all");
  });

  it("promotes the first declared profile when none is marked default", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." }, gateway: { path: "." } },
      profiles: { frontend: { targets: ["gateway"] }, full: { targets: ["db", "gateway"] } },
    });
    expect(ws.defaultProfile).toBe("frontend");
    expect(ws.profiles.map((p) => p.isDefault)).toEqual([true, false]);
  });

  it("honours an explicit default anywhere in the list", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." }, gateway: { path: "." } },
      profiles: { frontend: { targets: ["gateway"] }, full: { default: true, targets: ["db"] } },
    });
    expect(ws.defaultProfile).toBe("full");
  });

  it("expands repo targets to app ids while keeping the authored strings", () => {
    const { ws } = loadFixture({
      repos: { platform: { path: ".", apps: { shell: {}, api: {} } }, db: { path: "." } },
      profiles: { mix: { targets: ["platform", "db", "platform.shell"] } },
    });
    expect(ws.profiles[0]).toMatchObject({
      targets: ["platform", "db", "platform.shell"],
      appIds: ["platform.shell", "platform.api", "db"],
    });
  });

  it("rejects two default profiles", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos: { db: { path: "." } },
        profiles: { a: { default: true, targets: ["db"] }, b: { default: true, targets: ["db"] } },
      }),
    );
    expect(issueLines(e)).toEqual(['profiles: only one profile may set "default": true (got a, b)']);
  });

  it("rejects an unknown profile target", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: "." } }, profiles: { a: { targets: ["db", "ghost"] } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["profiles.a.targets[1]"]);
  });
});

describe("commands", () => {
  it("normalizes hooks to arrays and expands target overrides to app ids", () => {
    const { ws } = loadFixture({
      repos: { platform: { path: ".", apps: { shell: {}, api: {} } }, db: { path: "." } },
      commands: {
        test: {
          description: "run tests",
          script: "pnpm test",
          targets: { platform: "pnpm -r test", db: null },
          concurrency: 2,
          hooks: { pre: "git diff --quiet", post: ["echo a", "echo b"] },
        },
      },
    });

    expect(cmd(ws, "test")).toMatchObject({
      name: "test",
      kind: "task",
      source: "config",
      description: "run tests",
      script: "pnpm test",
      concurrency: 2,
      targetScripts: { "platform.shell": "pnpm -r test", "platform.api": "pnpm -r test", db: null },
      hooks: { pre: ["git diff --quiet"], post: ["echo a", "echo b"] },
    });
  });

  it("defaults kind to task", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      commands: { seed: { script: "echo" }, watch: { kind: "service", script: "echo" } },
    });
    expect(cmd(ws, "seed").kind).toBe("task");
    expect(cmd(ws, "watch").kind).toBe("service");
    expect(cmd(ws, "seed").hooks).toEqual({ pre: [], post: [] });
    expect(cmd(ws, "seed").targetScripts).toEqual({});
  });

  it("appends the core app:* commands with per-target start/stop scripts", () => {
    const { ws } = loadFixture({
      repos: {
        db: { path: ".", scripts: { start: "docker compose up", stop: "docker compose down" } },
        gateway: { path: ".", scripts: { start: "pnpm dev" } },
        docs: { path: "." },
      },
      commands: { test: { script: "pnpm test" } },
    });

    expect(ws.commands.map((c) => c.name)).toEqual(["test", "app:start", "app:stop", "app:restart"]);
    expect(cmd(ws, "app:start")).toMatchObject({ kind: "service", source: "core" });
    expect(cmd(ws, "app:start").targetScripts).toEqual({
      db: "docker compose up",
      gateway: "pnpm dev",
      docs: null,
    });
    expect(cmd(ws, "app:stop").targetScripts).toEqual({
      db: "docker compose down",
      gateway: null,
      docs: null,
    });
    expect(cmd(ws, "app:restart").targetScripts).toEqual({ db: null, gateway: null, docs: null });
  });

  it("lets an app entry beat a repo-wide one whichever order they are written in", () => {
    const targetScripts = (targets: Record<string, string | null>) =>
      loadFixture({
        repos: { platform: { path: ".", apps: { shell: {}, api: {} } } },
        commands: { build: { targets } },
      }).ws.commands[0]?.targetScripts;

    const expected = { "platform.shell": null, "platform.api": "pnpm build" };
    expect(targetScripts({ platform: "pnpm build", "platform.shell": null })).toEqual(expected);
    expect(targetScripts({ "platform.shell": null, platform: "pnpm build" })).toEqual(expected);
  });

  it("rejects a namespaced user command", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: "." } }, commands: { "git:pull": { script: "git pull" } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["commands.git:pull"]);
    expect(e.issues[0]?.message).toContain("must be bare");
  });

  it("rejects an unknown command target", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        repos: { db: { path: "." } },
        commands: { test: { script: "x", targets: { ghost: null } } },
      }),
    );
    expect(issueLines(e)).toEqual([
      'commands.test.targets.ghost: unknown target "ghost" — expected a repo name or "repo.app"',
    ]);
  });
});

describe("indicators, plugins, limits, templates", () => {
  it("fills indicator defaults", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      indicators: {
        version: { cmd: "jq -r .version package.json", interval: 60_000, scope: "repo" },
        port: { cmd: "echo 3000" },
      },
    });
    expect(ws.indicators).toEqual([
      { name: "version", cmd: "jq -r .version package.json", intervalMs: 60_000, scope: "repo" },
      { name: "port", cmd: "echo 3000", intervalMs: 5_000, scope: "app" },
    ]);
  });

  it("rejects a namespaced indicator name", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: "." } }, indicators: { "x@version": { cmd: "echo" } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["indicators.x@version"]);
  });

  it("resolves local plugin specs and leaves package names alone", () => {
    const { dir, ws } = loadFixture({
      repos: { db: { path: "." } },
      plugins: ["./plugins/deploy.ts", "u8-plugin-thing"],
    });
    expect(ws.plugins).toEqual([
      { spec: "./plugins/deploy.ts", resolved: path.join(dir, "plugins/deploy.ts") },
      { spec: "u8-plugin-thing" },
    ]);
  });

  it("fills limits, templates and builtins from defaults", () => {
    const { ws } = loadFixture({ repos: { db: { path: "." } } });
    expect(ws.limits).toEqual(DEFAULT_LIMITS);
    expect(ws.templates).toEqual(DEFAULT_TEMPLATES);
    // protos is the exception: nothing to link until a workspace configures it.
    expect(ws.builtins).toEqual({ git: true, health: true, protos: false });
    expect(ws.builtinOptions).toEqual({});
  });

  it("maps the raw limit names onto the millisecond model", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      limits: { stopTimeout: 1_000, readyTimeout: 2_000, daemonIdle: 3_000, logKeep: 7 },
    });
    expect(ws.limits).toEqual({
      ...DEFAULT_LIMITS,
      stopTimeoutMs: 1_000,
      readyTimeoutMs: 2_000,
      daemonIdleMs: 3_000,
      logKeep: 7,
    });
    expect(app(ws, "db").stopTimeoutMs).toBe(1_000);
    expect(app(ws, "db").readyTimeoutMs).toBe(2_000);
  });

  it("keeps per-entry template overrides and defaults the workspace name to the directory", () => {
    const { dir, ws } = loadFixture({
      templates: { app: "{app@name}" },
      repos: { platform: { path: ".", template: "REPO {repo@name}", apps: { shell: { template: "APP" } } } },
    });
    expect(ws.name).toBe(path.basename(dir));
    expect(ws.templates).toEqual({ repo: DEFAULT_TEMPLATES.repo, app: "{app@name}" });
    expect(ws.repos[0]?.template).toBe("REPO {repo@name}");
    expect(app(ws, "platform.shell").template).toBe("APP");
  });

  it("gives an implicit app the repo's template so the merged row renders it", () => {
    const { ws } = loadFixture({ repos: { db: { path: ".", template: "ROW {app@name}" } } });
    expect(ws.repos[0]?.template).toBe("ROW {app@name}");
    expect(app(ws, "db").template).toBe("ROW {app@name}");
  });
});

/**
 * `builtins` and `plugins` each accept two shapes — a switch or a spec on its
 * own, and the same thing carrying options. Enablement and configuration are
 * separated on the way out (`builtins` vs `builtinOptions`) so that "off" and
 * "configured" never have to be read out of one field.
 */
describe("built-ins and plugin options", () => {
  const repo = { db: { path: "." } };

  it("takes a boolean for each built-in and carries no options", () => {
    const { ws } = loadFixture({ repos: repo, builtins: { git: false, health: true, protos: false } });
    expect(ws.builtins).toEqual({ git: false, health: true, protos: false });
    expect(ws.builtinOptions).toEqual({});
  });

  it("reads an options object as enabled-and-configured", () => {
    const { ws } = loadFixture({
      repos: repo,
      builtins: { protos: { packages: ["@myorg/protos", "@myorg/react-query"] } },
    });
    expect(ws.builtins.protos).toBe(true);
    expect(ws.builtinOptions).toEqual({
      protos: {
        packages: ["@myorg/protos", "@myorg/react-query"],
        intervalMs: DEFAULT_PROTOS_INTERVAL_MS,
      },
    });
  });

  it("maps the raw protos interval onto the millisecond model", () => {
    const { ws } = loadFixture({
      repos: repo,
      builtins: { protos: { packages: ["protos"], interval: 250 } },
    });
    expect(ws.builtinOptions["protos"]).toEqual({ packages: ["protos"], intervalMs: 250 });
  });

  it("refuses to enable protos with nothing to link", () => {
    const e = configErrorFrom(() => loadFixture({ repos: repo, builtins: { protos: true } }));
    expect(issueLines(e)).toEqual([
      'builtins.protos: the protos built-in has nothing to link until it is told which packages are shared: replace true with { "packages": ["@myorg/protos"] }',
    ]);
  });

  it("keeps a bare plugin spec working exactly as before", () => {
    const { dir, ws } = loadFixture({ repos: repo, plugins: ["./plugins/deploy.ts", "u8-plugin-thing"] });
    expect(ws.plugins).toEqual([
      { spec: "./plugins/deploy.ts", resolved: path.join(dir, "plugins/deploy.ts") },
      { spec: "u8-plugin-thing" },
    ]);
  });

  it("carries plugin options through untouched, whatever their shape", () => {
    // Verbatim matters: the options belong to the plugin's factory, and this
    // layer cannot know which key means what.
    const options = {
      endpoint: "http://localhost:9090",
      retries: 3,
      nested: { deep: [1, null, { ok: true }] },
      off: false,
    };
    const { dir, ws } = loadFixture({
      repos: repo,
      plugins: [{ spec: "./plugins/metrics.ts", options }, { spec: "@acme/notify" }],
    });
    expect(ws.plugins).toEqual([
      { spec: "./plugins/metrics.ts", resolved: path.join(dir, "plugins/metrics.ts"), options },
      { spec: "@acme/notify" },
    ]);
    expect(ws.plugins[0]?.options).toEqual(options);
  });

  it("trusts the protos namespace in templates only once it is configured", () => {
    const configured = loadFixture({
      repos: repo,
      builtins: { protos: { packages: ["@myorg/protos"] } },
      templates: { repo: "{protos@version}" },
    });
    expect(configured.ws.warnings).toEqual([]);

    const unconfigured = loadFixture({ repos: repo, templates: { repo: "{protos@version}" } });
    expect(unconfigured.ws.warnings).toHaveLength(1);
    expect(unconfigured.ws.warnings[0]).toContain("{protos@version}");
  });

  it("trusts the namespace of a plugin declared in object form", () => {
    const { ws } = loadFixture({
      repos: repo,
      plugins: [{ spec: "@acme/metrics", options: { endpoint: "x" } }],
      templates: { repo: "{metrics@rps}" },
    });
    expect(ws.warnings).toEqual([]);
  });
});

/**
 * SPEC §4: a bad template token "warns at load". Warnings are non-fatal by
 * construction — the row renders a red `{ns@name!}` marker — so they ride on the
 * normalized workspace instead of aborting the load like a `ConfigError` issue.
 */
describe("template warnings", () => {
  it("says nothing about a clean config", () => {
    const { ws } = loadFixture({
      repos: { db: { path: ".", template: "{app@status} {git@branch} {health@status}" } },
      indicators: { version: { cmd: "echo 1" } },
      templates: { repo: "{repo@name} {repo@status}", app: "{app@name:pad(10)} {x@version:dim}" },
    });
    expect(ws.warnings).toEqual([]);
  });

  it("collects parser warnings from workspace and per-entry templates, and still loads", () => {
    const { ws } = loadFixture({
      templates: { repo: "{repo@name", app: "{app@status:pad(x)}" },
      repos: {
        platform: {
          path: ".",
          template: "{repo nam}",
          apps: { shell: { template: "{app@name:nope}" } },
        },
      },
    });

    expect(ws.apps.map((a) => a.id)).toEqual(["platform.shell"]);
    expect(ws.warnings).toEqual([
      'templates.repo: unterminated token "{repo@name"',
      'templates.app: pad() expects an integer width between 0 and 1000 in "{app@status:pad(x)}"',
      'repos.platform.template: malformed token "{repo nam}" (expected {ns@indicator})',
      'repos.platform.apps.shell.template: unknown modifier "nope" in "{app@name:nope}"',
    ]);
  });

  it("flags an app-row token on a repo header row, where nothing answers it", () => {
    const { ws } = loadFixture({
      templates: { repo: "{app@name} {repo@status}", app: "{app@name} {repo@dirname}" },
      repos: {
        // One app: the repo's template is the merged row, which is an app row.
        api: { path: ".", template: "{app@status}" },
        // Several: it is the header row.
        platform: { path: ".", template: "{app@pid} {git@branch}", apps: { web: {}, admin: {} } },
      },
    });
    expect(ws.warnings).toEqual([
      "templates.repo: {app@name} is an app-row token — a repo header row reads {repo@name}, {repo@dirname}, {repo@path}, {repo@instance} or {repo@status}",
      "repos.platform.template: {app@pid} is an app-row token — a repo header row reads {repo@name}, {repo@dirname}, {repo@path}, {repo@instance} or {repo@status}",
    ]);
  });

  it("flags a token whose namespace is neither core nor a declared plugin", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      templates: { repo: "{gti@branch}" },
    });
    expect(ws.warnings).toHaveLength(1);
    expect(ws.warnings[0]).toContain("templates.repo");
    expect(ws.warnings[0]).toContain("gti");
  });

  it("accepts the namespace of a declared plugin and of an enabled built-in", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      plugins: ["./plugins/deploy.ts", "@acme/metrics", "u8-plugin-notify", "./tools/audit/index.js"],
      templates: {
        repo: "{deploy@state} {metrics@rps} {notify@last} {audit@score} {git@branch} {health@status}",
      },
    });
    expect(ws.warnings).toEqual([]);
  });

  it("stops trusting a built-in namespace the config turned off", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      builtins: { git: false },
      templates: { repo: "{git@branch} {health@status}" },
    });
    expect(ws.warnings).toHaveLength(1);
    expect(ws.warnings[0]).toContain("{git@branch}");
  });

  it("flags an x@ token that names no declared indicator", () => {
    const { ws } = loadFixture({
      repos: { db: { path: "." } },
      indicators: { version: { cmd: "echo 1" } },
      templates: { repo: "{x@version} {x@versoin}" },
    });
    expect(ws.warnings).toHaveLength(1);
    expect(ws.warnings[0]).toContain("versoin");
  });

  it("never lets a template typo stop a workspace whose config is otherwise fatal", () => {
    const e = configErrorFrom(() =>
      loadFixture({ repos: { db: { path: ".", dependsOn: ["ghost"] } }, templates: { repo: "{gti@x}" } }),
    );
    expect(issueLines(e)).toEqual([
      'repos.db.dependsOn[0]: unknown target "ghost" — expected a repo name or "repo.app"',
    ]);
  });
});

describe("workspace identity", () => {
  it("reports the real config path, root dir and a stable id", () => {
    const { dir, ws } = loadFixture({ name: "demo", repos: { db: { path: "." } } });
    expect(ws.name).toBe("demo");
    expect(ws.configPath).toBe(path.join(dir, "u8.jsonc"));
    expect(ws.rootDir).toBe(dir);
    expect(ws.id).toMatch(/^[0-9a-f]{12}$/);
  });
});
