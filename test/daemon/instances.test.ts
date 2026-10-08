/**
 * Instances end to end: a real daemon, real git worktrees, real HTTP servers on
 * the ports they were allocated. The point of the feature is that two copies of
 * one app run side by side without knowing about each other, so that is what is
 * asserted — by asking each copy who it is over its own port.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RpcClient } from "../../src/ipc/index.js";
import type { Snapshot, SnapshotApp, TaskResult } from "../../src/ipc/protocol.js";
import { cleanup, cleanupStateHome, connect, createWorkspace, daemonLog, waitFor, type Workspace } from "./helpers.js";

afterEach(cleanup);
afterAll(cleanupStateHome);

/** Answers every request with the instance it runs in and the directory it runs from. */
const SERVER =
  "node -e \"require('http').createServer((q,s)=>s.end(process.env.WHO+'|'+process.cwd()+'|'+(process.env.API_URL||'')))" +
  ".listen(Number(process.env.PORT),'127.0.0.1')\"";

/** A block of ports no other test file is using, so parallel workers cannot collide. */
function portBlock(): { base: number; from: number; to: number } {
  const base = 30_000 + Math.floor(Math.random() * 2_000) * 10;
  return { base, from: base + 100, to: base + 140 };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=u8", "-c", "user.email=u8@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Turns a directory into a repository with one commit on `main`. */
function initRepo(dir: string, files: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries({ "README.md": "fixture\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

interface Fixture {
  ws: Workspace;
  client: RpcClient;
  ports: { base: number; from: number; to: number };
}

/** `web` talks to `api`; each is its own git repository. */
async function fixture(extra: (dir: string) => Record<string, unknown> = () => ({})): Promise<Fixture> {
  const ports = portBlock();
  const ws = createWorkspace((dir) => ({
    instances: { ports: { from: ports.from, to: ports.to } },
    env: { WHO: "${instance.name}" },
    repos: {
      api: {
        path: "api",
        ports: { http: ports.base },
        env: { PORT: "${ports.http}" },
        scripts: { start: SERVER },
        health: { http: "http://127.0.0.1:${ports.http}/", interval: 100 },
        instance: {
          copy: [".env"],
          init: ["printf 'init %s\\n' \"$U8_INSTANCE\" > init.marker"],
          teardown: [`printf 'teardown %s\\n' "$U8_INSTANCE" >> '${path.join(dir, "teardown.log")}'`],
        },
      },
      web: {
        path: "web",
        ports: { http: ports.base + 1 },
        env: { PORT: "${ports.http}", API_URL: "http://127.0.0.1:${api.ports.http}" },
        scripts: { start: SERVER },
        dependsOn: ["api"],
      },
    },
    ...extra(dir),
  }));
  initRepo(ws.file("api"));
  initRepo(ws.file("web"));
  // Untracked on purpose: this is what a worktree does not get from git.
  fs.writeFileSync(ws.file("api/.env"), "SECRET=1\n");
  const client = await connect(ws, { env: { U8_PRUNE_MS: "150" }, requestTimeoutMs: 30_000 });
  return { ws, client, ports };
}

async function snapshot(client: RpcClient): Promise<Snapshot> {
  return client.request("workspace.snapshot", {});
}

function appOf(snap: Snapshot, id: string): SnapshotApp {
  const found = snap.repos.flatMap((r) => r.apps).find((a) => a.id === id);
  if (!found) throw new Error(`no app "${id}" (have: ${snap.repos.flatMap((r) => r.apps.map((a) => a.id)).join(", ")})`);
  return found;
}

async function settled(client: RpcClient, runId: string): Promise<TaskResult> {
  return client.request("run.await", { runId });
}

async function create(client: RpcClient, params: Parameters<RpcClient["request"]>[1] & { name: string }): Promise<TaskResult> {
  const { runId } = await client.request("instance.create", params);
  return settled(client, runId);
}

async function ask(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  return res.text();
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the request to be refused");
    },
    (err: unknown) => err as Error,
  );
}

describe("creating an instance", () => {
  it("adds a worktree per repo, allocates ports, and runs init in the new checkout", async () => {
    const { ws, client, ports } = await fixture();

    const result = await create(client, { name: "feat-x", targets: ["api", "web"] });
    expect(result.command).toBe("instance:init");
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["api@feat-x", "web@feat-x"]);

    const apiDir = ws.file(".u8/worktrees/feat-x/api");
    expect(git(apiDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat-x");
    expect(fs.readFileSync(path.join(apiDir, "init.marker"), "utf8")).toBe("init feat-x\n");
    // The untracked file git would not have carried over.
    expect(fs.readFileSync(path.join(apiDir, ".env"), "utf8")).toBe("SECRET=1\n");

    const snap = await snapshot(client);
    const api = appOf(snap, "api@feat-x");
    const web = appOf(snap, "web@feat-x");
    expect(api).toMatchObject({ baseId: "api", instance: "feat-x", cwd: apiDir, repoName: "api@feat-x" });
    expect(api.ports["http"]).toBeGreaterThanOrEqual(ports.from);
    expect(api.ports["http"]).toBeLessThanOrEqual(ports.to);
    expect(web.ports["http"]).not.toBe(api.ports["http"]);
    expect(web.dependsOn).toEqual(["api@feat-x"]);

    const instance = snap.instances.find((i) => i.name === "feat-x");
    expect(instance).toMatchObject({ isBase: false, initialized: true, appIds: ["api@feat-x", "web@feat-x"] });
    expect(instance?.checkouts["api@feat-x"]).toEqual({
      path: apiDir,
      owned: true,
      branch: "feat-x",
      createdBranch: true,
      worktree: apiDir,
    });
    // Base is exactly what it was.
    expect(appOf(snap, "api")).toMatchObject({ instance: "base", ports: { http: ports.base } });
  });

  it("refuses a name that cannot be an instance, or that is taken", async () => {
    const { client } = await fixture();
    expect((await failure(client.request("instance.create", { name: "base" }))).message).toContain(
      "the instance the config itself describes",
    );
    expect((await failure(client.request("instance.create", { name: "a@b" }))).message).toContain(
      "invalid instance name",
    );
    await create(client, { name: "one", targets: ["api"] });
    expect((await failure(client.request("instance.create", { name: "one", targets: ["api"] }))).message).toBe(
      'instance "one" already exists',
    );
  });

  it("leaves nothing behind when a worktree cannot be created", async () => {
    const { ws, client } = await fixture();
    // `main` is checked out in the base checkout, so git refuses a second one.
    const err = await failure(client.request("instance.create", { name: "dup", targets: ["web", "api"], branch: "main" }));
    expect(err.message).toContain("could not create a worktree");
    expect(fs.existsSync(ws.file(".u8/worktrees/dup/web"))).toBe(false);
    expect(fs.existsSync(ws.file(".u8/worktrees/dup/api"))).toBe(false);
    expect((await snapshot(client)).instances.map((i) => i.name)).toEqual(["base"]);
    expect(git(ws.file("web"), "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("gives two instances different ports, and reuses none of base's", async () => {
    const { client, ports } = await fixture();
    await create(client, { name: "a", targets: ["api"] });
    await create(client, { name: "b", targets: ["api"] });
    const snap = await snapshot(client);
    const all = [appOf(snap, "api"), appOf(snap, "api@a"), appOf(snap, "api@b")].map((a) => a.ports["http"]);
    expect(new Set(all).size).toBe(3);
    expect(all[0]).toBe(ports.base);
  });

  it("shares one worktree between repos that live in the same git repository", async () => {
    const block = portBlock();
    const ws = createWorkspace({
      instances: { ports: { from: block.from, to: block.to } },
      repos: {
        api: { path: "mono/services/api", ports: { http: block.base }, scripts: { start: SERVER } },
        web: { path: "mono/services/web", ports: { http: block.base + 1 }, scripts: { start: SERVER } },
      },
    });
    initRepo(ws.file("mono"), { "services/api/a.txt": "a", "services/web/w.txt": "w" });
    const client = await connect(ws, { requestTimeoutMs: 30_000 });

    expect((await create(client, { name: "m" })).ok).toBe(true);
    const snap = await snapshot(client);
    const root = ws.file(".u8/worktrees/m/mono");
    expect(appOf(snap, "api@m").cwd).toBe(path.join(root, "services/api"));
    expect(appOf(snap, "web@m").cwd).toBe(path.join(root, "services/web"));
    expect(git(ws.file("mono"), "worktree", "list").split("\n")).toHaveLength(2);

    await settled(client, (await client.request("instance.destroy", { name: "m" })).runId);
    expect(fs.existsSync(root)).toBe(false);
    expect(git(ws.file("mono"), "worktree", "list").split("\n")).toHaveLength(1);
  });
});

describe("running instances side by side", () => {
  it("runs base and an instance at once, each on its own port from its own checkout", async () => {
    const { ws, client, ports } = await fixture();
    await create(client, { name: "feat-x", targets: ["api", "web"] });

    const base = await settled(client, (await client.request("service.start", { wait: true })).runId);
    const copy = await settled(client, (await client.request("service.start", { instance: "feat-x", wait: true })).runId);
    expect(base.ok).toBe(true);
    expect(copy.ok).toBe(true);
    expect(copy.targets.map((t) => t.targetId)).toEqual(["api@feat-x", "web@feat-x"]);

    const snap = await snapshot(client);
    const apiPort = appOf(snap, "api@feat-x").ports["http"] ?? 0;
    const webPort = appOf(snap, "web@feat-x").ports["http"] ?? 0;

    expect(await ask(ports.base)).toBe(`base|${ws.file("api")}|`);
    expect(await ask(apiPort)).toBe(`feat-x|${ws.file(".u8/worktrees/feat-x/api")}|`);
    // Each web was told where *its* api is.
    expect(await ask(ports.base + 1)).toBe(`base|${ws.file("web")}|http://127.0.0.1:${ports.base}`);
    expect(await ask(webPort)).toBe(`feat-x|${ws.file(".u8/worktrees/feat-x/web")}|http://127.0.0.1:${apiPort}`);
  });

  it("points a partial instance at base for the apps it has no copy of", async () => {
    const { client, ports } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    await settled(client, (await client.request("service.start", { targets: ["api"], wait: true })).runId);
    const started = await settled(client, (await client.request("service.start", { instance: "fe" })).runId);
    expect(started.targets.map((t) => [t.targetId, t.state])).toEqual([["web@fe", "ok"]]);

    const snap = await snapshot(client);
    expect(snap.instances.find((i) => i.name === "fe")?.appIds).toEqual(["web@fe"]);
    expect(appOf(snap, "web@fe").dependsOn).toEqual(["api"]);
    const webPort = appOf(snap, "web@fe").ports["http"] ?? 0;
    await waitFor(() => snap.services.length > 0, "snapshot");
    expect((await ask(webPort)).endsWith(`|http://127.0.0.1:${ports.base}`)).toBe(true);
  });

  it("keeps an instance's commands to itself", async () => {
    const { client } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    await settled(client, (await client.request("service.start", {})).runId);
    await settled(client, (await client.request("service.start", { instance: "fe" })).runId);

    // A bare name inside the instance is the instance's copy — never base's.
    const err = await failure(client.request("service.restart", { targets: ["api"], instance: "fe" }));
    expect(err.message).toBe(
      '"api" is not part of instance "fe", which uses base\'s — name it as "api@base" to act on that one',
    );

    const stopped = await settled(client, (await client.request("service.stop", { instance: "fe" })).runId);
    expect(stopped.targets.map((t) => t.targetId)).toEqual(["web@fe"]);
    const after = await snapshot(client);
    const status = (id: string): string | undefined => after.services.find((s) => s.targetId === id)?.status;
    expect(status("web@fe")).toBe("stopped");
    expect(status("web")).toBe("running");
    expect(status("api")).toBe("running");

    // Reaching across is possible, but only when it is spelled out.
    const explicit = await settled(
      client,
      (await client.request("service.stop", { targets: ["web@base"], instance: "fe" })).runId,
    );
    expect(explicit.targets.map((t) => t.targetId)).toEqual(["web"]);
  });

  it("holds a waiting start until the service answers its health check", async () => {
    const block = portBlock();
    const ws = createWorkspace({
      repos: {
        slow: {
          path: "slow",
          ports: { http: block.base },
          env: { PORT: "${ports.http}", WHO: "slow" },
          // Up at once, but not listening for a while: running, not yet ready.
          scripts: { start: `sleep 0.8; ${SERVER}` },
          health: { http: "http://127.0.0.1:${ports.http}/", interval: 100 },
        },
      },
    });
    fs.mkdirSync(ws.file("slow"));
    const client = await connect(ws);

    const eager = await settled(client, (await client.request("service.start", {})).runId);
    expect(eager.ok).toBe(true);
    await expect(ask(block.base)).rejects.toThrow();
    await settled(client, (await client.request("service.stop", {})).runId);

    const waited = await settled(client, (await client.request("service.start", { wait: true })).runId);
    expect(waited.ok).toBe(true);
    expect(await ask(block.base)).toContain("slow|");
  });
});

describe("destroying an instance", () => {
  it("stops its services, runs teardown, removes its worktrees and frees its ports", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "gone", targets: ["api"] });
    await settled(client, (await client.request("service.start", { instance: "gone", wait: true })).runId);
    const before = await snapshot(client);
    const port = appOf(before, "api@gone").ports["http"] ?? 0;
    const pid = before.services.find((s) => s.targetId === "api@gone")?.pid ?? 0;
    expect(await ask(port)).toContain("gone|");

    const result = await settled(client, (await client.request("instance.destroy", { name: "gone" })).runId);
    expect(result.command).toBe("instance:teardown");
    expect(result.ok).toBe(true);

    const dir = ws.file(".u8/worktrees/gone/api");
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(ws.file(".u8/worktrees/gone"))).toBe(false);
    expect(fs.readFileSync(ws.file("teardown.log"), "utf8")).toBe("teardown gone\n");
    // Nobody committed to the branch u8 made for it, so it goes too.
    expect(git(ws.file("api"), "branch", "--list", "gone")).toBe("");

    const after = await snapshot(client);
    expect(after.instances.map((i) => i.name)).toEqual(["base"]);
    expect(after.repos.map((r) => r.name)).toEqual(["api", "web"]);
    await expect(ask(port)).rejects.toThrow();
    // Not merely "the daemon forgot it": the process itself is gone.
    expect(() => process.kill(pid, 0)).toThrow();

    // And the port is handed out again.
    await create(client, { name: "next", targets: ["api"] });
    expect(appOf(await snapshot(client), "api@next").ports["http"]).toBe(port);
  });

  it("keeps a branch that has commits of its own, and one it did not create", async () => {
    const { ws, client } = await fixture();
    git(ws.file("web"), "branch", "existing");
    await create(client, { name: "work", targets: ["api"] });
    await create(client, { name: "reuse", targets: ["web"], branch: "existing" });

    const wt = ws.file(".u8/worktrees/work/api");
    fs.writeFileSync(path.join(wt, "change.txt"), "work in progress\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "work");

    await settled(client, (await client.request("instance.destroy", { name: "work" })).runId);
    await settled(client, (await client.request("instance.destroy", { name: "reuse" })).runId);

    // The only copy of somebody's commits is never thrown away…
    expect(git(ws.file("api"), "branch", "--list", "work")).toContain("work");
    expect(git(ws.file("api"), "log", "--oneline", "work", "-1")).toContain("work");
    // …and neither is a branch that was there before u8 was asked for it.
    expect(git(ws.file("web"), "branch", "--list", "existing")).toContain("existing");
  });

  it("keeps the instance when teardown fails, unless forced", async () => {
    const { ws, client } = await fixture((dir) => ({
      commands: {},
      repos: {
        api: {
          path: "api",
          scripts: { start: SERVER },
          instance: { teardown: [`test -f '${path.join(dir, "allow-teardown")}'`] },
        },
      },
    }));
    await create(client, { name: "stuck" });

    const refused = await settled(client, (await client.request("instance.destroy", { name: "stuck" })).runId);
    expect(refused.ok).toBe(false);
    expect(refused.targets[0]?.error).toContain("exited with code 1");
    expect((await snapshot(client)).instances.map((i) => i.name)).toEqual(["base", "stuck"]);
    expect(fs.existsSync(ws.file(".u8/worktrees/stuck/api"))).toBe(true);

    const forced = await settled(client, (await client.request("instance.destroy", { name: "stuck", force: true })).runId);
    expect(forced.targets[0]?.state).toBe("failed");
    expect((await snapshot(client)).instances.map((i) => i.name)).toEqual(["base"]);
    expect(fs.existsSync(ws.file(".u8/worktrees/stuck/api"))).toBe(false);
  });

  it("refuses to destroy base or an instance that does not exist", async () => {
    const { client } = await fixture();
    expect((await failure(client.request("instance.destroy", { name: "base" }))).message).toContain(
      "cannot be destroyed",
    );
    expect((await failure(client.request("instance.destroy", { name: "nope" }))).message).toBe(
      'unknown instance "nope"',
    );
  });
});

describe("adopting a checkout somebody else made", () => {
  it("uses an existing worktree as it is and never removes it", async () => {
    const { ws, client } = await fixture();
    const theirs = ws.file("elsewhere/task-1");
    git(ws.file("api"), "worktree", "add", "-q", "-b", "task-1", theirs);

    const result = await create(client, { name: "task-1", adopt: [theirs] });
    expect(result.targets.map((t) => t.targetId)).toEqual(["api@task-1"]);
    const snap = await snapshot(client);
    expect(appOf(snap, "api@task-1").cwd).toBe(theirs);
    expect(snap.instances.find((i) => i.name === "task-1")?.checkouts["api@task-1"]).toEqual({
      path: theirs,
      owned: false,
    });

    await settled(client, (await client.request("instance.destroy", { name: "task-1" })).runId);
    expect(fs.existsSync(path.join(theirs, "README.md"))).toBe(true);
    expect(git(ws.file("api"), "worktree", "list")).toContain(theirs);
  });

  it("refuses a directory that is not a worktree of the workspace", async () => {
    const { ws, client } = await fixture();
    initRepo(ws.file("stranger"));
    expect((await failure(client.request("instance.create", { name: "s", adopt: [ws.file("stranger")] }))).message).toContain(
      "is not a worktree of any repo in this workspace",
    );
    expect((await failure(client.request("instance.create", { name: "b", adopt: [ws.file("api")] }))).message).toContain(
      'it is the base checkout of "api"',
    );
  });

  it("stops and forgets an adopted instance once its checkout disappears", async () => {
    const { ws, client } = await fixture();
    const theirs = ws.file("elsewhere/agent");
    git(ws.file("api"), "worktree", "add", "-q", "-b", "agent", theirs);
    await create(client, { name: "agent", adopt: [theirs] });
    await settled(client, (await client.request("service.start", { instance: "agent", wait: true })).runId);
    const pid = (await snapshot(client)).services.find((s) => s.targetId === "api@agent")?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    // What a tool that owns the worktree does when its task ends.
    git(ws.file("api"), "worktree", "remove", "--force", theirs);

    let names: string[] = [];
    await waitFor(
      () => {
        void snapshot(client).then((s) => {
          names = s.instances.map((i) => i.name);
        });
        return names.length === 1;
      },
      "the abandoned instance to be pruned",
      10_000,
    );
    expect(names).toEqual(["base"]);
    expect(() => process.kill(pid, 0)).toThrow();
    // Teardown still ran — from the base checkout, since its own was gone.
    expect(fs.readFileSync(ws.file("teardown.log"), "utf8")).toBe("teardown agent\n");
    expect(daemonLog(ws)).toContain('instance "agent": every checkout is gone');
  });
});

describe("ports and config edits", () => {
  it("allocates a port to existing instances when the config gives an app a new one", async () => {
    const { ws, client, ports } = await fixture();
    await create(client, { name: "x", targets: ["api"] });
    const first = appOf(await snapshot(client), "api@x").ports;

    ws.rewrite({
      instances: { ports: { from: ports.from, to: ports.to } },
      repos: {
        api: { path: "api", ports: { http: ports.base, debug: ports.base + 5 }, scripts: { start: SERVER } },
        web: { path: "web", scripts: { start: SERVER } },
      },
    });
    await client.request("workspace.reload", {});

    let now: Record<string, number> = {};
    await waitFor(
      () => {
        void snapshot(client).then((s) => {
          now = appOf(s, "api@x").ports;
        });
        return (now["debug"] ?? 0) > 0;
      },
      "the new port to be allocated",
    );
    expect(now["http"]).toBe(first["http"]);
    expect(now["debug"]).not.toBe(ports.base + 5);
    expect(now["debug"]).toBeGreaterThanOrEqual(ports.from);
  });
});
