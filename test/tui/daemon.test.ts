/**
 * The dashboard's instance actions against a real daemon.
 *
 * `operations.test.ts` proves the dashboard sends what it means to and reads
 * the answers it was scripted. What it cannot prove is that those scripts are
 * what a daemon says: that a remove which keeps a checkout leaves the snapshot
 * the dashboard thinks it does, that the refusals carry the code the "discard"
 * step keys off, that a neighbour really goes stale. So here nothing is faked —
 * real git repositories, real worktrees, real HTTP servers on allocated ports —
 * and the controller is driven with the same keys a user presses.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { attach, type AttachedClient } from "../../src/daemon/launch.js";
import type { Snapshot } from "../../src/ipc/protocol.js";
import { createController, type DashboardController } from "../../src/tui/controller.js";
import { dashboardClient, type DashboardState, type TuiKey } from "../../src/tui/types.js";
import { cleanup, cleanupStateHome, createWorkspace, track, waitFor, type Workspace } from "../daemon/helpers.js";

const open: Array<{ controller: DashboardController; attached: AttachedClient }> = [];

afterEach(async () => {
  for (const { controller, attached } of open.splice(0)) {
    await controller.dispose();
    await attached.close().catch(() => undefined);
  }
  await cleanup();
});
afterAll(cleanupStateHome);

/** Answers every request with the instance it runs in and the api it was told to use. */
const SERVER =
  "node -e \"require('http').createServer((q,s)=>s.end(process.env.WHO+'|'+(process.env.API_URL||'')))" +
  ".listen(Number(process.env.PORT),'127.0.0.1')\"";

/** A block of ports no other test file is using, so parallel workers cannot collide. */
function portBlock(): { base: number; from: number; to: number } {
  const base = 38_000 + Math.floor(Math.random() * 2_000) * 10;
  return { base, from: base + 100, to: base + 140 };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=u8", "-c", "user.email=u8@example.test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

interface Dashboard {
  ws: Workspace;
  ports: { base: number; from: number; to: number };
  attached: AttachedClient;
  controller: DashboardController;
  state(): DashboardState;
  snapshot(): Promise<Snapshot>;
  press(input: string, key?: TuiKey): void;
  type(text: string): void;
  enter(): void;
  /** Moves the cursor to a row and opens the menu of the instance it is in. */
  menuOn(rowId: string): void;
  /** Waits for the next result, and returns its lines. */
  report(title: string): Promise<string[]>;
  heading(instance: string): string | undefined;
}

/**
 * `web` talks to `api`; each is its own git repository. A file named `fail`
 * or `slow` in the workspace makes api's init step fail, or web's take a while.
 */
async function dashboard(): Promise<Dashboard> {
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
        instance: {
          init: ['if [ -f "$U8_WORKSPACE_ROOT/fail" ]; then echo "boom: cannot prepare api" >&2; exit 3; fi'],
        },
      },
      web: {
        path: "web",
        ports: { http: ports.base + 1 },
        env: { PORT: "${ports.http}", API_URL: "http://127.0.0.1:${api.ports.http}" },
        scripts: { start: SERVER },
        dependsOn: ["api"],
        instance: { init: ['if [ -f "$U8_WORKSPACE_ROOT/slow" ]; then sleep 1.5; fi'] },
      },
    },
  });
  initRepo(ws.file("api"));
  initRepo(ws.file("web"));
  track(ws);

  const attached = await attach({ configPath: ws.configPath, interactive: true, env: { U8_IDLE_MS: "20000" } });
  // No frame delay: every push is on screen by the time the next line looks.
  const controller = createController({ client: dashboardClient(attached), color: false, frameMs: 0 });
  controller.setColumns(1_000);
  controller.setViewport(200);
  open.push({ controller, attached });

  const d: Dashboard = {
    ws,
    ports,
    attached,
    controller,
    state: () => controller.getState(),
    snapshot: () => attached.client.request("workspace.snapshot", {}),
    press: (input, key = {}) => controller.handleKey(input, key),
    type(text) {
      for (const ch of text) controller.handleKey(ch, {});
    },
    enter: () => controller.handleKey("", { return: true }),
    menuOn(rowId) {
      const index = controller.getState().rows.findIndex((row) => row.id === rowId);
      if (index < 0) throw new Error(`no row ${rowId} in: ${controller.getState().rows.map((row) => row.id).join(", ")}`);
      controller.setCursor(index);
      controller.handleKey("i", {});
    },
    async report(title) {
      await waitFor(
        () => controller.getState().mode === "report",
        `the result "${title}" (mode ${controller.getState().mode}, form error: ${controller.getState().form?.error ?? "none"})`,
        15_000,
      );
      const report = controller.getState().report;
      expect(report?.title).toBe(title);
      return report?.lines.map((line) => line.text) ?? [];
    },
    heading: (instance) => controller.getState().rows.find((row) => row.id === `instance:${instance}`)?.text,
  };
  return d;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected the daemon to refuse");
    },
    (err: unknown) => (err as Error).message,
  );
}

describe("the dashboard against a real daemon", () => {
  it("creates, brings up, grows, shrinks and destroys an instance, saying what the CLI would", async () => {
    const d = await dashboard();
    const wt = (repo: string): string => d.ws.file(`.u8/worktrees/feat-x/${repo}`);
    // Only base: the list a workspace has always had, with no heading on it.
    expect(d.state().rows.map((row) => row.id)).toEqual(["api", "web"]);

    // --- create: web only, so it leans on base's api -------------------------
    d.press("i");
    d.press("n");
    d.type("feat-x");
    for (let i = 0; i < 3; i++) d.press("", { downArrow: true });
    d.press(" ");
    d.enter();

    const created = await d.report("feat-x · create");
    const webPort = (await d.snapshot()).repos.flatMap((r) => r.apps).find((a) => a.id === "web@feat-x")?.ports["http"] ?? 0;
    expect(webPort).toBeGreaterThanOrEqual(d.ports.from);
    expect(created).toEqual([
      "instance feat-x created and initialised",
      `  web@feat-x  http  http://localhost:${webPort}`,
      "nothing is running yet — start it from its menu (i u), or with S on its section",
    ]);
    expect(git(wt("web"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat-x");
    d.enter();
    // The cursor is where the new instance is, and its heading already says what it lacks.
    expect(d.state().rows[d.state().cursor]?.id).toBe("instance:feat-x");
    expect(d.heading("feat-x")).toBe("▾ feat-x  0/1 running · api@base is down");

    // --- up ------------------------------------------------------------------
    d.press("i");
    d.press("u");
    expect(await d.report("feat-x · up")).toEqual([
      "instance feat-x is up: 1 app ready",
      `  web@feat-x  http  http://localhost:${webPort}`,
      'instance "feat-x" uses api from another instance, and it is not running — start it from its own section (s on the row)',
    ]);
    expect(await (await fetch(`http://127.0.0.1:${webPort}/`)).text()).toBe(`feat-x|http://127.0.0.1:${d.ports.base}`);
    d.enter();
    expect(d.heading("feat-x")).toBe("▾ feat-x  1/1 running · api@base is down");

    // --- add api: the running web is left on base's, and named ----------------
    d.press("i");
    d.press("a");
    expect(d.state().form?.fields.map((field) => field.key)).toEqual(["api", "branch", "from"]);
    d.press(" ");
    d.enter();

    const added = await d.report("feat-x · add api");
    const apiPort = (await d.snapshot()).repos.flatMap((r) => r.apps).find((a) => a.id === "api@feat-x")?.ports["http"] ?? 0;
    expect(added).toEqual([
      "added api to instance feat-x",
      `  api@feat-x  http  http://localhost:${apiPort}`,
      "not started yet — s on the new rows starts them",
      "web@feat-x is now stale: it is still running with what it pointed at before this change — restart to pick it up: r here restarts it, or R on the instance's section",
    ]);
    expect(d.state().report?.actions).toEqual([{ key: "r", label: "restart it now" }]);

    // The restart the report offers is the one that makes the change real.
    d.press("r");
    await waitFor(() => d.heading("feat-x") === "▾ feat-x  1/2 running", "web to be restarted onto its own api", 15_000);
    expect(await (await fetch(`http://127.0.0.1:${webPort}/`)).text()).toBe(`feat-x|http://127.0.0.1:${apiPort}`);

    // --- remove api, keeping its checkout -------------------------------------
    d.menuOn("api@feat-x");
    d.press("d");
    expect(d.state().form?.fields.map((field) => [field.key, field.kind === "check" ? field.checked : field.value])).toEqual([
      ["api", true],
      ["web", false],
      ["checkout", "keep"],
    ]);
    d.enter();

    expect(await d.report("feat-x · remove api")).toEqual([
      "removed api from instance feat-x",
      `kept the checkout of api at ${wt("api")} — bring it back by adding an app of it (i a), or give it up from the menu (i c)`,
      "web@feat-x is now stale: it is still running with what it pointed at before this change — restart to pick it up: r here restarts it, or R on the instance's section",
      'instance "feat-x" uses api from another instance, and it is not running — start it from its own section (s on the row)',
    ]);
    d.enter();

    // What the daemon really leaves behind: the checkout in the record, its repo gone from the rows.
    const kept = await d.snapshot();
    expect(Object.keys(kept.instances.find((i) => i.name === "feat-x")?.checkouts ?? {})).toEqual(["api@feat-x", "web@feat-x"]);
    expect(kept.repos.map((r) => r.name)).toEqual(["api", "web", "web@feat-x"]);
    expect(d.state().rows.map((row) => row.id)).toEqual(["instance:base", "api", "web", "instance:feat-x", "web@feat-x"]);
    expect(d.heading("feat-x")).toBe("▾ feat-x  1/1 running · 1 stale · api@base is down");

    d.menuOn("web@feat-x");
    expect(d.state().instanceMenu?.items.find((item) => item.id === "checkouts")?.hint).toBe("api");
    d.press("v");
    const detail = d.state().detail?.lines.map((line) => line.text) ?? [];
    expect(detail).toContain("  api  branch feat-x · created by u8 (the branch too) · no apps (kept)");
    expect(detail).toContain(`  api@base  stopped — not running  (needed by web) — start it from its own section`);
    d.press("", { escape: true });

    // --- give the kept checkout up: refused while it has uncommitted work ------
    fs.writeFileSync(path.join(wt("api"), "notes.txt"), "half an idea\n");
    const worded = await refusalOf(
      d.attached.client.request("instance.remove", { name: "feat-x", targets: ["api"], prune: true }),
    );
    expect(worded).toContain(`the worktree at ${wt("api")} has uncommitted changes (notes.txt), so nothing was stopped or removed`);

    d.menuOn("web@feat-x");
    d.press("c");
    d.press(" ");
    d.enter();
    // As the daemon worded it, to the letter — and with the one way past it.
    expect(await d.report("feat-x · give up api — refused")).toEqual([worded]);
    expect(d.state().report?.actions).toEqual([{ key: "D", label: "discard the uncommitted changes and remove the worktree…" }]);
    expect(fs.existsSync(path.join(wt("api"), "notes.txt"))).toBe(true);

    // Escaping the question leaves the file where it is.
    d.press("D");
    d.type("feat-x");
    d.press("", { escape: true });
    expect(d.state().mode).toBe("report");
    expect(fs.existsSync(wt("api"))).toBe(true);

    d.press("D");
    d.type("feat-x");
    d.enter();
    await waitFor(() => d.state().mode === "report" && d.state().report?.title === "feat-x · remove", "the discard to finish", 15_000);
    expect(d.state().report?.lines.map((line) => line.text)).toEqual([`removed the worktree at ${wt("api")}`]);
    expect(fs.existsSync(wt("api"))).toBe(false);
    d.enter();

    // --- the last app cannot be removed: that is destroy ----------------------
    d.menuOn("web@feat-x");
    d.press("d");
    d.enter();
    await waitFor(() => d.state().form?.error !== undefined, "the daemon's refusal");
    expect(d.state().form?.error).toBe(
      'removing "web" would leave instance "feat-x" with no apps — to be rid of the instance, destroy it: u8 instance destroy feat-x',
    );
    expect((await d.snapshot()).instances.find((i) => i.name === "feat-x")?.appIds).toEqual(["web@feat-x"]);
    d.press("", { escape: true });

    // --- destroy ---------------------------------------------------------------
    d.menuOn("web@feat-x");
    d.press("D");
    expect(d.state().confirm?.lines.map((line) => line.text)).toEqual([
      "stops 1 running app, runs the teardown steps and frees its ports",
      "removes 1 worktree u8 created, with whatever is uncommitted in it:",
      `  ${wt("web")}`,
    ]);
    d.enter();
    expect((await d.snapshot()).instances.map((i) => i.name)).toEqual(["base", "feat-x"]);
    d.type("feat-x");
    d.enter();

    expect(await d.report("feat-x · destroy")).toEqual([
      "instance feat-x destroyed",
      `removed the worktree at ${wt("web")}`,
    ]);
    d.enter();
    expect(fs.existsSync(wt("web"))).toBe(false);
    expect(git(d.ws.file("web"), "worktree", "list").split("\n")).toHaveLength(1);
    // Back to the unheaded list, with the cursor on a row that exists.
    expect(d.state().rows.map((row) => row.id)).toEqual(["api", "web"]);
    expect(d.state().cursor).toBe(0);
    await expect(fetch(`http://127.0.0.1:${webPort}/`)).rejects.toThrow();
  }, 60_000);

  it("shows a failed init step with the end of its log, and the daemon's own word for 'busy'", async () => {
    const d = await dashboard();

    // --- an init step that fails ----------------------------------------------
    fs.writeFileSync(d.ws.file("fail"), "");
    d.press("i");
    d.press("n");
    d.type("feat-y");
    for (let i = 0; i < 4; i++) d.press("", { downArrow: true });
    d.press(" ");
    d.enter();

    const step = 'if [ -f "$U8_WORKSPACE_ROOT/fail" ]; then echo "boom: cannot prepare api" >&2; exit 3; fi';
    expect(await d.report("feat-y · create — init failed")).toEqual([
      "instance feat-y was created, but its init steps did not finish",
      // The engine's own verdict, whole: which step, and how it ended.
      `✗ api@feat-y failed — exit 3: exited with code 3: ${step}`,
      "",
      // And what the step printed, which is the part that explains it.
      "── api@feat-y: last 3 lines ──",
      `$ ${step}`,
      "boom: cannot prepare api",
      `exited with code 3: ${step}`,
      "",
      "instance feat-y reads not initialised until its init steps have been through — fix the step, then run init again from its menu (i i)",
    ]);
    d.enter();
    expect(d.heading("feat-y")).toBe("▾ feat-y  0/1 running · not initialised");

    // --- init again, fixed -----------------------------------------------------
    fs.rmSync(d.ws.file("fail"));
    d.press("i");
    d.press("i");
    expect(await d.report("feat-y · init")).toEqual(["instance feat-y is initialised"]);
    d.enter();
    expect(d.heading("feat-y")).toBe("▾ feat-y  0/1 running");

    // --- a second edit while the first is still running its steps ---------------
    fs.writeFileSync(d.ws.file("slow"), "");
    d.press("i");
    d.press("a");
    d.press(" ");
    d.enter();
    await waitFor(() => d.state().mode === "list" && d.state().activity.length === 1, "the add to be taken");
    expect(d.state().activity).toEqual(["feat-y: adding web — instance:init"]);
    // While an add's steps run the instance reads not initialised, and its heading names the run.
    await waitFor(() => d.heading("feat-y")?.includes("… instance:init") === true, "the heading to name the run");
    expect(d.heading("feat-y")).toBe("▾ feat-y  0/2 running · … instance:init · not initialised");

    d.menuOn("api@feat-y");
    d.press("d");
    d.enter();
    await waitFor(() => d.state().form?.error !== undefined, "the daemon's refusal");
    expect(d.state().form?.error).toBe(
      'instance "feat-y" is still busy with an earlier init, add or remove — wait for that run to finish',
    );
    d.press("", { escape: true });

    expect(await d.report("feat-y · add web")).toContain("added web to instance feat-y");
    d.enter();
    expect(d.heading("feat-y")).toBe("▾ feat-y  0/2 running");
  }, 60_000);
});
