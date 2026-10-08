import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTANCES_FILE_VERSION,
  readInstanceRecords,
  serializeInstanceRecords,
} from "../../src/config/index.js";
import { BASE_INSTANCE, findCommand, qualify, splitQualified } from "../../src/config/types.js";
import { app, cleanupWorkspaces, instanceRecord, loadWithInstances, tmpWorkspace } from "./helpers.js";

afterEach(cleanupWorkspaces);

/** api ← auth-mfe, plus a shell nobody depends on: enough to tell own copies from base's. */
const CONFIG = {
  name: "demo",
  vars: { flag: "off" },
  repos: {
    api: {
      path: "./api",
      ports: { http: 3000 },
      env: { PORT: "${ports.http}", DB: "app${instance.suffix}", FLAG: "${vars.flag}" },
      health: { http: "http://localhost:${ports.http}/healthz" },
    },
    platform: {
      path: "./platform",
      apps: {
        shell: { path: "apps/shell", ports: { http: 3100 }, env: { PORT: "${ports.http}" } },
        "auth-mfe": {
          path: "apps/auth-mfe",
          ports: { http: 3101 },
          env: { PORT: "${ports.http}", API_URL: "http://localhost:${api.ports.http}" },
          dependsOn: ["api", "platform.shell"],
        },
      },
    },
  },
  commands: { test: { script: "echo shared", targets: { api: "echo api", "platform.shell": null } } },
};

describe("qualified names", () => {
  it("leaves base names bare and round-trips the rest", () => {
    expect(qualify("api", BASE_INSTANCE)).toBe("api");
    expect(qualify("platform.shell", "feat-x")).toBe("platform.shell@feat-x");
    expect(splitQualified("platform.shell@feat-x")).toEqual({ name: "platform.shell", instance: "feat-x" });
    expect(splitQualified("api")).toEqual({ name: "api", instance: BASE_INSTANCE });
  });
});

describe("instances", () => {
  it("is just base when there are no records", () => {
    const { ws } = loadWithInstances(CONFIG, () => []);
    expect(ws.instances).toEqual([
      {
        name: "base",
        isBase: true,
        createdAt: 0,
        repoNames: ["api", "platform"],
        appIds: ["api", "platform.shell", "platform.auth-mfe"],
        checkouts: {},
        initialized: true,
      },
    ]);
    expect(app(ws, "api")).toMatchObject({ baseId: "api", instance: "base", repoName: "api" });
  });

  it("builds a full copy from its own checkouts and its own ports", () => {
    const { dir, ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("feat-x", {
        repos: {
          api: { path: path.join(root, "wt/api"), owned: true, branch: "feat/x" },
          platform: { path: path.join(root, "wt/platform"), owned: false },
        },
        ports: { api: { http: 20000 }, "platform.shell": { http: 20001 }, "platform.auth-mfe": { http: 20002 } },
      }),
    ]);

    expect(ws.apps.map((a) => a.id)).toEqual([
      "api",
      "platform.shell",
      "platform.auth-mfe",
      "api@feat-x",
      "platform.shell@feat-x",
      "platform.auth-mfe@feat-x",
    ]);
    expect(ws.repos.map((r) => r.name)).toEqual(["api", "platform", "api@feat-x", "platform@feat-x"]);

    expect(app(ws, "api@feat-x")).toMatchObject({
      baseId: "api",
      instance: "feat-x",
      repoName: "api@feat-x",
      name: "api",
      cwd: path.join(dir, "wt/api"),
      ports: { http: 20000 },
      env: { PORT: "20000", DB: "app_feat_x", FLAG: "off" },
    });
    expect(app(ws, "api@feat-x").health?.http).toBe("http://localhost:20000/healthz");
    expect(app(ws, "platform.auth-mfe@feat-x")).toMatchObject({
      cwd: path.join(dir, "wt/platform/apps/auth-mfe"),
      env: { PORT: "20002", API_URL: "http://localhost:20000" },
      dependsOn: ["api@feat-x", "platform.shell@feat-x"],
    });

    // Base is untouched by the instance existing.
    expect(app(ws, "api")).toMatchObject({ ports: { http: 3000 }, env: { PORT: "3000", DB: "app", FLAG: "off" } });
    expect(app(ws, "platform.auth-mfe").dependsOn).toEqual(["api", "platform.shell"]);

    expect(ws.instances[1]).toEqual({
      name: "feat-x",
      isBase: false,
      createdAt: 1,
      repoNames: ["api@feat-x", "platform@feat-x"],
      appIds: ["api@feat-x", "platform.shell@feat-x", "platform.auth-mfe@feat-x"],
      checkouts: {
        "api@feat-x": { path: path.join(dir, "wt/api"), owned: true, branch: "feat/x" },
        "platform@feat-x": { path: path.join(dir, "wt/platform"), owned: false },
      },
      initialized: false,
    });
    const repo = ws.repos.find((r) => r.name === "platform@feat-x");
    expect(repo).toMatchObject({
      baseName: "platform",
      instance: "feat-x",
      path: path.join(dir, "wt/platform"),
      basePath: path.join(dir, "platform"),
    });
  });

  it("points a partial instance at base for everything it has no copy of", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("fe", {
        repos: { platform: { path: path.join(root, "wt/platform"), owned: true } },
        apps: ["platform.auth-mfe"],
        ports: { "platform.auth-mfe": { http: 20000 } },
      }),
    ]);

    expect(ws.instances[1]?.appIds).toEqual(["platform.auth-mfe@fe"]);
    expect(app(ws, "platform.auth-mfe@fe")).toMatchObject({
      // Its own port, but base's api: the instance has no api of its own.
      env: { PORT: "20000", API_URL: "http://localhost:3000" },
      dependsOn: ["api", "platform.shell"],
    });
    expect(ws.apps.some((a) => a.id === "platform.shell@fe")).toBe(false);
  });

  it("lets a record override vars above every level of the config", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("x", {
        repos: { api: { path: path.join(root, "wt/api"), owned: true } },
        ports: { api: { http: 20000 } },
        vars: { flag: "on" },
      }),
    ]);
    expect(app(ws, "api@x").env["FLAG"]).toBe("on");
    expect(app(ws, "api").env["FLAG"]).toBe("off");
  });

  it("resolves instance, repo and base paths for a copy", () => {
    const { dir, ws } = loadWithInstances(
      {
        repos: {
          api: {
            path: "./api",
            env: { I: "${instance.name}|${instance.slug}|${instance.suffix}", P: "${repo.path}|${base.path}", ID: "${app.id}" },
          },
        },
      },
      (root) => [instanceRecord("Feat-X.1".replace(".", "-"), { repos: { api: { path: path.join(root, "wt"), owned: true } } })],
    );
    expect(app(ws, "api@Feat-X-1").env).toEqual({
      I: "Feat-X-1|feat_x_1|_feat_x_1",
      P: `${path.join(dir, "wt")}|${path.join(dir, "api")}`,
      ID: "api@Feat-X-1",
    });
  });

  it("gives an instance's copy the command entry written for the app", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("x", {
        repos: {
          api: { path: path.join(root, "wt/api"), owned: true },
          platform: { path: path.join(root, "wt/platform"), owned: true },
        },
        ports: { api: { http: 1 }, "platform.shell": { http: 2 }, "platform.auth-mfe": { http: 3 } },
      }),
    ]);
    expect(findCommand(ws, "test")?.targetScripts).toEqual({
      api: "echo api",
      "platform.shell": null,
      "api@x": "echo api",
      "platform.shell@x": null,
    });
    expect(Object.keys(findCommand(ws, "app:start")?.targetScripts ?? {})).toContain("platform.auth-mfe@x");
  });

  it("warns about a port nobody allocated instead of reusing base's", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("x", { repos: { api: { path: path.join(root, "wt/api"), owned: true } } }),
    ]);
    expect(app(ws, "api@x").ports).toEqual({ http: 0 });
    expect(ws.warnings).toContain('instance "x": no port allocated yet for "http" of api');
  });

  it("degrades a stale record to warnings rather than failing the load", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("old", {
        repos: {
          gone: { path: path.join(root, "wt/gone"), owned: true },
          api: { path: path.join(root, "wt/api"), owned: true },
        },
        apps: ["api", "gone", "platform.shell"],
        ports: { api: { http: 20000 } },
      }),
    ]);
    expect(ws.instances[1]?.appIds).toEqual(["api@old"]);
    expect(ws.warnings).toEqual(
      expect.arrayContaining([
        'instance "old": repo "gone" is no longer in the config and is ignored',
        'instance "old": app "gone" is not in the config or its repo has no checkout',
        'instance "old": app "platform.shell" is not in the config or its repo has no checkout',
      ]),
    );
  });

  it("skips a record whose name cannot be an instance", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("base", { repos: { api: { path: path.join(root, "a"), owned: true } } }),
      instanceRecord("a@b", { repos: { api: { path: path.join(root, "b"), owned: true } } }),
      instanceRecord("ok", { repos: { api: { path: path.join(root, "c"), owned: true } }, ports: { api: { http: 9 } } }),
      instanceRecord("ok", { createdAt: 2, repos: { api: { path: path.join(root, "d"), owned: true } } }),
    ]);
    expect(ws.instances.map((i) => i.name)).toEqual(["base", "ok"]);
    expect(app(ws, "api@ok").cwd).toMatch(/\/c$/);
    expect(ws.warnings).toEqual(
      expect.arrayContaining([
        'instance "base": "base" is the name of the instance the config itself describes',
        'instance "a@b": invalid instance name: use letters, digits, "_" or "-", starting with a letter or digit',
        'instance "ok": listed twice; the later one is ignored',
      ]),
    );
  });

  it("lists instances in creation order whatever order the file has them in", () => {
    const { ws } = loadWithInstances(CONFIG, (root) => [
      instanceRecord("second", { createdAt: 20, repos: { api: { path: path.join(root, "2"), owned: true } }, ports: { api: { http: 2 } } }),
      instanceRecord("first", { createdAt: 10, repos: { api: { path: path.join(root, "1"), owned: true } }, ports: { api: { http: 1 } } }),
    ]);
    expect(ws.instances.map((i) => i.name)).toEqual(["base", "first", "second"]);
  });
});

describe("instance records on disk", () => {
  it("round-trips through the file format", () => {
    const dir = tmpWorkspace({});
    const file = path.join(dir, "instances.json");
    const records = [
      instanceRecord("x", {
        createdAt: 42,
        repos: { api: { path: "/abs/api", owned: true, branch: "feat/x" }, web: { path: "/abs/web", owned: false } },
        apps: ["api"],
        ports: { api: { http: 20000 } },
        vars: { flag: "on" },
      }),
    ];
    fs.writeFileSync(file, serializeInstanceRecords(records));
    expect(readInstanceRecords(file)).toEqual({ records });
  });

  it("treats a missing file as no instances", () => {
    expect(readInstanceRecords("/nonexistent/u8/instances.json")).toEqual({ records: [] });
  });

  it("ignores a broken file with a reason instead of throwing", () => {
    const dir = tmpWorkspace({ "bad.json": "{ nope", "old.json": JSON.stringify({ version: 0, instances: [] }) });
    expect(readInstanceRecords(path.join(dir, "bad.json")).problem).toContain("not valid JSON");
    expect(readInstanceRecords(path.join(dir, "old.json")).problem).toContain(`expected ${INSTANCES_FILE_VERSION}`);
  });

  it("keeps the good entries and counts the malformed ones", () => {
    const dir = tmpWorkspace({
      "instances.json": JSON.stringify({
        version: INSTANCES_FILE_VERSION,
        instances: [
          { name: "ok", createdAt: 1, repos: { api: { path: "/abs", owned: true } } },
          { name: "relative", repos: { api: { path: "not/absolute", owned: true } } },
          "garbage",
        ],
      }),
    });
    const read = readInstanceRecords(path.join(dir, "instances.json"));
    expect(read.records.map((r) => r.name)).toEqual(["ok"]);
    expect(read.records[0]).toMatchObject({ apps: [], ports: {}, vars: {} });
    expect(read.problem).toContain("2 malformed instance entries were ignored");
  });
});
