/**
 * Config hot-reload driven by the file watcher — SPEC §8, PLAN Phase 12.
 *
 * `workspace.reload` is covered in `rpc.test.ts`; everything here goes through
 * the watcher instead, because that is where the interesting failures live: a
 * save an editor performs as a rename, a broken file that must not kill the
 * watch, a plugin list that moved, and a burst of saves that must not turn into
 * a burst of reloads.
 *
 * The daemons are real and in their own processes, driven over a real socket
 * against workspaces in a tmpdir — the watcher's debounce and stat poll run at
 * their production cadence, so the waits here are generous on purpose. The last
 * three groups use an in-process daemon and the watcher directly: a save landing
 * mid-startup, a closed watcher and a silent poll are all invisible from the
 * other end of a socket.
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createDaemon } from "../../src/daemon/daemon.js";
import { CONFIG_DEBOUNCE_MS, CONFIG_POLL_MS, configSignature, watchConfig } from "../../src/daemon/watch.js";
import { createRpcClient, type RpcClient } from "../../src/ipc/index.js";
import type { RpcNotificationPayload, ServiceState } from "../../src/ipc/protocol.js";
import { nullLogger } from "../../src/util/logger.js";
import { recordingLogger } from "../indicators/helpers.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  delay,
  record,
  SERVICE_SCRIPT,
  track,
  waitFor,
  type Workspace,
} from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

afterAll(() => {
  cleanupStateHome();
});

/** A save costs a debounce window plus the reload itself; leave room for both. */
const RELOAD_TIMEOUT_MS = 10_000;

type Reload = RpcNotificationPayload<"config.reloaded">;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two idle services and one command.
 *
 * The built-ins are off throughout: `git` fs-watches every repo's `.git`, and a
 * test that counts watchers or reasons about the plugin list wants exactly the
 * plugins it put there.
 */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    builtins: { git: false, health: false },
    templates: { app: "{app@status} {app@name}" },
    repos: {
      api: { path: "api", scripts: { start: SERVICE_SCRIPT } },
      web: { path: "web", scripts: { start: SERVICE_SCRIPT } },
    },
    profiles: { all: { default: true, targets: ["api", "web"] } },
    commands: { hello: { script: "printf 'hello\\n'" } },
    ...overrides,
  };
}

/** {@link baseConfig} with api's start script rewritten — what makes it stale. */
function editedApiConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseConfig({
    repos: {
      api: { path: "api", scripts: { start: `printf 'v2\\n'; ${SERVICE_SCRIPT}` } },
      web: { path: "web", scripts: { start: SERVICE_SCRIPT } },
    },
    ...overrides,
  });
}

function hotWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  const ws = createWorkspace(baseConfig(overrides), ["api", "web", "plugins"]);
  // Node decides a `.js` file's module kind from the nearest package.json, and
  // the fixture plugins below are written as ESM.
  fs.writeFileSync(path.join(ws.dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  return ws;
}

/** Contributes one fast-polling indicator, so its registration is observable. */
const PROBE_PLUGIN = `export default {
  name: "probe",
  indicators: {
    tag: {
      update: { mode: "poll", intervalMs: 100 },
      value: (ctx) => \`probe:\${ctx.target.id}\`,
    },
  },
};
`;

const BROKEN_PLUGIN = `throw new Error("this plugin is broken on purpose");\n`;

/** Holds a reload open long enough for later saves to land inside it. */
const SLOW_PLUGIN = `export default {
  name: "slow",
  setup: () => new Promise((resolve) => setTimeout(resolve, 2000)),
};
`;

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** Performs a save and resolves with the reload notification it produced. */
async function saveWith(reloads: Reload[], write: () => void, label: string): Promise<Reload> {
  const before = reloads.length;
  write();
  await waitFor(() => reloads.length > before, label, RELOAD_TIMEOUT_MS);
  const last = reloads.at(-1);
  if (!last) throw new Error(`no reload recorded for ${label}`);
  return last;
}

function save(ws: Workspace, reloads: Reload[], config: object, label: string): Promise<Reload> {
  return saveWith(reloads, () => ws.rewrite(config), label);
}

/** How vim and VS Code save: write a sibling, then rename it over the target. */
function atomicSave(ws: Workspace, config: object): void {
  const swap = path.join(ws.dir, ".u8.jsonc.swap");
  fs.writeFileSync(swap, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(swap, ws.configPath);
}

/** Poll-until-present for something only an RPC can answer. */
async function pollFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(25);
  }
}

async function serviceState(client: RpcClient, id: string): Promise<ServiceState> {
  const snapshot = await client.request("workspace.snapshot", {});
  const state = snapshot.services.find((s) => s.targetId === id);
  if (!state) throw new Error(`the daemon reports no service state for ${id}`);
  return state;
}

/** Starts a target and waits out the supervisor's start grace. */
async function startRunning(client: RpcClient, id: string): Promise<ServiceState> {
  const run = await client.request("service.start", { targets: [id] });
  await client.request("run.await", { runId: run.runId });
  return pollFor(async () => {
    const state = await serviceState(client, id);
    return state.status === "running" ? state : undefined;
  }, `${id} to be running`);
}

async function attached(ws: Workspace): Promise<RpcClient> {
  const client = await connect(ws);
  await client.request("client.attach", { clientVersion: "test" });
  return client;
}

// ---------------------------------------------------------------------------

describe("watched saves", () => {
  it("hot-applies an edited template without touching the running process", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    const changes = record(client, "service.changed");

    const before = await startRunning(client, "api");
    const seen = changes.length;

    const template = "{app@name} — {app@status}";
    const reloaded = await save(ws, reloads, baseConfig({ templates: { app: template } }), "the template reload");

    expect(reloaded.ok).toBe(true);
    // The snapshot rides along, so a client re-renders from the notification.
    expect(reloaded.snapshot?.templates.app).toBe(template);
    expect(reloaded.stale).toEqual([]);

    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.templates.app).toBe(template);
    // SPEC §8: a reload never restarts anything. Same pid, same spawn instant.
    expect(snapshot.services.find((s) => s.targetId === "api")).toMatchObject({
      status: "running",
      stale: false,
      pid: before.pid,
      startedAt: before.startedAt,
    });
    // And nothing about the target moved, so it was never announced either.
    expect(changes.slice(seen).filter((c) => c.state.targetId === "api")).toEqual([]);
  });

  it("detects an atomic rename-over save, and the one after it", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const first = await saveWith(
      reloads,
      () => atomicSave(ws, baseConfig({ commands: { one: { script: "true" } } })),
      "the reload after a rename-over save",
    );
    expect(first.ok).toBe(true);
    expect(first.snapshot?.commands.map((c) => c.name)).toContain("one");

    // The rename swapped the inode out from under the file watch, so a second
    // `:w` in vim is where a watcher that never recovers from that goes deaf.
    // Here the poll is still a backstop, which is the honest end-to-end claim;
    // that events alone survive it is pinned below, with the poll switched off.
    const second = await saveWith(
      reloads,
      () => atomicSave(ws, baseConfig({ commands: { two: { script: "true" } } })),
      "the reload after a second rename-over save",
    );
    expect(second.ok).toBe(true);

    const names = (await client.request("workspace.snapshot", {})).commands.map((c) => c.name);
    expect(names).toContain("two");
    expect(names).not.toContain("one");
  });

  it("hot-applies a config-defined indicator, and drops it when a save removes it", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const added = await save(
      ws,
      reloads,
      baseConfig({ indicators: { tag: { cmd: "printf 'v9'", interval: 300 } } }),
      "the reload that adds an indicator",
    );
    expect(added.ok).toBe(true);

    // Config-declared providers are derived from the workspace, so a reload has
    // to re-derive them: one cell per target, each evaluated in that target's
    // own cwd. They carry no namespace, which is what tells them from a plugin's.
    const owners = await pollFor(async () => {
      const cells = (await client.request("workspace.snapshot", {})).indicators.filter(
        (v) => v.ns === "" && v.name === "tag" && v.value === "v9",
      );
      return cells.length === 2 ? cells.map((v) => v.owner).sort() : undefined;
    }, "the new indicator to be polled for every target");
    expect(owners).toEqual(["api", "web"]);

    await save(ws, reloads, baseConfig(), "the reload that removes the indicator");
    expect((await client.request("workspace.snapshot", {})).indicators.some((v) => v.ns === "")).toBe(false);
  });

  it("hot-applies added profiles and commands", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const reloaded = await save(
      ws,
      reloads,
      baseConfig({
        profiles: {
          all: { default: true, targets: ["api", "web"] },
          "web-only": { targets: ["web"] },
        },
        commands: {
          hello: { script: "printf 'hello\\n'" },
          bye: { script: "printf 'bye\\n'", targets: { web: null } },
        },
      }),
      "the reload that adds a profile and a command",
    );

    expect(reloaded.snapshot?.profiles.map((p) => p.name)).toEqual(["all", "web-only"]);
    expect(reloaded.snapshot?.profiles.find((p) => p.name === "web-only")?.appIds).toEqual(["web"]);
    // `null` is a skip, so the new command resolves work for api alone.
    expect(reloaded.snapshot?.commands.find((c) => c.name === "bye")?.appliesTo).toEqual(["api"]);

    // Both are live immediately — no reconnect, no daemon restart. The new
    // profile is what an untargeted run resolves against, and the new command
    // resolves a script for it.
    await client.request("profile.use", { name: "web-only" });
    const hello = await client.request("command.run", { command: "hello" });
    const helloResult = await client.request("run.await", { runId: hello.runId });
    expect(helloResult.targets).toEqual([expect.objectContaining({ targetId: "web", state: "ok" })]);

    const run = await client.request("command.run", { command: "bye" });
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.targets).toEqual([expect.objectContaining({ targetId: "web", state: "skipped" })]);
  });
});

describe("staleness", () => {
  it("marks a running target stale when its start script changes, and a restart clears it", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const before = await startRunning(client, "api");

    const reloaded = await save(ws, reloads, editedApiConfig(), "the reload that rewrites api's start script");
    expect(reloaded.ok).toBe(true);
    expect(reloaded.stale).toEqual(["api"]);

    // The process keeps its spawn-time definition; only the flag moved.
    expect(await serviceState(client, "api")).toMatchObject({
      status: "running",
      stale: true,
      pid: before.pid,
    });

    const restart = await client.request("service.restart", { targets: ["api"] });
    await client.request("run.await", { runId: restart.runId });
    const fresh = await pollFor(async () => {
      const state = await serviceState(client, "api");
      return state.status === "running" && !state.stale ? state : undefined;
    }, "the restart to adopt the new definition and clear the flag");
    expect(fresh.pid).not.toBe(before.pid);
  });

  it("does not flap the stale flag on a reload that leaves the target alone", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    const changes = record(client, "service.changed");

    await startRunning(client, "api");
    await save(ws, reloads, editedApiConfig(), "the reload that makes api stale");
    await waitFor(
      () => changes.filter((c) => c.state.targetId === "api").at(-1)?.state.stale === true,
      "api to be reported stale",
    );

    const seen = changes.length;
    const unrelated = await save(
      ws,
      reloads,
      editedApiConfig({ commands: { hello: { script: "printf 'hello\\n'" }, extra: { script: "true" } } }),
      "an unrelated reload",
    );

    // Staleness is re-derived from scratch on every reload, so the risk is the
    // opposite of a missed flag: clearing and re-setting it, and pushing a
    // service.changed for a process nothing happened to.
    expect(unrelated.stale).toEqual(["api"]);
    expect(changes.slice(seen).filter((c) => c.state.targetId === "api")).toEqual([]);
    expect((await serviceState(client, "api")).stale).toBe(true);
  });
});

describe("invalid saves", () => {
  it("keeps the last-good config and recovers on the next good save", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    const running = await startRunning(client, "api");

    const failed = await saveWith(
      reloads,
      () => ws.rewrite({ repos: { api: {} } }), // `path` is required
      "the reload of a broken config",
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("path");

    const broken = await client.request("workspace.snapshot", {});
    expect(broken.configError).toContain("path");
    expect(broken.repos.map((r) => r.name)).toEqual(["api", "web"]);
    expect(broken.services.find((s) => s.targetId === "api")).toMatchObject({
      status: "running",
      pid: running.pid,
    });

    // The watcher has to survive its own bad news: a watch that dies on the
    // first broken save leaves the workspace permanently wrong, and the user's
    // fix — the very next `:w` — never arrives.
    const fixed = await save(
      ws,
      reloads,
      baseConfig({ commands: { repaired: { script: "true" } } }),
      "the recovery reload",
    );
    expect(fixed.ok).toBe(true);

    const good = await client.request("workspace.snapshot", {});
    expect(good.configError).toBeUndefined();
    expect(good.commands.map((c) => c.name)).toContain("repaired");
    expect(good.services.find((s) => s.targetId === "api")?.pid).toBe(running.pid);
  });

  it("survives the config file disappearing and coming back", async () => {
    const ws = hotWorkspace();
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const gone = await saveWith(reloads, () => fs.rmSync(ws.configPath), "the reload that finds no config");
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/not found/i);
    expect((await client.request("workspace.snapshot", {})).repos.map((r) => r.name)).toEqual(["api", "web"]);

    const restored = await save(
      ws,
      reloads,
      baseConfig({ commands: { back: { script: "true" } } }),
      "the reload after the file returns",
    );
    expect(restored.ok).toBe(true);
    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.configError).toBeUndefined();
    expect(snapshot.commands.map((c) => c.name)).toContain("back");
  });

  it("falls back to the default profile when a save deletes the active one", async () => {
    const ws = hotWorkspace({ profiles: { all: { default: true, targets: ["api"] }, wide: { targets: ["api", "web"] } } });
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    await client.request("profile.use", { name: "wide" });

    const reloaded = await save(ws, reloads, baseConfig(), "the reload that drops the active profile");
    expect(reloaded.ok).toBe(true);
    expect(reloaded.snapshot?.activeProfile).toBe("all");

    // The fallback drives resolution too, rather than throwing on every run.
    const run = await client.request("command.run", { command: "hello" });
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.targets.map((t) => t.targetId)).toEqual(["api", "web"]);
  });
});

describe("plugins across a reload", () => {
  it("loads a plugin a save added and unregisters it when a save removes it", async () => {
    const ws = hotWorkspace();
    fs.writeFileSync(ws.file("plugins/probe.js"), PROBE_PLUGIN, "utf8");
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    expect((await client.request("workspace.snapshot", {})).plugins).toEqual([]);

    const added = await save(
      ws,
      reloads,
      baseConfig({ plugins: ["./plugins/probe.js"] }),
      "the reload that adds a plugin",
    );
    expect(added.ok).toBe(true);
    expect(added.snapshot?.plugins).toEqual([{ name: "probe", spec: "./plugins/probe.js", ok: true }]);

    // The registration is only real once the provider is polling into the
    // shared cache, which is what a client actually renders. Registering the
    // provider creates the cell empty, so waiting for the cell alone would race
    // its first evaluation — it is the *value* that proves the provider ran.
    const cell = await pollFor(
      async () =>
        (await client.request("workspace.snapshot", {})).indicators.find(
          (v) => v.ns === "probe" && v.name === "tag" && v.value !== "",
        ),
      "the plugin's indicator to reach the cache",
    );
    expect(cell).toMatchObject({ owner: "api", value: "probe:api" });

    const removed = await save(ws, reloads, baseConfig(), "the reload that drops the plugin");
    expect(removed.snapshot?.plugins).toEqual([]);
    // A namespace left registered would keep evaluating through a torn-down
    // plugin's context — and keep rendering cells for a plugin that is gone.
    expect((await client.request("workspace.snapshot", {})).indicators.some((v) => v.ns === "probe")).toBe(false);
  });

  it("reports a plugin that fails to load without aborting the reload", async () => {
    const ws = hotWorkspace();
    fs.writeFileSync(ws.file("plugins/broken.js"), BROKEN_PLUGIN, "utf8");
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");
    const failures = record(client, "plugin.error");

    const reloaded = await save(
      ws,
      reloads,
      baseConfig({
        plugins: ["./plugins/broken.js"],
        commands: { hello: { script: "printf 'hello\\n'" }, survivor: { script: "true" } },
      }),
      "the reload that adds a broken plugin",
    );

    // Cold-start plugin failures happen before the socket is bound, so a reload
    // is the one moment `plugin.error` can actually reach a client.
    await waitFor(() => failures.length > 0, "the plugin.error notification");
    expect(failures[0]?.plugin).toBe("broken");
    expect(failures[0]?.error).toContain("broken on purpose");

    expect(reloaded.ok).toBe(true);
    expect(reloaded.snapshot?.plugins).toEqual([
      expect.objectContaining({ spec: "./plugins/broken.js", ok: false }),
    ]);
    // The rest of the same save applied regardless of the plugin's failure.
    expect(reloaded.snapshot?.commands.map((c) => c.name)).toContain("survivor");

    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.plugins[0]?.error).toContain("broken on purpose");
    expect(snapshot.configError).toBeUndefined();
  });
});

describe("reload storms", () => {
  it("coalesces the saves that land during a reload into exactly one follow-up", async () => {
    const ws = hotWorkspace();
    fs.writeFileSync(ws.file("plugins/slow.js"), SLOW_PLUGIN, "utf8");
    const client = await attached(ws);
    const reloads = record(client, "config.reloaded");

    const withSlow = (name: string): Record<string, unknown> =>
      baseConfig({ plugins: ["./plugins/slow.js"], commands: { [name]: { script: "true" } } });

    // This one takes ~2s to apply: the plugin list moved, so the host is rebuilt
    // and the new plugin's setup() holds the reload open.
    ws.rewrite(withSlow("first"));

    // Two more, spaced far enough apart to clear the watcher's debounce
    // separately — without in-flight coalescing they are two more reloads.
    await delay(600);
    ws.rewrite(withSlow("second"));
    await delay(500);
    ws.rewrite(withSlow("third"));

    await waitFor(() => reloads.length >= 2, "the reload and its follow-up", RELOAD_TIMEOUT_MS);
    // Long enough for a stat-poll tick to produce a third one if anything is
    // still holding a signature from before the burst.
    await delay(CONFIG_POLL_MS + 1_000);

    expect(reloads.length).toBe(2);
    expect(reloads.every((r) => r.ok)).toBe(true);

    // The follow-up read the file after the last save, not before it.
    const snapshot = await client.request("workspace.snapshot", {});
    expect(snapshot.commands.map((c) => c.name)).toContain("third");
    expect(snapshot.commands.map((c) => c.name)).not.toContain("second");
    // One host, loaded once, however many saves went past.
    expect(snapshot.plugins).toEqual([{ name: "slow", spec: "./plugins/slow.js", ok: true }]);
  });
});

describe("startup", () => {
  /**
   * The watch is armed at the end of `start()`, after plugins are imported and
   * set up — seconds, for a workspace with real plugins. A save landing in that
   * window is the one an editor makes right after the first `u8` command
   * auto-spawned the daemon, and it has to survive a watcher that was not there
   * to see it: nothing else ever looks at the file again.
   */
  it("reloads a save that landed while the daemon was still starting", async () => {
    const ws = hotWorkspace({ plugins: ["./plugins/slow.js"] });
    fs.writeFileSync(ws.file("plugins/slow.js"), SLOW_PLUGIN, "utf8");
    track(ws);

    const daemon = createDaemon({ configPath: ws.configPath, logger: nullLogger, idleMs: 0 });
    // The plugin's setup() holds start() open for ~2s; the save lands inside it.
    const starting = daemon.start();
    await delay(300);
    ws.rewrite(baseConfig({ plugins: ["./plugins/slow.js"], commands: { early: { script: "true" } } }));
    await starting;

    try {
      await waitFor(
        () => daemon.snapshot().commands.some((c) => c.name === "early"),
        "the save from the startup window to be applied",
        RELOAD_TIMEOUT_MS,
      );
    } finally {
      await daemon.shutdown("test over");
    }
  });
});

describe("watcher lifetime", () => {
  /**
   * libuv's own handle table. `fs.watch(..., { persistent: false })` handles are
   * unref'd, so they never appear in `getActiveResourcesInfo()` — this is the
   * only place a leaked config watch would show up.
   */
  const fsEventHandles = (): number => {
    const report = process.report?.getReport() as { libuv?: Array<{ type: string }> } | undefined;
    return (report?.libuv ?? []).filter((handle) => handle.type === "fs_event").length;
  };

  it("closes both watches when the daemon shuts down", async () => {
    const ws = hotWorkspace();
    track(ws);

    const before = fsEventHandles();
    const daemon = createDaemon({ configPath: ws.configPath, logger: nullLogger, idleMs: 0 });
    await daemon.start();
    // The file and its directory: an editor's rename-over needs both.
    expect(fsEventHandles()).toBe(before + 2);

    const client = createRpcClient({ socketPath: ws.paths.socket, timeoutMs: 5_000 });
    await client.connect();
    await client.request("client.attach", { clientVersion: "test" });
    const reloads = record(client, "config.reloaded");
    await save(ws, reloads, baseConfig({ commands: { live: { script: "true" } } }), "a reload while the daemon is up");
    await client.close();

    await daemon.shutdown("test over");
    expect(fsEventHandles()).toBe(before);

    // And nothing is left to notice this one.
    const commands = daemon.snapshot().commands.map((c) => c.name);
    ws.rewrite(baseConfig({ commands: { ignored: { script: "true" } } }));
    await delay(CONFIG_POLL_MS + CONFIG_DEBOUNCE_MS + 500);
    expect(daemon.snapshot().commands.map((c) => c.name)).toEqual(commands);
  });
});

/**
 * The two properties a socket cannot see: the fallback poll doing the watcher's
 * job on a filesystem whose events never arrive, and the disposer actually
 * silencing it.
 */
describe("watchConfig", () => {
  it("reports a change from the stat poll alone when fs.watch never fires", async () => {
    const ws = hotWorkspace();
    let changes = 0;
    const stop = watchConfig({
      configPath: ws.configPath,
      logger: nullLogger,
      // What a network or container filesystem looks like: no events, ever.
      nativeWatch: false,
      debounceMs: 20,
      pollMs: 40,
      onChange: () => {
        changes += 1;
      },
    });
    try {
      ws.rewrite(baseConfig({ commands: { polled: { script: "true" } } }));
      await waitFor(() => changes > 0, "the stat poll to notice the save", 3_000);
    } finally {
      stop();
    }
  });

  it("does not report a save twice when the poll and an event both see it", async () => {
    const ws = hotWorkspace();
    let changes = 0;
    const stop = watchConfig({
      configPath: ws.configPath,
      logger: nullLogger,
      debounceMs: 30,
      pollMs: 100,
      onChange: () => {
        changes += 1;
      },
    });
    try {
      ws.rewrite(baseConfig({ commands: { once: { script: "true" } } }));
      // Several poll ticks and several watch events (create, write, close) later.
      await delay(600);
      expect(changes).toBe(1);
    } finally {
      stop();
    }
  });

  it("keeps up with rename-over saves when only the watches can see them", async () => {
    const ws = hotWorkspace();
    let changes = 0;
    const stop = watchConfig({
      configPath: ws.configPath,
      logger: nullLogger,
      debounceMs: 30,
      // No backstop: a watch that goes deaf on the inode a rename swapped out
      // stays deaf, instead of being covered by the next stat tick.
      pollMs: 0,
      onChange: () => {
        changes += 1;
      },
    });
    try {
      atomicSave(ws, baseConfig({ commands: { one: { script: "true" } } }));
      await waitFor(() => changes === 1, "the first rename-over save", 3_000);
      atomicSave(ws, baseConfig({ commands: { two: { script: "true" } } }));
      await waitFor(() => changes === 2, "the second rename-over save", 3_000);
    } finally {
      stop();
    }
  });

  it("reports a save that landed before the watch was armed", async () => {
    const ws = hotWorkspace();
    // What the daemon captures next to its own read of the config.
    const asRead = configSignature(ws.configPath);
    ws.rewrite(baseConfig({ commands: { missed: { script: "true" } } }));

    let changes = 0;
    const stop = watchConfig({
      configPath: ws.configPath,
      logger: nullLogger,
      baseline: asRead,
      debounceMs: 20,
      pollMs: 0,
      onChange: () => {
        changes += 1;
      },
    });
    try {
      await waitFor(() => changes === 1, "the save from before the watch started", 2_000);
      // Once, though: the baseline is consumed, not re-compared on every tick.
      await delay(300);
      expect(changes).toBe(1);
    } finally {
      stop();
    }
  });

  it("goes quiet once disposed, however the file changes", async () => {
    const ws = hotWorkspace();
    let changes = 0;
    const stop = watchConfig({
      configPath: ws.configPath,
      logger: nullLogger,
      debounceMs: 20,
      pollMs: 40,
      onChange: () => {
        changes += 1;
      },
    });
    ws.rewrite(baseConfig({ commands: { before: { script: "true" } } }));
    await waitFor(() => changes === 1, "the change before disposal", 3_000);

    stop();
    stop(); // reachable from shutdown and from a caller; must not throw

    ws.rewrite(baseConfig({ commands: { after: { script: "true" } } }));
    fs.rmSync(ws.configPath);
    ws.rewrite(baseConfig());
    // Ten poll intervals and a debounce window: nothing may arrive late either.
    await delay(500);
    expect(changes).toBe(1);
  });
});

/**
 * SPEC §4: an unknown template token "warns at load". The workspace only
 * *collects* those warnings, and a load happens in exactly one place — the
 * daemon, at cold start and again on every reload — so that is where they have
 * to be said out loud. Until they were, a one-character typo was discoverable
 * only by spotting the red `{ns@name!}` marker by eye.
 */
describe("config warnings", () => {
  it("says a template typo out loud at load, and again after a reload", async () => {
    const ws = hotWorkspace({ templates: { app: "{gti@branch} {app@name}" } });
    track(ws);
    const logger = recordingLogger("daemon");
    const daemon = createDaemon({ configPath: ws.configPath, logger, idleMs: 0 });
    await daemon.start();

    try {
      expect(logger.warnings.filter((w) => w.includes("{gti@branch}"))).toHaveLength(1);

      const client = createRpcClient({ socketPath: ws.paths.socket, timeoutMs: 5_000 });
      await client.connect();
      ws.rewrite(baseConfig({ templates: { app: "{helth@status} {app@name}" } }));
      expect(await client.request("workspace.reload", {})).toEqual({ ok: true });
      await client.close();

      expect(logger.warnings.some((w) => w.includes("{helth@status}"))).toBe(true);
    } finally {
      await daemon.shutdown("test over");
    }
  });

  /**
   * A `hooks` key in a plugin's namespace cannot be judged when the config is
   * read — the plugin's commands exist only once it has loaded — so it is the
   * daemon that says a name matched nothing, each time the answer could have
   * changed. A name the config layer *can* judge is an error instead, and a
   * reload that introduces one keeps the last-good config.
   */
  it("warns about a hooks entry no loaded command answers to, and rejects a certain typo", async () => {
    const ws = hotWorkspace({ hooks: { "git:pull": { pre: "true" }, "app:stop": { post: "true" } } });
    track(ws);
    const logger = recordingLogger("daemon");
    const daemon = createDaemon({ configPath: ws.configPath, logger, idleMs: 0 });
    await daemon.start();
    const unbound = (): string[] => logger.warnings.filter((w) => w.includes("config: hooks."));

    try {
      // `builtins.git` is off in this fixture, so nothing provides `git:pull`.
      expect(unbound()).toHaveLength(1);
      expect(unbound()[0]).toContain('hooks.git:pull: no command "git:pull" is loaded');
      expect(unbound()[0]).toContain('no loaded plugin is called "git"');

      const client = createRpcClient({ socketPath: ws.paths.socket, timeoutMs: 5_000 });
      await client.connect();
      ws.rewrite(baseConfig({ hooks: { hello: { pre: "true" }, "app:stop": { post: "true" } } }));
      expect(await client.request("workspace.reload", {})).toEqual({ ok: true });
      expect(unbound()).toHaveLength(1);

      ws.rewrite(baseConfig({ hooks: { helo: { pre: "true" } } }));
      const rejected = await client.request("workspace.reload", {});
      await client.close();
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('hooks.helo: unknown command "helo"');
      expect(daemon.snapshot().configError).toContain("hooks.helo");
    } finally {
      await daemon.shutdown("test over");
    }
  });

  it("stays quiet for a config whose templates are clean", async () => {
    const ws = hotWorkspace();
    track(ws);
    const logger = recordingLogger("daemon");
    const daemon = createDaemon({ configPath: ws.configPath, logger, idleMs: 0 });
    await daemon.start();

    try {
      expect(logger.warnings.filter((w) => w.startsWith("daemon config:"))).toEqual([]);
    } finally {
      await daemon.shutdown("test over");
    }
  });
});
