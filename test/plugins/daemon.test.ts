/**
 * The plugin host inside a real daemon: a fixture plugin on disk, loaded by a
 * daemon in its own process, reaching a client over the socket.
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { IndicatorValue } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonLog,
  delay,
  SERVICE_SCRIPT,
  waitFor,
  type Workspace,
} from "../daemon/helpers.js";

afterEach(async () => {
  await cleanup();
});

afterAll(() => {
  cleanupStateHome();
});

/** Contributes to all three surfaces and leaves proof on disk for each. */
const DEMO_PLUGIN = `import { appendFileSync } from "node:fs";
import { join } from "node:path";

const hookLog = join(import.meta.dirname, "..", "hooks.txt");

export default {
  name: "demo",
  setup(ctx) {
    ctx.store.set("targets", ctx.targets.map((t) => t.id).join(","));
  },
  indicators: {
    answer: {
      update: { mode: "poll", intervalMs: 100 },
      value: (ctx) => \`\${ctx.target.id}:\${ctx.store.get("targets")}\`,
    },
  },
  commands: {
    touch: {
      description: "writes a marker in each target's cwd",
      async run(ctx) {
        await ctx.exec("printf '%s' \\"$PWD\\" > marker.txt");
        ctx.log(\`touched \${ctx.target.id}\`);
      },
    },
  },
  hooks: {
    "*": {
      post(ctx) {
        appendFileSync(hookLog, \`\${ctx.command} \${ctx.target.id} \${ctx.result.ok}\\n\`);
      },
    },
  },
  teardown() {
    appendFileSync(join(import.meta.dirname, "..", "teardown.txt"), "torn\\n");
  },
};
`;

const BROKEN_PLUGIN = `throw new Error("this plugin is broken on purpose");\n`;

function pluginWorkspace(extra: Record<string, unknown> = {}): Workspace {
  const ws = createWorkspace(
    {
      builtins: { git: false, health: false },
      plugins: ["./plugins/demo.js", "./plugins/broken.js"],
      repos: { api: { path: "api", scripts: { start: "sleep 30" } } },
      commands: { hello: { script: "printf 'hello\\n'" } },
      ...extra,
    },
    ["api", "plugins"],
  );
  // A `.js` plugin is only ESM if the nearest package.json says so.
  fs.writeFileSync(path.join(ws.dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.writeFileSync(ws.file("plugins/demo.js"), DEMO_PLUGIN, "utf8");
  fs.writeFileSync(ws.file("plugins/broken.js"), BROKEN_PLUGIN, "utf8");
  return ws;
}

function indicator(values: IndicatorValue[], ns: string, name: string): IndicatorValue | undefined {
  return values.find((v) => v.ns === ns && v.name === name);
}

/** Poll-until-present for a value that can only be read with an RPC. */
async function pollFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("plugins in a live daemon", () => {
  it("loads a local plugin and serves what it contributed", async () => {
    const ws = pluginWorkspace();
    const client = await connect(ws);
    const snapshot = await client.request("client.attach", { clientVersion: "test" });

    // Isolation-lite: the broken one is recorded, the daemon serves anyway.
    expect(snapshot.plugins).toEqual([
      { name: "demo", spec: "./plugins/demo.js", ok: true },
      expect.objectContaining({ spec: "./plugins/broken.js", ok: false }),
    ]);
    expect(snapshot.plugins[1]?.error).toContain("broken on purpose");

    const touch = snapshot.commands.find((c) => c.name === "demo:touch");
    expect(touch).toMatchObject({ source: "plugin", kind: "task", appliesTo: ["api"] });
    expect(touch?.description).toBe("writes a marker in each target's cwd");

    // The indicator polls in the daemon and lands in the shared cache — the
    // store proves setup() ran, and that both share one Map.
    const value = await pollFor(async () => {
      const fresh = await client.request("workspace.snapshot", {});
      const cell = indicator(fresh.indicators, "demo", "answer");
      return cell?.value === "api:api" ? cell : undefined;
    }, "the demo@answer indicator to reach a client snapshot");
    expect(value).toMatchObject({ ns: "demo", name: "answer", scope: "app", owner: "api" });
  });

  it("runs a plugin command and fires plugin hooks around a config command", async () => {
    const ws = pluginWorkspace();
    const client = await connect(ws);

    const run = await client.request("command.run", { command: "demo:touch" });
    const result = await client.request("run.await", { runId: run.runId });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(ws.file("api/marker.txt"), "utf8")).toBe(ws.file("api"));

    const hello = await client.request("command.run", { command: "hello" });
    expect((await client.request("run.await", { runId: hello.runId })).ok).toBe(true);

    // The `"*"` binding sees every command, its own included.
    await waitFor(
      () => fs.existsSync(ws.file("hooks.txt")) && fs.readFileSync(ws.file("hooks.txt"), "utf8").includes("hello"),
      "the wildcard post hook to record both runs",
    );
    expect(fs.readFileSync(ws.file("hooks.txt"), "utf8").trim().split("\n")).toEqual([
      "demo:touch api true",
      "hello api true",
    ]);
  });

  /**
   * The top-level `hooks` map against real plugins: a name is only knowable
   * once they have loaded, so this is the one place both halves show — the
   * shell hook that runs around a plugin's command, and the entry written for
   * a command nothing ended up providing.
   */
  it("runs config hooks around plugin and core commands, and warns about the ones nothing provides", async () => {
    const record = 'printf "%s %s %s\\n" "$U8_COMMAND" "$U8_TARGET" "$U8_STATUS" >> ../shell-hooks.txt';
    const ws = pluginWorkspace({
      hooks: {
        "demo:touch": { pre: "test ! -f marker.txt", post: record },
        "app:stop": { post: record },
        "demo:tuch": { post: record },
        // Its plugin throws at import: disabled and reported, never fatal —
        // and the hooks written for it must not be what stops the daemon.
        "broken:deploy": { post: record },
      },
    });
    const client = await connect(ws);
    const run = async (command: string): Promise<boolean> => {
      const { runId } = await client.request("command.run", { command });
      return (await client.request("run.await", { runId })).ok;
    };

    expect(await run("demo:touch")).toBe(true);
    // The pre hook is a gate here too: the marker the first run left refuses the second.
    expect(await run("demo:touch")).toBe(false);
    expect(await run("app:start")).toBe(true);
    expect(await run("app:stop")).toBe(true);

    expect(fs.readFileSync(ws.file("shell-hooks.txt"), "utf8").trim().split("\n")).toEqual([
      "demo:touch api ok",
      "demo:touch api aborted",
      "app:stop api ok",
    ]);

    const warnings = daemonLog(ws)
      .split("\n")
      .filter((line) => line.includes("config: hooks."));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(
      'hooks.demo:tuch: no command "demo:tuch" is loaded, so these hooks never run ' +
        '("demo" has no command by that name — expected one of: demo:touch)',
    );
    expect(warnings[1]).toContain('hooks.broken:deploy: no command "broken:deploy" is loaded');
  });

  /**
   * The whole options path, end to end and nothing stubbed: JSONC → normalized
   * `PluginRef.options` → the module's factory → an indicator whose value could
   * only have come from what the user wrote in `u8.jsonc`.
   */
  it("builds a factory plugin from the options in u8.jsonc", async () => {
    const ws = createWorkspace(
      {
        builtins: { git: false, health: false },
        plugins: [
          { spec: "./plugins/shared.js", options: { packages: ["@myorg/protos", "@myorg/react-query"] } },
        ],
        repos: { api: { path: "api", scripts: { start: "sleep 30" } } },
      },
      ["api", "plugins"],
    );
    fs.writeFileSync(path.join(ws.dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    fs.writeFileSync(
      ws.file("plugins/shared.js"),
      `export default (options) => ({
         name: "shared",
         indicators: {
           packages: {
             update: { mode: "poll", intervalMs: 100 },
             value: () => options.packages.join(" "),
           },
         },
       });\n`,
      "utf8",
    );

    const client = await connect(ws);
    const snapshot = await client.request("client.attach", { clientVersion: "test" });
    expect(snapshot.plugins).toEqual([{ name: "shared", spec: "./plugins/shared.js", ok: true }]);

    const cell = await pollFor(async () => {
      const fresh = await client.request("workspace.snapshot", {});
      return indicator(fresh.indicators, "shared", "packages");
    }, "the configured indicator to reach a client snapshot");
    expect(cell?.value).toBe("@myorg/protos @myorg/react-query");
  });

  /**
   * The daemon owns the host's lifecycle at both ends. Nothing else would notice
   * if `dispose()` fell out of the shutdown sequence: a plugin's watchers and
   * children would simply ride the process down, or outlive it.
   */
  it("tears its plugins down when it stops", async () => {
    const ws = pluginWorkspace();
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    expect(fs.existsSync(ws.file("teardown.txt"))).toBe(false);

    await client.request("daemon.stop", {});
    await waitFor(() => fs.existsSync(ws.file("teardown.txt")), "the plugin teardown to run");
    expect(fs.readFileSync(ws.file("teardown.txt"), "utf8").trim()).toBe("torn");
  });
});

/**
 * The other half of the plugin host in a daemon: the built-ins, which are
 * *constructed* from what the workspace configured plus the daemon's own state.
 * Nothing between the config file and the client's snapshot is stubbed here.
 */
describe("a configured built-in in a live daemon", () => {
  it("loads only what the workspace enabled, and serves its indicator", async () => {
    const ws = createWorkspace(
      {
        builtins: { git: false, health: true },
        repos: {
          api: {
            path: "api",
            scripts: { start: SERVICE_SCRIPT },
            health: { cmd: "true", interval: 200, timeout: 1_000, threshold: 1 },
          },
        },
        profiles: { all: { default: true, targets: ["api"] } },
      },
      ["api"],
    );

    const client = await connect(ws);
    const snapshot = await client.request("client.attach", { clientVersion: "test" });
    // Every other built-in ships with u8cli and is switched off here: an
    // unconfigured one is never loaded, so it never even earns a record.
    expect(snapshot.plugins).toEqual([{ name: "health", spec: "builtin:health", ok: true }]);

    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    const cell = await pollFor(async () => {
      const fresh = await client.request("workspace.snapshot", {});
      const value = indicator(fresh.indicators, "health", "status");
      return value?.value === "healthy" ? value : undefined;
    }, "the health@status cell to reach a client snapshot");
    expect(cell).toMatchObject({ ns: "health", name: "status", scope: "app", owner: "api" });
  });
});

/**
 * SPEC §7.2: `health@status` is `n/a` when the process is not running, and
 * probes run *only* while it runs. A crash is the case no plugin-SDK callback
 * reports — no command ran, so no hook fires — so this holds only if the daemon
 * builds the built-in with its supervisor.
 */
describe("the health built-in inside a daemon", () => {
  it("parks a crashed service at n/a and stops probing it", async () => {
    const ws = createWorkspace(
      (dir) => ({
        builtins: { git: false },
        repos: {
          api: {
            path: "api",
            // Long enough to survive the start grace, then it dies on its own.
            scripts: { start: "printf 'ready\\n'; sleep 1; exit 3" },
            // A probe that always succeeds *and* counts itself: after the crash
            // the verdict must change because the process is gone, not because
            // the check started failing.
            health: {
              cmd: `printf 'p\\n' >> ${path.join(dir, "probes.txt")}`,
              interval: 200,
              timeout: 1_000,
              threshold: 1,
            },
          },
        },
        profiles: { all: { default: true, targets: ["api"] } },
      }),
      ["api"],
    );
    /** One line per probe, so the file's line count is how often it ran. */
    const probes = (): number => {
      if (!fs.existsSync(ws.file("probes.txt"))) return 0;
      return fs.readFileSync(ws.file("probes.txt"), "utf8").split("\n").filter((l) => l.length > 0).length;
    };

    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });
    const health = async (): Promise<string | undefined> => {
      const snapshot = await client.request("workspace.snapshot", {});
      return indicator(snapshot.indicators, "health", "status")?.value;
    };
    const status = async (): Promise<string | undefined> => {
      const snapshot = await client.request("workspace.snapshot", {});
      return snapshot.services.find((s) => s.targetId === "api")?.status;
    };

    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    await pollFor(async () => ((await health()) === "healthy" ? true : undefined), "health to go healthy");
    expect(probes()).toBeGreaterThan(0);

    await pollFor(async () => ((await status()) === "crashed" ? true : undefined), "api to crash on its own");
    await pollFor(async () => ((await health()) === "n/a" ? true : undefined), "health to go n/a after the crash");

    // Whatever was already in flight when the monitor disarmed has landed by now.
    await delay(200);
    const settled = probes();
    await delay(1_000); // five probe intervals
    expect(probes(), "probes kept firing at a process that is gone").toBe(settled);
  });
});
