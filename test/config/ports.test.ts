import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../../src/config/index.js";
import { app, cleanupWorkspaces, configErrorFrom, issueLines, loadFixture, writeConfig } from "./helpers.js";

afterEach(cleanupWorkspaces);

describe("ports", () => {
  it("gives base exactly the declared numbers", () => {
    const { ws } = loadFixture({
      repos: {
        api: { path: ".", ports: { http: 3000, debug: 9229 } },
        platform: { path: ".", apps: { shell: { ports: { http: 3100 } }, docs: {} } },
      },
    });
    expect(app(ws, "api").ports).toEqual({ http: 3000, debug: 9229 });
    expect(app(ws, "platform.shell").ports).toEqual({ http: 3100 });
    expect(app(ws, "platform.docs").ports).toEqual({});
  });

  it("rejects ports on a repo that has several apps to give them to", () => {
    const err = configErrorFrom(() =>
      loadFixture({ repos: { platform: { path: ".", ports: { http: 3100 }, apps: { shell: {}, docs: {} } } } }),
    );
    expect(issueLines(err)).toEqual([
      "repos.platform.ports: a port belongs to one process, so it cannot be a default for several apps: " +
        "declare it on the app that listens on it (repos.platform.apps.<app>.ports)",
    ]);
  });

  it("rejects a port that is not a port", () => {
    const err = configErrorFrom(() => loadFixture({ repos: { api: { path: ".", ports: { http: 70000 } } } }));
    expect(issueLines(err)).toEqual(["repos.api.ports.http: a port is between 1 and 65535"]);
  });

  it("warns when two base apps declare the same port", () => {
    const { ws } = loadFixture({
      repos: { api: { path: ".", ports: { http: 3000 } }, web: { path: ".", ports: { dev: 3000 } } },
    });
    expect(ws.warnings).toContain('port 3000 is declared by both api ("http") and web ("dev")');
  });
});

describe("references", () => {
  it("resolves an app's own port in env and in its health URL", () => {
    const { ws } = loadFixture({
      repos: {
        api: {
          path: ".",
          ports: { http: 3000 },
          env: { PORT: "${ports.http}" },
          health: { http: "http://localhost:${ports.http}/healthz" },
        },
      },
    });
    expect(app(ws, "api").env).toEqual({ PORT: "3000" });
    expect(app(ws, "api").health?.http).toBe("http://localhost:3000/healthz");
  });

  it("resolves another app's port, including one declared later in the document", () => {
    const { ws } = loadFixture({
      repos: {
        web: { path: ".", env: { API_URL: "http://localhost:${api.ports.http}", SHELL_PORT: "${platform.shell.ports.http}" } },
        api: { path: ".", ports: { http: 3000 } },
        platform: { path: ".", apps: { shell: { ports: { http: 3100 } } } },
      },
    });
    expect(app(ws, "web").env).toEqual({ API_URL: "http://localhost:3000", SHELL_PORT: "3100" });
  });

  it("resolves a workspace-level value separately for each app that inherits it", () => {
    const { ws } = loadFixture({
      env: { PORT: "${ports.http}", WHO: "${app.id}" },
      repos: { api: { path: ".", ports: { http: 3000 } }, web: { path: ".", ports: { http: 3001 } } },
    });
    expect(app(ws, "api").env).toEqual({ PORT: "3000", WHO: "api" });
    expect(app(ws, "web").env).toEqual({ PORT: "3001", WHO: "web" });
  });

  it("merges vars workspace → repo → app and reads them with ${vars.x}", () => {
    const { ws } = loadFixture({
      vars: { region: "eu", tier: "dev" },
      repos: {
        platform: {
          path: ".",
          vars: { tier: "repo" },
          env: { WHERE: "${vars.region}/${vars.tier}" },
          apps: { shell: {}, docs: { vars: { tier: "app" } } },
        },
      },
    });
    expect(app(ws, "platform.shell").env).toEqual({ WHERE: "eu/repo" });
    expect(app(ws, "platform.docs").env).toEqual({ WHERE: "eu/app" });
  });

  it("resolves the built-in scopes for the base instance", () => {
    const dir = writeConfig(
      {
        name: "demo",
        repos: {
          platform: {
            path: "./platform",
            apps: {
              shell: {
                path: "apps/shell",
                env: {
                  I: "${instance.name}|${instance.slug}|${instance.suffix}|",
                  W: "${workspace.name}|${workspace.root}",
                  R: "${repo.name}|${repo.path}|${base.path}",
                  A: "${app.id}|${app.name}|${app.path}",
                },
              },
            },
          },
        },
      },
      { "platform/apps/shell/.keep": "" },
    );
    const repoPath = path.join(dir, "platform");
    expect(app(loadWorkspace(dir), "platform.shell").env).toEqual({
      I: "base|base||",
      W: `demo|${dir}`,
      R: `platform|${repoPath}|${repoPath}`,
      A: `platform.shell|shell|${path.join(repoPath, "apps/shell")}`,
    });
  });

  it("leaves scripts alone: a shell reads its values from the environment", () => {
    const { ws } = loadFixture({
      repos: { api: { path: ".", ports: { http: 3000 }, scripts: { start: "serve --port ${PORT:-${ports.http}}" } } },
    });
    expect(app(ws, "api").scripts["start"]).toBe("serve --port ${PORT:-${ports.http}}");
  });

  it("keeps a literal ${ when it is escaped", () => {
    const { ws } = loadFixture({ repos: { api: { path: ".", env: { TEMPLATE: "$${name} and $HOME" } } } });
    expect(app(ws, "api").env).toEqual({ TEMPLATE: "${name} and $HOME" });
  });

  it("reports a bad reference at the place it was written, once", () => {
    const err = configErrorFrom(() =>
      loadFixture({
        env: { HOME_DIR: "${HOME}" },
        repos: {
          platform: {
            path: ".",
            env: { API: "${api.ports.grpc}" },
            apps: { shell: { env: { PORT: "${ports.http}" } }, docs: {} },
          },
          api: { path: ".", ports: { http: 3000 }, env: { V: "${vars.missing}", X: "${nope.ports.http}" } },
        },
      }),
    );
    const lines = issueLines(err);
    expect(lines.filter((l) => l.startsWith("env.HOME_DIR:"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("env.HOME_DIR:"))).toContain("not shell-expanded");
    expect(lines).toContain('repos.platform.env.API: ${api.ports.grpc}: "api" declares no port "grpc" (it has "http")');
    expect(lines).toContain(
      'repos.platform.apps.shell.env.PORT: ${ports.http}: "platform.shell" declares no port "http" — add it under "ports"',
    );
    expect(lines).toContain('repos.api.env.V: ${vars.missing}: no var "missing" is declared under "vars"');
    expect(lines).toContain(
      'repos.api.env.X: ${nope.ports.http}: unknown target "nope" — expected a repo name or "repo.app"',
    );
  });

  it("asks for an app when a port reference names a repo with several", () => {
    const err = configErrorFrom(() =>
      loadFixture({
        repos: {
          web: { path: ".", env: { P: "${platform.ports.http}" } },
          platform: { path: ".", apps: { shell: { ports: { http: 1 } }, docs: { ports: { http: 2 } } } },
        },
      }),
    );
    expect(issueLines(err)).toEqual([
      'repos.web.env.P: ${platform.ports.http}: "platform" has several apps — name one: platform.shell, platform.docs',
    ]);
  });

  it("reports a bad reference in a health URL under health.http", () => {
    const err = configErrorFrom(() =>
      loadFixture({ repos: { api: { path: ".", health: { http: "http://localhost:${ports.http}" } } } }),
    );
    expect(issueLines(err)[0]).toMatch(/^repos\.api\.health\.http: /);
  });
});
