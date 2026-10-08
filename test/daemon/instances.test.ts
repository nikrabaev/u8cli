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

import { readInstanceRecords } from "../../src/config/index.js";
import type { InstanceRecord } from "../../src/config/types.js";
import type { RpcClient } from "../../src/ipc/index.js";
import type {
  InstanceAddParams,
  InstanceRemoveParams,
  ServiceState,
  Snapshot,
  SnapshotApp,
  SnapshotInstance,
  TaskResult,
} from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonLog,
  daemonPid,
  waitFor,
  waitForPidGone,
  type Workspace,
} from "./helpers.js";

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

async function add(client: RpcClient, params: InstanceAddParams): Promise<TaskResult> {
  return settled(client, (await client.request("instance.add", params)).runId);
}

async function remove(client: RpcClient, params: InstanceRemoveParams): Promise<TaskResult> {
  return settled(client, (await client.request("instance.remove", params)).runId);
}

async function up(client: RpcClient, instance: string): Promise<TaskResult> {
  return settled(client, (await client.request("service.start", { instance, wait: true })).runId);
}

function instanceOf(snap: Snapshot, name: string): SnapshotInstance {
  const found = snap.instances.find((i) => i.name === name);
  if (!found) throw new Error(`no instance "${name}"`);
  return found;
}

function serviceOf(snap: Snapshot, id: string): ServiceState {
  const found = snap.services.find((s) => s.targetId === id);
  if (!found) throw new Error(`no service state for "${id}"`);
  return found;
}

/** The instance as the state dir has it — the representation, not what it expands to. */
function recordOf(ws: Workspace, name: string): InstanceRecord {
  const found = readInstanceRecords(ws.paths.instancesFile).records.find((r) => r.name === name);
  if (!found) throw new Error(`no record for instance "${name}"`);
  return found;
}

function linesOf(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0) : [];
}

/**
 * One git repository holding two apps, `shell` talking to `auth`. Every step —
 * the repo's and each app's — leaves a line in a log outside the checkout, so a
 * test can say exactly which ones an add or a remove ran.
 */
async function platformFixture(): Promise<Fixture> {
  const ports = portBlock();
  const ws = createWorkspace((dir) => {
    const step = (who: string, log: string): string => `printf '${who} %s\\n' "$U8_INSTANCE" >> '${path.join(dir, log)}'`;
    const lifecycle = (who: string): object => ({ init: [step(who, "init.log")], teardown: [step(who, "teardown.log")] });
    return {
      instances: { ports: { from: ports.from, to: ports.to } },
      env: { WHO: "${instance.name}" },
      repos: {
        platform: {
          path: "platform",
          scripts: { start: SERVER },
          health: { http: "http://127.0.0.1:${ports.http}/", interval: 100 },
          instance: lifecycle("repo"),
          apps: {
            shell: {
              path: "shell",
              ports: { http: ports.base },
              env: { PORT: "${ports.http}", API_URL: "http://127.0.0.1:${platform.auth.ports.http}" },
              dependsOn: ["platform.auth"],
              instance: lifecycle("shell"),
            },
            auth: {
              path: "auth",
              ports: { http: ports.base + 1 },
              env: { PORT: "${ports.http}" },
              instance: lifecycle("auth"),
            },
          },
        },
      },
    };
  });
  initRepo(ws.file("platform"), { "shell/s.txt": "s", "auth/a.txt": "a" });
  const client = await connect(ws, { requestTimeoutMs: 30_000 });
  return { ws, client, ports };
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

describe("adding to an instance", () => {
  it("adds an app to a checkout the instance already has, and runs only that app's init", async () => {
    const { ws, client, ports } = await platformFixture();
    await create(client, { name: "p", targets: ["platform.shell"] });
    const root = ws.file(".u8/worktrees/p/platform");
    expect(recordOf(ws, "p").apps).toEqual(["platform.shell"]);
    expect(linesOf(ws.file("init.log"))).toEqual(["repo p", "shell p"]);
    // On its own, shell leans on base's auth.
    expect(appOf(await snapshot(client), "platform.shell@p").dependsOn).toEqual(["platform.auth"]);

    const result = await add(client, { name: "p", targets: ["platform.auth"] });
    expect(result.command).toBe("instance:init");
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["platform.auth@p"]);
    // The repo's own step ran when the instance got the repo, and shell's when
    // it got shell: neither is paid for again.
    expect(linesOf(ws.file("init.log"))).toEqual(["repo p", "shell p", "auth p"]);
    expect(git(ws.file("platform"), "worktree", "list").split("\n")).toHaveLength(2);

    const snap = await snapshot(client);
    const auth = appOf(snap, "platform.auth@p");
    const shell = appOf(snap, "platform.shell@p");
    expect(auth).toMatchObject({ baseId: "platform.auth", instance: "p", cwd: path.join(root, "auth") });
    expect(auth.ports["http"]).toBeGreaterThanOrEqual(ports.from);
    expect(auth.ports["http"]).not.toBe(shell.ports["http"]);
    expect(shell.dependsOn).toEqual(["platform.auth@p"]);
    expect(instanceOf(snap, "p")).toMatchObject({ initialized: true, appIds: ["platform.shell@p", "platform.auth@p"] });
    // Every app of its repos again, which is stored as "no list".
    expect(recordOf(ws, "p").apps).toEqual([]);

    expect((await up(client, "p")).ok).toBe(true);
    const authPort = auth.ports["http"] ?? 0;
    expect(await ask(authPort)).toBe(`p|${path.join(root, "auth")}|`);
    expect(await ask(shell.ports["http"] ?? 0)).toBe(`p|${path.join(root, "shell")}|http://127.0.0.1:${authPort}`);
  });

  it("creates a worktree for a repo it has no checkout of, and runs that repo's copy and init", async () => {
    const { ws, client, ports } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });

    const result = await add(client, { name: "fe", targets: ["api"] });
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["api@fe"]);

    const apiDir = ws.file(".u8/worktrees/fe/api");
    // The branch its other worktree is on, as create would have chosen.
    expect(git(apiDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fe");
    expect(fs.readFileSync(path.join(apiDir, "init.marker"), "utf8")).toBe("init fe\n");
    expect(fs.readFileSync(path.join(apiDir, ".env"), "utf8")).toBe("SECRET=1\n");

    const snap = await snapshot(client);
    expect(instanceOf(snap, "fe").appIds).toEqual(["api@fe", "web@fe"]);
    expect(instanceOf(snap, "fe").checkouts["api@fe"]).toEqual({
      path: apiDir,
      owned: true,
      branch: "fe",
      createdBranch: true,
      worktree: apiDir,
    });
    const port = appOf(snap, "api@fe").ports["http"] ?? 0;
    expect(port).toBeGreaterThanOrEqual(ports.from);
    expect(port).not.toBe(appOf(snap, "web@fe").ports["http"]);

    expect((await up(client, "fe")).ok).toBe(true);
    expect(await ask(port)).toBe(`fe|${apiDir}|`);
    // Base's api was neither started nor moved.
    await expect(ask(ports.base)).rejects.toThrow();
  });

  it("switches a partial instance's reference from base's port to its own", async () => {
    const { client, ports } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    await settled(client, (await client.request("service.start", { targets: ["api"], wait: true })).runId);
    await up(client, "fe");
    const webPort = appOf(await snapshot(client), "web@fe").ports["http"] ?? 0;
    expect((await ask(webPort)).endsWith(`|http://127.0.0.1:${ports.base}`)).toBe(true);

    await add(client, { name: "fe", targets: ["api"] });
    const snap = await snapshot(client);
    const apiPort = appOf(snap, "api@fe").ports["http"] ?? 0;
    expect(appOf(snap, "web@fe").dependsOn).toEqual(["api@fe"]);
    // The running process was not touched: it still talks to base, and is
    // reported as running on a definition the config no longer has.
    expect(serviceOf(snap, "web@fe")).toMatchObject({ status: "running", stale: true });
    expect((await ask(webPort)).endsWith(`|http://127.0.0.1:${ports.base}`)).toBe(true);

    const restarted = await settled(client, (await client.request("service.restart", { instance: "fe", wait: true })).runId);
    expect(restarted.ok).toBe(true);
    expect((await ask(webPort)).endsWith(`|http://127.0.0.1:${apiPort}`)).toBe(true);
    expect((await ask(apiPort)).startsWith("fe|")).toBe(true);
    expect(serviceOf(await snapshot(client), "web@fe").stale).toBe(false);
    // Base's own api is still base's.
    expect((await ask(ports.base)).startsWith("base|")).toBe(true);
  });

  it("puts a repo into the worktree its sibling in the same git repository already has", async () => {
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
    await create(client, { name: "m", targets: ["api"] });
    const root = ws.file(".u8/worktrees/m/mono");

    // Git would refuse a second worktree on the branch the first one is on.
    expect((await add(client, { name: "m", targets: ["web"] })).ok).toBe(true);
    const snap = await snapshot(client);
    expect(appOf(snap, "web@m").cwd).toBe(path.join(root, "services/web"));
    expect(instanceOf(snap, "m").checkouts["web@m"]).toEqual({
      path: path.join(root, "services/web"),
      owned: true,
      branch: "m",
      createdBranch: true,
      worktree: root,
    });
    expect(git(ws.file("mono"), "worktree", "list").split("\n")).toHaveLength(2);

    // Given up, it leaves the record — but the worktree is its sibling's too,
    // and stays for as long as that one runs from it.
    expect((await remove(client, { name: "m", targets: ["web"], prune: true, discard: true })).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "services/web/w.txt"))).toBe(true);
    const shrunk = instanceOf(await snapshot(client), "m");
    expect(shrunk.appIds).toEqual(["api@m"]);
    expect(Object.keys(shrunk.checkouts)).toEqual(["api@m"]);
    expect(recordOf(ws, "m").apps).toEqual([]);
    // And coming back, it finds its place in that worktree again.
    expect((await add(client, { name: "m", targets: ["web"] })).ok).toBe(true);
    expect(appOf(await snapshot(client), "web@m").cwd).toBe(path.join(root, "services/web"));
    expect(git(ws.file("mono"), "worktree", "list").split("\n")).toHaveLength(2);

    await settled(client, (await client.request("instance.destroy", { name: "m" })).runId);
    expect(fs.existsSync(root)).toBe(false);
    expect(git(ws.file("mono"), "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("keeps a worktree for as long as a checkout in use is inside it, however that checkout is recorded", async () => {
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
    await create(client, { name: "m", targets: ["api"] });
    const root = ws.file(".u8/worktrees/m/mono");

    // Its own worktree is not somebody else's to adopt: the repo is put there anyway.
    const adopting = await failure(client.request("instance.add", { name: "m", targets: ["web"], adopt: [root] }));
    expect(adopting.message).toContain('is inside a worktree instance "m" already has');
    const pointing = await failure(
      client.request("instance.add", { name: "m", targets: ["web"], paths: { web: path.join(root, "services/web") } }),
    );
    expect(pointing.message).toContain('is inside a worktree instance "m" already has');
    await add(client, { name: "m", targets: ["web"] });

    // A record that says otherwise all the same — written by hand, here — must
    // not be what gets a directory an app still runs from deleted.
    const pid = daemonPid(ws) ?? 0;
    await client.request("daemon.stop", {});
    expect(await waitForPidGone(pid)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(ws.paths.instancesFile, "utf8")) as { instances: InstanceRecord[] };
    const stored = doc.instances[0];
    if (stored) stored.repos["web"] = { path: path.join(root, "services/web"), owned: false };
    fs.writeFileSync(ws.paths.instancesFile, JSON.stringify(doc));

    const again = await connect(ws, { requestTimeoutMs: 30_000 });
    expect((await remove(again, { name: "m", targets: ["api"], prune: true, discard: true })).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "services/web/w.txt"))).toBe(true);
    const snap = await snapshot(again);
    expect(instanceOf(snap, "m").appIds).toEqual(["web@m"]);
    expect(appOf(snap, "web@m").cwd).toBe(path.join(root, "services/web"));
  });

  it("adopts a directory it is given for the new repo, and refuses one that is for nothing", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    const theirs = ws.file("elsewhere/api-fe");
    git(ws.file("api"), "worktree", "add", "-q", "-b", "theirs", theirs);

    // `web` already has its checkout; a worktree of it has nothing to be for.
    const stray = ws.file("elsewhere/web-2");
    git(ws.file("web"), "worktree", "add", "-q", "-b", "stray", stray);
    expect((await failure(client.request("instance.add", { name: "fe", targets: ["api"], adopt: [stray] }))).message).toContain(
      "it holds none of the repos",
    );
    expect(
      (await failure(client.request("instance.add", { name: "fe", targets: ["api"], adopt: [theirs], branch: "x" }))).message,
    ).toContain("a branch was chosen, but nothing being added");

    expect((await add(client, { name: "fe", targets: ["api"], adopt: [theirs] })).ok).toBe(true);
    const snap = await snapshot(client);
    expect(appOf(snap, "api@fe").cwd).toBe(theirs);
    expect(instanceOf(snap, "fe").checkouts["api@fe"]).toEqual({ path: theirs, owned: false });
    expect(fs.existsSync(ws.file(".u8/worktrees/fe/api"))).toBe(false);
  });

  it("leaves nothing behind when an add fails after its worktree was made", async () => {
    // One port in the whole range: `web` takes it, so `api` gets its worktree
    // and then finds there is no port left for it.
    const only = portBlock().from;
    const { ws, client } = await fixture(() => ({ instances: { ports: { from: only, to: only } } }));
    await create(client, { name: "fe", targets: ["web"] });
    const before = recordOf(ws, "fe");

    const err = await failure(client.request("instance.add", { name: "fe", targets: ["api"] }));
    expect(err.message).toContain("no free port left");
    expect(fs.existsSync(ws.file(".u8/worktrees/fe/api"))).toBe(false);
    expect(git(ws.file("api"), "worktree", "list").split("\n")).toHaveLength(1);
    // The branch it made for the worktree goes too, so a retry starts clean.
    expect(git(ws.file("api"), "branch", "--list", "fe")).toBe("");
    expect(recordOf(ws, "fe")).toEqual(before);
    expect(instanceOf(await snapshot(client), "fe").appIds).toEqual(["web@fe"]);

    // And when git itself refuses: `main` is checked out in the base checkout.
    const refused = await failure(client.request("instance.add", { name: "fe", targets: ["api"], branch: "main" }));
    expect(refused.message).toContain("could not create a worktree");
    expect(recordOf(ws, "fe")).toEqual(before);
  });

  it("marks the instance as not initialised when the added app's init fails", async () => {
    const { client } = await fixture((dir) => ({
      repos: {
        api: { path: "api", scripts: { start: SERVER } },
        web: { path: "web", scripts: { start: SERVER }, instance: { init: [`test -f '${path.join(dir, "allow-init")}'`] } },
      },
    }));
    await create(client, { name: "x", targets: ["api"] });
    expect(instanceOf(await snapshot(client), "x").initialized).toBe(true);

    const result = await add(client, { name: "x", targets: ["web"] });
    expect(result.ok).toBe(false);
    expect(result.targets[0]?.error).toContain("exited with code 1");
    // It is a member — the worktree and the record are real — but not ready.
    expect(instanceOf(await snapshot(client), "x")).toMatchObject({ initialized: false, appIds: ["api@x", "web@x"] });
  });

  it("refuses base, strangers, and apps the instance already has", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    const before = recordOf(ws, "fe");
    const refused = async (params: InstanceAddParams): Promise<string> =>
      (await failure(client.request("instance.add", params))).message;

    expect(await refused({ name: "base", targets: ["api"] })).toContain('"base" is the workspace itself');
    expect(await refused({ name: "nope", targets: ["api"] })).toBe('unknown instance "nope"');
    expect(await refused({ name: "fe", targets: ["web"] })).toBe('"web" is already part of instance "fe"');
    expect(await refused({ name: "fe", targets: ["ghost"] })).toContain('unknown target "ghost"');
    // Membership is written the way the config writes apps.
    expect(await refused({ name: "fe", targets: ["api@fe"] })).toContain('write the app the way the config does: "api"');
    expect(await refused({ name: "fe", targets: [] })).toContain('requires "targets"');
    expect(recordOf(ws, "fe")).toEqual(before);
  });
});

describe("removing from an instance", () => {
  it("stops the app, runs its teardown, frees its port and keeps its checkout", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "x", targets: ["api", "web"] });
    expect((await up(client, "x")).ok).toBe(true);
    expect(recordOf(ws, "x").apps).toEqual([]);

    const before = await snapshot(client);
    const apiPort = appOf(before, "api@x").ports["http"] ?? 0;
    const webPort = appOf(before, "web@x").ports["http"] ?? 0;
    const pid = serviceOf(before, "api@x").pid ?? 0;
    const webPid = serviceOf(before, "web@x").pid ?? 0;
    expect(await ask(apiPort)).toContain("x|");
    const apiDir = ws.file(".u8/worktrees/x/api");
    fs.writeFileSync(path.join(apiDir, "wip.txt"), "not committed\n");

    const result = await remove(client, { name: "x", targets: ["api"] });
    expect(result.command).toBe("instance:teardown");
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.targetId)).toEqual(["api@x"]);

    // Not merely "the daemon forgot it": the process is gone and the port is closed.
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(ask(apiPort)).rejects.toThrow();
    expect(fs.readFileSync(ws.file("teardown.log"), "utf8")).toBe("teardown x\n");

    const after = await snapshot(client);
    expect(instanceOf(after, "x").appIds).toEqual(["web@x"]);
    expect(after.repos.map((r) => r.name)).toEqual(["api", "web", "web@x"]);
    // No longer every app of its repos, so the list is spelled out.
    expect(recordOf(ws, "x").apps).toEqual(["web"]);
    expect(recordOf(ws, "x").ports).toEqual({ web: { http: webPort } });

    // Its neighbour was left running — and now leans on base's api, which the
    // process it was started as knows nothing about.
    expect(appOf(after, "web@x").dependsOn).toEqual(["api"]);
    expect(serviceOf(after, "web@x")).toMatchObject({ status: "running", stale: true, pid: webPid });

    // The checkout is still the instance's, with what was in it.
    expect(fs.readFileSync(path.join(apiDir, "wip.txt"), "utf8")).toBe("not committed\n");
    expect(instanceOf(after, "x").checkouts["api@x"]).toMatchObject({ path: apiDir, owned: true, branch: "x" });

    // And the port is handed out again.
    await create(client, { name: "y", targets: ["api"] });
    expect(appOf(await snapshot(client), "api@y").ports["http"]).toBe(apiPort);
  });

  it("brings a removed app back into the checkout it left", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "x", targets: ["api", "web"] });
    const apiDir = ws.file(".u8/worktrees/x/api");
    fs.writeFileSync(path.join(apiDir, "wip.txt"), "not committed\n");
    await remove(client, { name: "x", targets: ["api"] });
    fs.rmSync(path.join(apiDir, "init.marker"));

    const result = await add(client, { name: "x", targets: ["api"] });
    expect(result.ok).toBe(true);
    expect(git(ws.file("api"), "worktree", "list").split("\n")).toHaveLength(2);
    expect(fs.readFileSync(path.join(apiDir, "wip.txt"), "utf8")).toBe("not committed\n");
    // Its repo's teardown ran when it left, so its repo's init runs as it returns.
    expect(fs.readFileSync(path.join(apiDir, "init.marker"), "utf8")).toBe("init x\n");
    expect(recordOf(ws, "x").apps).toEqual([]);

    expect((await up(client, "x")).ok).toBe(true);
    expect(await ask(appOf(await snapshot(client), "api@x").ports["http"] ?? 0)).toBe(`x|${apiDir}|`);
  });

  it("runs only the leaving app's own steps while its repo still has another", async () => {
    const { ws, client } = await platformFixture();
    await create(client, { name: "p", targets: ["platform"] });
    await create(client, { name: "q", targets: ["platform"] });

    await remove(client, { name: "p", targets: ["platform.auth"] });
    expect(linesOf(ws.file("teardown.log"))).toEqual(["auth p"]);
    expect(recordOf(ws, "p").apps).toEqual(["platform.shell"]);
    // The worktree is shared with shell, which still runs from it.
    expect(fs.existsSync(ws.file(".u8/worktrees/p/platform/auth/a.txt"))).toBe(true);

    // A repo name means every app of it the instance runs — which here would be all it has.
    expect((await failure(client.request("instance.remove", { name: "q", targets: ["platform"] }))).message).toContain(
      "u8 instance destroy q",
    );
    expect(linesOf(ws.file("teardown.log"))).toEqual(["auth p"]);
  });

  it("refuses to remove the last app, and points at destroy", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "fe", targets: ["web"] });
    const before = recordOf(ws, "fe");
    const refused = async (params: InstanceRemoveParams): Promise<string> =>
      (await failure(client.request("instance.remove", params))).message;

    expect(await refused({ name: "fe", targets: ["web"] })).toBe(
      'removing "web" would leave instance "fe" with no apps — to be rid of the instance, destroy it: u8 instance destroy fe',
    );
    expect(await refused({ name: "base", targets: ["web"] })).toContain('"base" is the workspace itself');
    expect(await refused({ name: "fe", targets: ["api"] })).toBe('"api" is not part of instance "fe"');
    expect(await refused({ name: "fe", targets: ["web@fe"] })).toContain('write the app the way the config does: "web"');
    expect(await refused({ name: "fe", targets: ["web"], discard: true })).toContain("only applies to a checkout");

    expect(recordOf(ws, "fe")).toEqual(before);
    expect(fs.existsSync(ws.file("teardown.log"))).toBe(false);
    expect(instanceOf(await snapshot(client), "fe").appIds).toEqual(["web@fe"]);
  });

  it("keeps the app when its teardown fails, unless forced", async () => {
    const { client } = await fixture((dir) => ({
      repos: {
        api: {
          path: "api",
          scripts: { start: SERVER },
          instance: { teardown: [`test -f '${path.join(dir, "allow-teardown")}'`] },
        },
        web: { path: "web", scripts: { start: SERVER } },
      },
    }));
    await create(client, { name: "s" });

    const refused = await remove(client, { name: "s", targets: ["api"] });
    expect(refused.ok).toBe(false);
    expect(refused.targets[0]?.error).toContain("exited with code 1");
    expect(instanceOf(await snapshot(client), "s").appIds).toEqual(["api@s", "web@s"]);

    const forced = await remove(client, { name: "s", targets: ["api"], force: true });
    expect(forced.targets[0]?.state).toBe("failed");
    expect(instanceOf(await snapshot(client), "s").appIds).toEqual(["web@s"]);
  });

  it("gives up a worktree with --prune only when it is clean, unless told to discard", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "x", targets: ["api", "web"] });
    const apiDir = ws.file(".u8/worktrees/x/api");
    const webDir = ws.file(".u8/worktrees/x/web");
    await up(client, "x");
    const pid = serviceOf(await snapshot(client), "api@x").pid ?? 0;

    // Init left an untracked marker and a copied `.env` in api's worktree —
    // to git that is work nobody committed.
    const dirty = await failure(client.request("instance.remove", { name: "x", targets: ["api"], prune: true }));
    expect(dirty.message).toContain(`the worktree at ${apiDir} has uncommitted changes`);
    expect(dirty.message).toContain("nothing was stopped or removed");
    // Which is the whole of what happened: still a member, still running.
    expect(fs.existsSync(ws.file("teardown.log"))).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(instanceOf(await snapshot(client), "x").appIds).toEqual(["api@x", "web@x"]);

    const discarded = await remove(client, { name: "x", targets: ["api"], prune: true, discard: true });
    expect(discarded.ok).toBe(true);
    expect(fs.existsSync(apiDir)).toBe(false);
    expect(git(ws.file("api"), "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(ws.file("api"), "branch", "--list", "x")).toBe("");
    expect(Object.keys(instanceOf(await snapshot(client), "x").checkouts)).toEqual(["web@x"]);
    // Its one repo, and every app of it.
    expect(recordOf(ws, "x")).toMatchObject({ apps: [], repos: { web: { path: webDir } } });
    expect(Object.keys(recordOf(ws, "x").repos)).toEqual(["web"]);

    // A worktree nothing was left in goes without being asked twice.
    await create(client, { name: "y", targets: ["api", "web"] });
    expect((await remove(client, { name: "y", targets: ["web"], prune: true })).ok).toBe(true);
    expect(fs.existsSync(ws.file(".u8/worktrees/y/web"))).toBe(false);
    expect(git(ws.file("web"), "branch", "--list", "y")).toBe("");
    expect(fs.existsSync(ws.file(".u8/worktrees/y/api"))).toBe(true);
  });

  it("does not take a worktree git cannot read for a clean one", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "x", targets: ["api", "web"] });
    const webDir = ws.file(".u8/worktrees/x/web");
    // Still a directory with files in it; just no longer something git can vouch for.
    fs.writeFileSync(path.join(webDir, ".git"), "not a gitdir\n");

    const err = await failure(client.request("instance.remove", { name: "x", targets: ["web"], prune: true }));
    expect(err.message).toContain(`git could not say whether the worktree at ${webDir} has uncommitted changes`);
    expect(fs.existsSync(path.join(webDir, "README.md"))).toBe(true);
    expect(instanceOf(await snapshot(client), "x").appIds).toEqual(["api@x", "web@x"]);
  });

  it("keeps a worktree that turned dirty while its app was leaving", async () => {
    // Clean when the removal was accepted; its own teardown is what leaves a file behind.
    const { ws, client } = await fixture(() => ({
      repos: {
        api: { path: "api", scripts: { start: SERVER } },
        web: { path: "web", scripts: { start: SERVER }, instance: { teardown: ["printf late > left.txt"] } },
      },
    }));
    await create(client, { name: "x" });
    const webDir = ws.file(".u8/worktrees/x/web");

    const result = await remove(client, { name: "x", targets: ["web"], prune: true });
    expect(result.ok).toBe(false);
    expect(result.targets[0]?.error).toContain('"web" left instance "x", but its checkout is still held');
    // Git had the last word, and nothing was lost to it.
    expect(fs.readFileSync(path.join(webDir, "left.txt"), "utf8")).toBe("late");
    const after = instanceOf(await snapshot(client), "x");
    expect(after.appIds).toEqual(["api@x"]);
    expect(after.checkouts["web@x"]).toMatchObject({ path: webDir, owned: true });
  });

  it("gives up a checkout an earlier remove kept, when it is named again with --prune", async () => {
    const { ws, client } = await fixture();
    await create(client, { name: "z", targets: ["api", "web"] });
    const webDir = ws.file(".u8/worktrees/z/web");
    await remove(client, { name: "z", targets: ["web"] });
    expect(fs.existsSync(webDir)).toBe(true);

    expect((await failure(client.request("instance.remove", { name: "z", targets: ["web"] }))).message).toBe(
      '"web" is not part of instance "z" — only its checkout is still held, and giving that up takes --prune',
    );

    const result = await remove(client, { name: "z", targets: ["web"], prune: true });
    expect(result.ok).toBe(true);
    expect(result.targets).toEqual([]);
    expect(fs.existsSync(webDir)).toBe(false);
    expect(Object.keys(instanceOf(await snapshot(client), "z").checkouts)).toEqual(["api@z"]);
    expect(recordOf(ws, "z").apps).toEqual([]);
  });

  it("never touches an adopted checkout, pruned or not", async () => {
    const { ws, client } = await fixture();
    const theirs = ws.file("elsewhere/task");
    git(ws.file("api"), "worktree", "add", "-q", "-b", "task", theirs);
    fs.writeFileSync(path.join(theirs, "wip.txt"), "theirs\n");
    await create(client, { name: "task", adopt: [theirs] });
    await add(client, { name: "task", targets: ["web"] });

    // Dirty, and that is none of u8's business: it is only being forgotten.
    const result = await remove(client, { name: "task", targets: ["api"], prune: true });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(theirs, "wip.txt"), "utf8")).toBe("theirs\n");
    expect(git(ws.file("api"), "worktree", "list")).toContain(theirs);
    expect(git(ws.file("api"), "branch", "--list", "task")).toContain("task");
    expect(Object.keys(instanceOf(await snapshot(client), "task").checkouts)).toEqual(["web@task"]);
  });

  it("allows one membership change per instance at a time", async () => {
    const { ws, client } = await fixture((dir) => ({
      repos: {
        api: { path: "api", scripts: { start: SERVER } },
        web: {
          path: "web",
          scripts: { start: SERVER },
          instance: { init: [`while [ ! -f '${path.join(dir, "go")}' ]; do sleep 0.05; done`] },
        },
      },
    }));
    await create(client, { name: "x", targets: ["api"] });

    const { runId } = await client.request("instance.add", { name: "x", targets: ["web"] });
    const err = await failure(client.request("instance.remove", { name: "x", targets: ["api"] }));
    expect(err.message).toContain('instance "x" is still busy with an earlier init, add or remove');
    // Not ready while the new app's steps run, so nothing takes it for a copy that can be started.
    expect(instanceOf(await snapshot(client), "x").initialized).toBe(false);

    fs.writeFileSync(ws.file("go"), "");
    expect((await settled(client, runId)).ok).toBe(true);
    expect(instanceOf(await snapshot(client), "x").initialized).toBe(true);
    expect((await remove(client, { name: "x", targets: ["api"] })).ok).toBe(true);
    expect(instanceOf(await snapshot(client), "x").appIds).toEqual(["web@x"]);
  });

  it("takes no membership change while the instance's own init is still running", async () => {
    const { ws, client } = await fixture((dir) => ({
      repos: {
        api: {
          path: "api",
          scripts: { start: SERVER },
          instance: { init: [`while [ ! -f '${path.join(dir, "go")}' ]; do sleep 0.05; done`] },
        },
        web: { path: "web", scripts: { start: SERVER } },
      },
    }));
    // That run was started for api alone; an app arriving under it would be
    // vouched for by an init that never ran its steps.
    const { runId } = await client.request("instance.create", { name: "x", targets: ["api"] });
    const err = await failure(client.request("instance.add", { name: "x", targets: ["web"] }));
    expect(err.message).toContain('instance "x" is still busy with an earlier init, add or remove');
    expect(fs.existsSync(ws.file(".u8/worktrees/x/web"))).toBe(false);

    fs.writeFileSync(ws.file("go"), "");
    expect((await settled(client, runId)).ok).toBe(true);
    expect((await add(client, { name: "x", targets: ["web"] })).ok).toBe(true);
    expect(instanceOf(await snapshot(client), "x")).toMatchObject({ initialized: true, appIds: ["api@x", "web@x"] });
  });
});
