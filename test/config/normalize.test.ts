import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_TEMPLATES } from "../../src/config/types.js";
import { cleanupWorkspaces, cmd, configErrorFrom, issueLines, loadFixture, sub } from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("implicit subapps", () => {
  it("turns an app without subapps into a single implicit subapp", () => {
    const { dir, ws } = loadFixture({
      apps: {
        gateway: {
          path: "./gw",
          scripts: { start: "pnpm dev", stop: "pkill gw" },
          health: { http: "http://localhost:3000/healthz" },
          restart: "on-crash",
        },
      },
    });

    expect(ws.subapps.map((s) => s.id)).toEqual(["gateway"]);
    expect(sub(ws, "gateway")).toMatchObject({
      id: "gateway",
      appName: "gateway",
      name: "gateway",
      implicit: true,
      cwd: path.join(dir, "gw"),
      scripts: { start: "pnpm dev", stop: "pkill gw" },
      restart: "on-crash",
    });
    expect(sub(ws, "gateway").health).toEqual({
      http: "http://localhost:3000/healthz",
      intervalMs: 5_000,
      timeoutMs: 2_000,
      threshold: 2,
    });
  });

  it("treats an empty subapps map as no subapps, with quiet defaults", () => {
    const { ws } = loadFixture({ apps: { gateway: { path: ".", subapps: {} } } });
    expect(ws.subapps.map((s) => s.id)).toEqual(["gateway"]);
    expect(sub(ws, "gateway")).toMatchObject({
      implicit: true,
      restart: "no",
      dependsOn: [],
      scripts: {},
      env: {},
    });
    expect(sub(ws, "gateway").health).toBeUndefined();
  });

  it("ids explicit subapps as app.subapp and keeps config order", () => {
    const { ws } = loadFixture({
      apps: {
        platform: { path: ".", subapps: { shell: {}, "auth-mfe": {} } },
        gateway: { path: "." },
      },
    });
    expect(ws.subapps.map((s) => s.id)).toEqual(["platform.shell", "platform.auth-mfe", "gateway"]);
    expect(sub(ws, "platform.shell").implicit).toBe(false);
  });
});

describe("app defaults inherited by subapps", () => {
  const fixture = () =>
    loadFixture({
      apps: {
        platform: {
          path: "./mono",
          scripts: { start: "pnpm dev", build: "pnpm build" },
          health: { http: "http://localhost:1/health" },
          restart: "on-crash",
          readyTimeout: 1_000,
          stopTimeout: 2_000,
          dependsOn: [],
          subapps: {
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

  it("inherits app-level values when the subapp says nothing", () => {
    const { ws } = fixture();
    const shell = sub(ws, "platform.shell");
    expect(shell.scripts).toEqual({ start: "pnpm dev", build: "pnpm build" });
    expect(shell.restart).toBe("on-crash");
    expect(shell.readyTimeoutMs).toBe(1_000);
    expect(shell.stopTimeoutMs).toBe(2_000);
    expect(shell.health?.http).toBe("http://localhost:1/health");
  });

  it("lets the subapp override, merging scripts key by key", () => {
    const { ws } = fixture();
    const api = sub(ws, "platform.api");
    expect(api.scripts).toEqual({ start: "pnpm dev --port 3001", build: "pnpm build" });
    expect(api.restart).toBe("no");
    expect(api.readyTimeoutMs).toBe(9_000);
    // Inherited from the app, since the subapp sets no stopTimeout.
    expect(api.stopTimeoutMs).toBe(2_000);
  });

  it("replaces health wholesale so http and cmd never mix", () => {
    const { ws } = fixture();
    expect(sub(ws, "platform.api").health).toEqual({
      cmd: "curl -sf localhost:3001",
      intervalMs: 5_000,
      timeoutMs: 2_000,
      threshold: 5,
    });
  });

  it("falls back to the workspace limits for timeouts nobody set", () => {
    const { ws } = loadFixture({ apps: { gateway: { path: "." } } });
    expect(sub(ws, "gateway").readyTimeoutMs).toBe(DEFAULT_LIMITS.readyTimeoutMs);
    expect(sub(ws, "gateway").stopTimeoutMs).toBe(DEFAULT_LIMITS.stopTimeoutMs);
  });
});

describe("env", () => {
  it("merges workspace → app → subapp, last writer winning", () => {
    const { ws } = loadFixture({
      env: { SHARED: "workspace", FROM_WS: "1" },
      apps: {
        platform: {
          path: ".",
          env: { SHARED: "app", FROM_APP: "1" },
          subapps: {
            shell: { env: { SHARED: "subapp", FROM_SUBAPP: "1" } },
            api: {},
          },
        },
      },
    });

    expect(sub(ws, "platform.shell").env).toEqual({
      SHARED: "subapp",
      FROM_WS: "1",
      FROM_APP: "1",
      FROM_SUBAPP: "1",
    });
    expect(sub(ws, "platform.api").env).toEqual({ SHARED: "app", FROM_WS: "1", FROM_APP: "1" });
  });

  it("gives an implicit subapp the workspace + app env", () => {
    const { ws } = loadFixture({
      env: { A: "ws" },
      apps: { gateway: { path: ".", env: { B: "app" } } },
    });
    expect(sub(ws, "gateway").env).toEqual({ A: "ws", B: "app" });
  });
});

describe("paths", () => {
  it("expands ~ and resolves app paths against the workspace root", () => {
    const { dir, ws } = loadFixture({
      apps: {
        home: { path: "~/Work/proj" },
        rel: { path: "./services/api" },
        abs: { path: "/opt/thing" },
      },
    });
    expect(ws.rootDir).toBe(dir);
    expect(sub(ws, "home").cwd).toBe(path.join(os.homedir(), "Work/proj"));
    expect(sub(ws, "rel").cwd).toBe(path.join(dir, "services/api"));
    expect(sub(ws, "abs").cwd).toBe("/opt/thing");
  });

  it("resolves subapp paths against the app path, defaulting to the app dir", () => {
    const { dir, ws } = loadFixture({
      apps: {
        platform: {
          path: "./mono",
          subapps: { shell: { path: "apps/shell" }, root: {}, up: { path: "../sibling" } },
        },
      },
    });
    expect(sub(ws, "platform.shell").cwd).toBe(path.join(dir, "mono/apps/shell"));
    expect(sub(ws, "platform.root").cwd).toBe(path.join(dir, "mono"));
    expect(sub(ws, "platform.up").cwd).toBe(path.join(dir, "sibling"));
  });
});

describe("dependsOn", () => {
  it("expands an app dependency to every one of its subapps and dedupes", () => {
    const { ws } = loadFixture({
      apps: {
        db: { path: "." },
        platform: { path: ".", subapps: { shell: {}, api: {} } },
        gateway: { path: ".", dependsOn: ["platform", "db", "platform.shell"] },
      },
    });
    expect(sub(ws, "gateway").dependsOn).toEqual(["platform.shell", "platform.api", "db"]);
  });

  it("applies an app-level dependsOn to each subapp unless overridden", () => {
    const { ws } = loadFixture({
      apps: {
        db: { path: "." },
        cache: { path: "." },
        platform: { path: ".", dependsOn: ["db"], subapps: { shell: {}, api: { dependsOn: ["cache"] } } },
      },
    });
    expect(sub(ws, "platform.shell").dependsOn).toEqual(["db"]);
    expect(sub(ws, "platform.api").dependsOn).toEqual(["cache"]);
  });

  it("rejects an unknown dependency, naming the config path", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { gateway: { path: ".", dependsOn: ["db", "nope"] } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["apps.gateway.dependsOn[0]", "apps.gateway.dependsOn[1]"]);
    expect(e.format()).toContain('unknown target "nope"');
  });

  it("reports a bad app-level reference once, not once per inheriting subapp", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps: { platform: { path: ".", dependsOn: ["ghost"], subapps: { a: {}, b: {}, c: {} } } },
      }),
    );
    expect(issueLines(e)).toEqual([
      'apps.platform.dependsOn[0]: unknown target "ghost" — expected an app name or "app.subapp"',
    ]);
  });

  it("gives each subapp its own dependency list, not a shared one", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." }, platform: { path: ".", dependsOn: ["db"], subapps: { a: {}, b: {} } } },
    });
    sub(ws, "platform.a").dependsOn.push("db");
    expect(sub(ws, "platform.b").dependsOn).toEqual(["db"]);
  });

  it("detects a cycle across the expanded graph", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps: {
          a: { path: ".", dependsOn: ["b"] },
          b: { path: ".", subapps: { x: { dependsOn: ["c"] } } },
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
      apps: {
        db: { path: "." },
        a: { path: ".", dependsOn: ["db"] },
        b: { path: ".", dependsOn: ["db"] },
        top: { path: ".", dependsOn: ["a", "b"] },
      },
    });
    expect(sub(ws, "top").dependsOn).toEqual(["a", "b"]);
  });
});

describe("profiles", () => {
  it("synthesizes a default 'all' profile when none are declared", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." }, platform: { path: ".", subapps: { shell: {}, api: {} } } },
    });
    expect(ws.profiles).toEqual([
      {
        name: "all",
        isDefault: true,
        targets: ["db", "platform"],
        subappIds: ["db", "platform.shell", "platform.api"],
      },
    ]);
    expect(ws.defaultProfile).toBe("all");
  });

  it("promotes the first declared profile when none is marked default", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." }, gateway: { path: "." } },
      profiles: { frontend: { targets: ["gateway"] }, full: { targets: ["db", "gateway"] } },
    });
    expect(ws.defaultProfile).toBe("frontend");
    expect(ws.profiles.map((p) => p.isDefault)).toEqual([true, false]);
  });

  it("honours an explicit default anywhere in the list", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." }, gateway: { path: "." } },
      profiles: { frontend: { targets: ["gateway"] }, full: { default: true, targets: ["db"] } },
    });
    expect(ws.defaultProfile).toBe("full");
  });

  it("expands app targets to subapp ids while keeping the authored strings", () => {
    const { ws } = loadFixture({
      apps: { platform: { path: ".", subapps: { shell: {}, api: {} } }, db: { path: "." } },
      profiles: { mix: { targets: ["platform", "db", "platform.shell"] } },
    });
    expect(ws.profiles[0]).toMatchObject({
      targets: ["platform", "db", "platform.shell"],
      subappIds: ["platform.shell", "platform.api", "db"],
    });
  });

  it("rejects two default profiles", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps: { db: { path: "." } },
        profiles: { a: { default: true, targets: ["db"] }, b: { default: true, targets: ["db"] } },
      }),
    );
    expect(issueLines(e)).toEqual(['profiles: only one profile may set "default": true (got a, b)']);
  });

  it("rejects an unknown profile target", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: "." } }, profiles: { a: { targets: ["db", "ghost"] } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["profiles.a.targets[1]"]);
  });
});

describe("commands", () => {
  it("normalizes hooks to arrays and expands target overrides to subapp ids", () => {
    const { ws } = loadFixture({
      apps: { platform: { path: ".", subapps: { shell: {}, api: {} } }, db: { path: "." } },
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
      apps: { db: { path: "." } },
      commands: { seed: { script: "echo" }, watch: { kind: "service", script: "echo" } },
    });
    expect(cmd(ws, "seed").kind).toBe("task");
    expect(cmd(ws, "watch").kind).toBe("service");
    expect(cmd(ws, "seed").hooks).toEqual({ pre: [], post: [] });
    expect(cmd(ws, "seed").targetScripts).toEqual({});
  });

  it("appends the core app:* commands with per-target start/stop scripts", () => {
    const { ws } = loadFixture({
      apps: {
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

  it("lets a subapp entry beat an app-wide one whichever order they are written in", () => {
    const targetScripts = (targets: Record<string, string | null>) =>
      loadFixture({
        apps: { platform: { path: ".", subapps: { shell: {}, api: {} } } },
        commands: { build: { targets } },
      }).ws.commands[0]?.targetScripts;

    const expected = { "platform.shell": null, "platform.api": "pnpm build" };
    expect(targetScripts({ platform: "pnpm build", "platform.shell": null })).toEqual(expected);
    expect(targetScripts({ "platform.shell": null, platform: "pnpm build" })).toEqual(expected);
  });

  it("rejects a namespaced user command", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: "." } }, commands: { "git:pull": { script: "git pull" } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["commands.git:pull"]);
    expect(e.issues[0]?.message).toContain("must be bare");
  });

  it("rejects an unknown command target", () => {
    const e = configErrorFrom(() =>
      loadFixture({
        apps: { db: { path: "." } },
        commands: { test: { script: "x", targets: { ghost: null } } },
      }),
    );
    expect(issueLines(e)).toEqual([
      'commands.test.targets.ghost: unknown target "ghost" — expected an app name or "app.subapp"',
    ]);
  });
});

describe("indicators, plugins, limits, templates", () => {
  it("fills indicator defaults", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." } },
      indicators: {
        version: { cmd: "jq -r .version package.json", interval: 60_000, scope: "app" },
        port: { cmd: "echo 3000" },
      },
    });
    expect(ws.indicators).toEqual([
      { name: "version", cmd: "jq -r .version package.json", intervalMs: 60_000, scope: "app" },
      { name: "port", cmd: "echo 3000", intervalMs: 5_000, scope: "subapp" },
    ]);
  });

  it("rejects a namespaced indicator name", () => {
    const e = configErrorFrom(() =>
      loadFixture({ apps: { db: { path: "." } }, indicators: { "x@version": { cmd: "echo" } } }),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["indicators.x@version"]);
  });

  it("resolves local plugin specs and leaves package names alone", () => {
    const { dir, ws } = loadFixture({
      apps: { db: { path: "." } },
      plugins: ["./plugins/deploy.ts", "u8-plugin-thing"],
    });
    expect(ws.plugins).toEqual([
      { spec: "./plugins/deploy.ts", resolved: path.join(dir, "plugins/deploy.ts") },
      { spec: "u8-plugin-thing" },
    ]);
  });

  it("fills limits, templates and builtins from defaults", () => {
    const { ws } = loadFixture({ apps: { db: { path: "." } } });
    expect(ws.limits).toEqual(DEFAULT_LIMITS);
    expect(ws.templates).toEqual(DEFAULT_TEMPLATES);
    expect(ws.builtins).toEqual({ git: true, health: true });
  });

  it("maps the raw limit names onto the millisecond model", () => {
    const { ws } = loadFixture({
      apps: { db: { path: "." } },
      limits: { stopTimeout: 1_000, readyTimeout: 2_000, daemonIdle: 3_000, logKeep: 7 },
    });
    expect(ws.limits).toEqual({
      ...DEFAULT_LIMITS,
      stopTimeoutMs: 1_000,
      readyTimeoutMs: 2_000,
      daemonIdleMs: 3_000,
      logKeep: 7,
    });
    expect(sub(ws, "db").stopTimeoutMs).toBe(1_000);
    expect(sub(ws, "db").readyTimeoutMs).toBe(2_000);
  });

  it("keeps per-entry template overrides and defaults the workspace name to the directory", () => {
    const { dir, ws } = loadFixture({
      templates: { subapp: "{app@name}" },
      apps: { platform: { path: ".", template: "APP {app@name}", subapps: { shell: { template: "SUB" } } } },
    });
    expect(ws.name).toBe(path.basename(dir));
    expect(ws.templates).toEqual({ app: DEFAULT_TEMPLATES.app, subapp: "{app@name}" });
    expect(ws.apps[0]?.template).toBe("APP {app@name}");
    expect(sub(ws, "platform.shell").template).toBe("SUB");
  });

  it("gives an implicit subapp the app's template so the merged row renders it", () => {
    const { ws } = loadFixture({ apps: { db: { path: ".", template: "ROW {app@name}" } } });
    expect(ws.apps[0]?.template).toBe("ROW {app@name}");
    expect(sub(ws, "db").template).toBe("ROW {app@name}");
  });
});

describe("workspace identity", () => {
  it("reports the real config path, root dir and a stable id", () => {
    const { dir, ws } = loadFixture({ name: "demo", apps: { db: { path: "." } } });
    expect(ws.name).toBe("demo");
    expect(ws.configPath).toBe(path.join(dir, "u8.jsonc"));
    expect(ws.rootDir).toBe(dir);
    expect(ws.id).toMatch(/^[0-9a-f]{12}$/);
  });
});
