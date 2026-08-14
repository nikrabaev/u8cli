/**
 * The client half of the daemon contract: `attach` owns the state the IPC layer
 * deliberately does not replay — the attach itself and every log subscription.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { attach } from "../../src/daemon/launch.js";
import type { LogLine, Snapshot } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
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
    apps: { api: { path: "api", scripts: { start: SERVICE_SCRIPT } } },
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

  it("re-attaches and re-subscribes after the daemon goes away", async () => {
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

      await attached.client.request("daemon.stop", {});
      expect(await waitForPidGone(firstPid ?? 0, 5_000)).toBe(true);

      // The client sees the socket drop and brings a daemon back on its own.
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
});
