/**
 * The properties that only show up under stress: a client that cannot keep up
 * with a chatty service, an idle timer racing an in-flight run, and two clients
 * cold-starting the same workspace at once.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ensureDaemon } from "../../src/daemon/launch.js";
import type { LogLine } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonPid,
  delay,
  pidAlive,
  SERVICE_SCRIPT,
  track,
  waitFor,
  waitForPidGone,
} from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

afterAll(() => {
  cleanupStateHome();
});

/**
 * Emits ~1.3 MB in one burst — far past a connection's per-window budget — then
 * goes quiet long enough for the window to roll before writing one more line,
 * which is what makes the daemon report the tally it dropped.
 */
const FLOOD_LINES = 6_000;
const FLOOD_SCRIPT =
  `awk 'BEGIN{for(i=0;i<${FLOOD_LINES};i++) printf "%d %s\\n", i, "` +
  "x".repeat(100) +
  `"}'; sleep 1.3; printf 'tail\\n'; while true; do sleep 0.05; done`;

describe("log firehose", () => {
  it("drops and reports log lines rather than growing without bound", async () => {
    const ws = createWorkspace(
      {
        repos: { noisy: { path: "noisy", scripts: { start: FLOOD_SCRIPT } } },
        profiles: { all: { default: true, targets: ["noisy"] } },
      },
      ["noisy"],
    );
    const client = await connect(ws);
    await client.request("client.attach", { clientVersion: "test" });

    const lines: LogLine[] = [];
    client.on("log.line", (p) => lines.push(p.line));
    await client.request("logs.subscribe", { targetId: "noisy" });

    const run = await client.request("service.start", {});
    await client.request("run.await", { runId: run.runId });

    await waitFor(
      () => lines.some((l) => l.stream === "u8" && l.text.includes("throttled")),
      "the throttle notice",
      10_000,
    );
    // The stream has a hole in it, and the client was told so.
    expect(lines.filter((l) => l.stream === "stdout").length).toBeLessThan(FLOOD_LINES);

    await waitFor(
      () => lines.some((l) => l.stream === "u8" && /dropped \d+ log lines?/.test(l.text)),
      "the drop tally once the window rolled",
      10_000,
    );

    // Nothing was lost on disk — the cap is a push budget, not a log policy.
    const backfill = await client.request("logs.read", { targetId: "noisy", lines: 5_000 });
    expect(backfill.lines.length).toBe(5_000);
  });
});

describe("idle exit", () => {
  it("waits for an in-flight run even with no clients left", async () => {
    const ws = createWorkspace(
      {
        repos: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } },
        profiles: { all: { default: true, targets: ["api"] } },
        commands: { slow: { script: "sleep 1.5" } },
      },
      ["api"],
    );
    const client = await connect(ws, { idleMs: 300 });
    await client.request("client.attach", { clientVersion: "test" });
    const pid = daemonPid(ws);
    expect(pid).toBeDefined();

    await client.request("command.run", { command: "slow", targets: ["api"] });
    await client.close();

    // Two idle windows into a run that is still going: exiting here would kill
    // the work a fire-and-forget client asked for.
    await delay(900);
    expect(pidAlive(pid ?? 0)).toBe(true);

    // ...and once it finishes, the daemon is idle again and goes away.
    expect(await waitForPidGone(pid ?? 0, 5_000)).toBe(true);
  });
});

describe("concurrent cold start", () => {
  it("two clients starting at once converge on one daemon", async () => {
    const ws = createWorkspace(
      { repos: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } } },
      ["api"],
    );
    track(ws);

    const [a, b] = await Promise.all([
      ensureDaemon({ configPath: ws.configPath, timeoutMs: 15_000, env: { U8_IDLE_MS: "20000" } }),
      ensureDaemon({ configPath: ws.configPath, timeoutMs: 15_000, env: { U8_IDLE_MS: "20000" } }),
    ]);

    try {
      const [first, second] = await Promise.all([
        a.request("daemon.status", {}),
        b.request("daemon.status", {}),
      ]);
      expect(second.pid).toBe(first.pid);
      expect(first.pid).toBe(daemonPid(ws));
      expect(first.clients).toBeGreaterThanOrEqual(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
