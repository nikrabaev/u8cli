/**
 * The client half of the daemon contract: `attach` owns the state the IPC layer
 * deliberately does not replay — the attach itself and every log subscription —
 * and the judgement the transport cannot make, which is whether a dropped
 * connection is a daemon to bring back or a daemon somebody just stopped.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { attach, pingDaemon } from "../../src/daemon/launch.js";
import type { LogLine, Snapshot } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonPid,
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

function oneService(): Record<string, unknown> {
  return {
    repos: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } },
    profiles: { all: { default: true, targets: ["api"] } },
  };
}

describe("attach", () => {
  it("spawns the daemon, attaches, and streams what it subscribed to", async () => {
    const ws = createWorkspace(oneService(), ["api"]);
    track(ws);

    const attached = await attach({
      configPath: ws.configPath,
      subscribe: ["api"],
      env: { U8_IDLE_MS: "20000" },
    });
    try {
      expect(attached.snapshot().workspace.configPath).toBe(ws.configPath);
      expect(attached.snapshot().activeProfile).toBe("all");

      const lines: LogLine[] = [];
      attached.on("log.line", (p) => lines.push(p.line));

      const run = await attached.client.request("service.start", {});
      await attached.client.request("run.await", { runId: run.runId });

      await waitFor(() => lines.some((l) => l.text.includes("ready")), "the subscribed log stream");
    } finally {
      await attached.close();
    }
  });

  it("re-attaches and re-subscribes after the daemon dies", async () => {
    const ws = createWorkspace(oneService(), ["api"]);
    track(ws);

    const attached = await attach({
      configPath: ws.configPath,
      subscribe: ["api"],
      env: { U8_IDLE_MS: "20000" },
    });
    try {
      const reattached: Snapshot[] = [];
      attached.onReattach((snapshot) => reattached.push(snapshot));
      const lost: Error[] = [];
      attached.onLost((err) => lost.push(err));

      const firstPid = daemonPid(ws);
      expect(firstPid).toBeDefined();

      // A crash, not a shutdown: nobody announced it, so the workspace is left
      // without a daemon it still needs and the client brings one back.
      process.kill(firstPid ?? 0, "SIGKILL");
      expect(await waitForPidGone(firstPid ?? 0, 5_000)).toBe(true);

      await waitFor(() => reattached.length === 1, "the re-attach", 15_000);
      expect(lost).toEqual([]);
      const secondPid = daemonPid(ws);
      expect(secondPid).toBeDefined();
      expect(secondPid).not.toBe(firstPid);
      expect(attached.snapshot().workspace.id).toBe(ws.paths.id);

      // The subscription was re-sent: the new daemon streams without being asked.
      const lines: LogLine[] = [];
      attached.on("log.line", (p) => lines.push(p.line));
      const run = await attached.client.request("service.start", {});
      await attached.client.request("run.await", { runId: run.runId });

      await waitFor(() => lines.some((l) => l.text.includes("ready")), "the re-subscribed stream");
    } finally {
      await attached.close();
    }
  });

  it("never brings back a daemon that was deliberately stopped", async () => {
    const ws = createWorkspace(oneService(), ["api"]);
    track(ws);

    const attached = await attach({
      configPath: ws.configPath,
      subscribe: ["api"],
      env: { U8_IDLE_MS: "20000" },
    });
    try {
      const reattached: Snapshot[] = [];
      attached.onReattach((snapshot) => reattached.push(snapshot));
      const lost: Error[] = [];
      attached.onLost((err) => lost.push(err));

      const firstPid = daemonPid(ws);
      expect(firstPid).toBeDefined();

      // What `u8 daemon stop` does. The daemon announces it before closing, so
      // recovery must not undo the very thing the user asked for.
      await attached.client.request("daemon.stop", {});
      expect(await waitForPidGone(firstPid ?? 0, 5_000)).toBe(true);

      await waitFor(() => lost.length === 1, "the client to give up instead of respawning", 15_000);
      expect(reattached).toEqual([]);
      expect(await pingDaemon(ws.paths.socket, 500)).toBeUndefined();
      expect(daemonPid(ws)).toBeUndefined();
    } finally {
      await attached.close();
    }
  });

  it("re-attaches to a daemon someone else starts after a deliberate stop", async () => {
    const ws = createWorkspace(oneService(), ["api"]);
    track(ws);

    const attached = await attach({
      configPath: ws.configPath,
      subscribe: ["api"],
      env: { U8_IDLE_MS: "20000" },
      // The connect-only window has to outlast someone else's cold start.
      reattachAttempts: 40,
    });
    try {
      const reattached: Snapshot[] = [];
      attached.onReattach((snapshot) => reattached.push(snapshot));
      const lost: Error[] = [];
      attached.onLost((err) => lost.push(err));

      const firstPid = daemonPid(ws);
      await attached.client.request("daemon.stop", {});
      expect(await waitForPidGone(firstPid ?? 0, 5_000)).toBe(true);

      // The next `u8 status` in another terminal, from the client's point of view.
      await connect(ws, { idleMs: 20_000 });
      await waitFor(() => reattached.length === 1, "the re-attach to the new daemon", 20_000);
      expect(lost).toEqual([]);

      // And the stop is spent: the next drop is a crash again, which is a daemon
      // worth spawning.
      const secondPid = daemonPid(ws);
      expect(secondPid).toBeDefined();
      process.kill(secondPid ?? 0, "SIGKILL");
      expect(await waitForPidGone(secondPid ?? 0, 5_000)).toBe(true);

      await waitFor(() => reattached.length === 2, "a respawn after the crash", 20_000);
      expect(daemonPid(ws)).toBeDefined();
      expect(daemonPid(ws)).not.toBe(secondPid);
    } finally {
      await attached.close();
    }
  });
});
