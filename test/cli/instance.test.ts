/**
 * Instances from the command line — and, above all, from *inside a worktree*.
 *
 * The feature exists so that something working in a worktree (a person, or a
 * tool that cannot watch a dashboard) can type plain `u8` commands there and
 * have them mean "my copy". So most of these run with `cwd` set to a worktree
 * and assert on two things at once: that the command acted on that instance,
 * and that base was left exactly as it was.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { InstanceListJson, PortsJson } from "../../src/cli/instance.js";
import type { StatusJson } from "../../src/cli/status.js";
import { cleanup, cleanupStateHome, cli, createWorkspace, type Workspace } from "./helpers.js";

afterEach(cleanup);
afterAll(cleanupStateHome);

/** Answers every request with the instance it runs in. */
const SERVER =
  "node -e \"require('http').createServer((q,s)=>s.end(process.env.WHO))" +
  ".listen(Number(process.env.PORT),'127.0.0.1')\"";

function portBlock(): { base: number; from: number; to: number } {
  const base = 34_000 + Math.floor(Math.random() * 2_000) * 10;
  return { base, from: base + 100, to: base + 140 };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=u8", "-c", "user.email=u8@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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
  ports: { base: number; from: number; to: number };
}

/** `web` depends on `api`; each is a git repository of its own. */
function fixture(overrides: (ports: Fixture["ports"]) => Record<string, unknown> = () => ({})): Fixture {
  const ports = portBlock();
  const ws = createWorkspace({
    name: "fixture",
    instances: { ports: { from: ports.from, to: ports.to } },
    env: { WHO: "${instance.name}" },
    repos: {
      api: {
        path: "api",
        ports: { http: ports.base },
        env: { PORT: "${ports.http}" },
        scripts: { start: SERVER },
        health: { http: "http://127.0.0.1:${ports.http}/", interval: 100 },
        instance: { init: ["printf done > init.marker"] },
      },
      web: {
        path: "web",
        ports: { http: ports.base + 1 },
        env: { PORT: "${ports.http}", API_URL: "http://127.0.0.1:${api.ports.http}" },
        scripts: { start: SERVER },
        dependsOn: ["api"],
      },
    },
    ...overrides(ports),
  });
  initRepo(ws.file("api"));
  initRepo(ws.file("web"));
  return { ws, ports };
}

async function ask(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

async function statusJson(cwd: string, ...extra: string[]): Promise<StatusJson> {
  const result = await cli([...extra, "status", "--json"], { cwd });
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as StatusJson;
}

async function portsJson(cwd: string, ...extra: string[]): Promise<PortsJson> {
  const result = await cli([...extra, "ports", "--json"], { cwd });
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as PortsJson;
}

describe("u8 instance", () => {
  it("creates an instance, lists it, and destroys it", async () => {
    const { ws, ports } = fixture();

    const created = await cli(["instance", "create", "feat-x", "api"], { cwd: ws.dir });
    expect(created.code, created.err).toBe(0);
    expect(created.out).toContain("instance:init: 1 ok");
    // The address a caller needs is printed, not left to be guessed.
    expect(created.out).toMatch(/api@feat-x\s+http\s+http:\/\/localhost:\d+/);
    expect(fs.readFileSync(ws.file(".u8/worktrees/feat-x/api/init.marker"), "utf8")).toBe("done");

    const listed = await cli(["instance", "list", "--json"], { cwd: ws.dir });
    const { instances } = JSON.parse(listed.out) as InstanceListJson;
    expect(instances.map((i) => i.name)).toEqual(["base", "feat-x"]);
    const mine = instances[1];
    expect(mine).toMatchObject({ isBase: false, initialized: true, running: 0 });
    expect(mine?.apps[0]?.id).toBe("api@feat-x");
    expect(mine?.apps[0]?.ports["http"]).toBeGreaterThanOrEqual(ports.from);
    expect(mine?.checkouts["api@feat-x"]).toEqual({
      path: ws.file(".u8/worktrees/feat-x/api"),
      owned: true,
      branch: "feat-x",
    });

    const table = await cli(["instance", "list"], { cwd: ws.dir });
    expect(table.out).toContain("feat-x");
    expect(table.out).toContain("0/1 running");

    const destroyed = await cli(["instance", "destroy", "feat-x"], { cwd: ws.dir });
    expect(destroyed.code, destroyed.err).toBe(0);
    expect(destroyed.out).toContain("instance feat-x destroyed");
    expect(fs.existsSync(ws.file(".u8/worktrees/feat-x"))).toBe(false);
  });

  it("explains a bad --path or --set instead of passing it on", async () => {
    const { ws } = fixture();
    const bad = await cli(["instance", "create", "x", "--set", "novalue"], { cwd: ws.dir });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('--set expects name=value, got "novalue"');
  });
});

describe("working inside an instance's worktree", () => {
  it("scopes every command to that instance and leaves base alone", async () => {
    const { ws, ports } = fixture();
    expect((await cli(["instance", "create", "feat-x", "api", "web"], { cwd: ws.dir })).code).toBe(0);
    const here = ws.file(".u8/worktrees/feat-x/api");

    // No flag anywhere below: the directory is what says which instance.
    const before = await statusJson(here);
    expect(before.instance).toMatchObject({ name: "feat-x", isBase: false, initialized: true });
    expect(before.repos.map((r) => r.name)).toEqual(["api@feat-x", "web@feat-x"]);
    expect(before.repos.flatMap((r) => r.apps.map((a) => a.id))).toEqual(["api@feat-x", "web@feat-x"]);

    const started = await cli(["start", "--wait"], { cwd: here });
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("api@feat-x");
    expect(started.out).not.toMatch(/^[✓✗·] api /m);

    const mine = await portsJson(here);
    expect(mine.instance).toBe("feat-x");
    const apiPort = mine.apps.find((a) => a.id === "api@feat-x")?.ports["http"] ?? 0;
    expect(await ask(apiPort)).toBe("feat-x");

    // Base never moved: nothing of it runs, and its port is still free.
    const base = await statusJson(ws.dir);
    expect(base.instance.name).toBe("base");
    expect(base.repos.flatMap((r) => r.apps.map((a) => [a.id, a.status]))).toEqual([
      ["api", "stopped"],
      ["web", "stopped"],
    ]);
    await expect(ask(ports.base)).rejects.toThrow();

    const text = await cli(["status"], { cwd: here });
    expect(text.out).toContain("fixture · instance feat-x · 2/2 running");

    const stopped = await cli(["stop", "--all"], { cwd: here });
    expect(stopped.code, stopped.err).toBe(0);
    expect((await statusJson(here)).instance.running).toBe(0);
  });

  it("runs a command with the instance's environment through u8 exec", async () => {
    const { ws } = fixture();
    await cli(["instance", "create", "feat-x", "api", "web"], { cwd: ws.dir });
    const here = ws.file(".u8/worktrees/feat-x/web");
    const mine = await portsJson(here);
    const port = (id: string): number => mine.apps.find((a) => a.id === id)?.ports["http"] ?? 0;

    // The harness injects an empty env by default; the command still has to be found.
    const env = { PATH: process.env.PATH ?? "" };
    const ran = await cli(
      ["exec", "web", "--", "node", "-e", "console.log([process.env.PORT, process.env.API_URL, process.env.WHO, process.cwd()].join(' '))"],
      { cwd: here, env },
    );
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out.trim()).toBe(`${port("web@feat-x")} http://127.0.0.1:${port("api@feat-x")} feat-x ${here}`);

    // The exit code is the command's, so a failing test suite fails the call.
    const failed = await cli(["exec", "web", "--", "node", "-e", "process.exit(7)"], { cwd: here, env });
    expect(failed.code).toBe(7);
    const missing = await cli(["exec", "web", "--", "no-such-command-u8"], { cwd: here, env });
    expect(missing.code).toBe(127);
    expect(missing.err).toContain("command not found: no-such-command-u8");

    const printed = await cli(["env", "web"], { cwd: here });
    expect(printed.out.split("\n")).toContain(`PORT=${port("web@feat-x")}`);
    expect(printed.out.split("\n")).toContain("WHO=feat-x");
  });

  it("refuses to reach into base for an app the instance has no copy of", async () => {
    const { ws } = fixture();
    await cli(["instance", "create", "fe", "web"], { cwd: ws.dir });
    const here = ws.file(".u8/worktrees/fe/web");

    const refused = await cli(["restart", "api"], { cwd: here });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('"api" is not part of instance "fe", which uses base\'s');
    expect(refused.err).toContain("api@base");

    // The partial instance starts, and says what it is leaning on.
    const started = await cli(["start"], { cwd: here });
    expect(started.code, started.err).toBe(0);
    expect(started.err).toContain('instance "fe" uses api from another instance, and it is not running');
    expect(started.err).toContain("u8 start api@base");
  });

  it("destroys the instance this directory belongs to when none is named", async () => {
    const { ws } = fixture();
    await cli(["instance", "create", "mine", "api"], { cwd: ws.dir });
    // From the workspace root there is no "this instance" to mean.
    const vague = await cli(["instance", "destroy"], { cwd: ws.dir });
    expect(vague.code).not.toBe(0);
    expect(vague.err).toContain("needs an instance name");

    const done = await cli(["instance", "destroy"], { cwd: ws.file(".u8/worktrees/mine/api") });
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain("instance mine destroyed");
  });
});

describe("u8 up", () => {
  it("turns a worktree another tool made into a running instance, in one step", async () => {
    const { ws, ports } = fixture();
    const theirs = ws.file("api/.claude/worktrees/fix-login");
    git(ws.file("api"), "worktree", "add", "-q", "-b", "fix-login", theirs);

    // Before `up` the directory is neither base nor an instance.
    const reading = await cli(["status"], { cwd: theirs });
    expect(reading.code).toBe(0);
    expect(reading.err).toContain("this worktree has no instance of its own");
    const refused = await cli(["start"], { cwd: theirs });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("would act on the base checkouts");
    expect(refused.err).toContain("u8 up");
    await expect(ask(ports.base)).rejects.toThrow();

    const up = await cli(["up"], { cwd: theirs });
    expect(up.code, up.err).toBe(0);
    expect(up.err).toContain('creating instance "fix-login"');
    const address = /api@fix-login\s+http\s+(http:\/\/localhost:(\d+))/.exec(up.out);
    expect(address, up.out).not.toBeNull();
    // `up` returned, so it answers — no polling, no sleep.
    expect(await ask(Number(address?.[2]))).toBe("fix-login");
    expect(fs.readFileSync(path.join(theirs, "init.marker"), "utf8")).toBe("done");

    const status = await statusJson(theirs);
    expect(status.instance).toMatchObject({ name: "fix-login", initialized: true, running: 1 });
    expect(status.instance.checkouts["api@fix-login"]).toEqual({ path: theirs, owned: false, branch: null });

    // Running it again is a no-op that still says where things are.
    const again = await cli(["up"], { cwd: theirs });
    expect(again.code, again.err).toBe(0);
    expect(again.err).not.toContain("creating instance");
    expect(again.out).toContain(address?.[1] ?? "?");
  });

  it("creates the worktrees itself when an instance is named from the workspace", async () => {
    const { ws } = fixture();
    const up = await cli(["-i", "feat-y", "up", "api"], { cwd: ws.dir });
    expect(up.code, up.err).toBe(0);
    expect(git(ws.file(".u8/worktrees/feat-y/api"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat-y");
    const status = await statusJson(ws.dir, "-i", "feat-y");
    expect(status.repos.flatMap((r) => r.apps.map((a) => [a.id, a.status]))).toEqual([["api@feat-y", "running"]]);
  });

  it("fails with the end of the log when the app does not come up", async () => {
    const { ws } = fixture((ports) => ({
      repos: {
        api: {
          path: "api",
          ports: { http: ports.base },
          scripts: { start: "printf 'cannot bind: address in use\\n' >&2; exit 4" },
        },
      },
    }));
    const up = await cli(["-i", "broken", "up"], { cwd: ws.dir });
    expect(up.code).not.toBe(0);
    expect(up.out).toContain("api@broken");
    expect(up.err).toContain("── api@broken: last");
    expect(up.err).toContain("cannot bind: address in use");
  });

  it("names the instance it means when the worktree holds its own copy of u8.jsonc", async () => {
    // The config lives in the repo, so a worktree of the repo has a copy of it.
    const ports = portBlock();
    const ws = createWorkspace({
      name: "mono",
      instances: { ports: { from: ports.from, to: ports.to } },
      repos: {
        app: {
          path: ".",
          ports: { http: ports.base },
          env: { PORT: "${ports.http}", WHO: "${instance.name}" },
          scripts: { start: SERVER },
          health: { http: "http://127.0.0.1:${ports.http}/", interval: 100 },
        },
      },
    });
    fs.writeFileSync(ws.file(".gitignore"), ".wt\n");
    git(ws.dir, "init", "-q", "-b", "main");
    git(ws.dir, "add", "-A");
    git(ws.dir, "commit", "-q", "-m", "init");
    expect((await cli(["start", "--wait"], { cwd: ws.dir })).code).toBe(0);

    const theirs = ws.file(".wt/task");
    git(ws.dir, "worktree", "add", "-q", "-b", "task", theirs);
    expect(fs.existsSync(path.join(theirs, "u8.jsonc"))).toBe(true);

    const up = await cli(["up"], { cwd: theirs });
    expect(up.code, up.err).toBe(0);
    const status = await statusJson(theirs);
    // The workspace is base's, not a second one hashed from the copy.
    expect(status.workspace.configPath).toBe(ws.configPath);
    expect(status.instance.name).toBe("task");
    const port = status.repos[0]?.apps[0]?.ports["http"] ?? 0;
    expect(port).not.toBe(ports.base);
    expect(await ask(port)).toBe("task");
    expect(await ask(ports.base)).toBe("base");
  });
});

describe("u8 daemon stop with instances", () => {
  it("refuses to take other instances down by accident", async () => {
    const { ws } = fixture();
    await cli(["instance", "create", "busy", "api"], { cwd: ws.dir });
    const here = ws.file(".u8/worktrees/busy/api");
    expect((await cli(["start", "--wait"], { cwd: here })).code).toBe(0);

    // From inside the instance it would stop everybody, so it is refused outright.
    const inside = await cli(["daemon", "stop"], { cwd: here });
    expect(inside.code).not.toBe(0);
    expect(inside.err).toContain("stops every instance's services, not only this one's");

    // From base, the running instance is what stands in the way.
    const outside = await cli(["daemon", "stop"], { cwd: ws.dir });
    expect(outside.code).not.toBe(0);
    expect(outside.err).toContain("other instances have services running (busy: 1)");
    expect((await statusJson(here)).instance.running).toBe(1);

    const forced = await cli(["daemon", "stop", "--force"], { cwd: ws.dir });
    expect(forced.code, forced.err).toBe(0);
    expect(forced.out).toContain("daemon stopped");
  });
});
