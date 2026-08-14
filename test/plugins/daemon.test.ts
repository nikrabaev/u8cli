/**
 * The plugin host inside a real daemon: a fixture plugin on disk, loaded by a
 * daemon in its own process, reaching a client over the socket.
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { IndicatorValue } from "../../src/ipc/protocol.js";
import { cleanup, cleanupStateHome, connect, createWorkspace, waitFor, type Workspace } from "../daemon/helpers.js";

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

function pluginWorkspace(): Workspace {
  const ws = createWorkspace(
    {
      builtins: { git: false, health: false },
      plugins: ["./plugins/demo.js", "./plugins/broken.js"],
      apps: { api: { path: "api", scripts: { start: "sleep 30" } } },
      commands: { hello: { script: "printf 'hello\\n'" } },
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
    expect(value).toMatchObject({ ns: "demo", name: "answer", scope: "subapp", owner: "api" });
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
