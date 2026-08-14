/**
 * The engine against the *real* supervisor and real child processes.
 *
 * Every other engine test drives a fake supervisor, which is the right seam for
 * ordering, hooks and reporting — but two behaviours are only true if an actual
 * process ends up owned by the daemon: a `kind: "service"` config command
 * (SPEC §2.5) must leave its script running under supervision, and a target the
 * config dropped mid-run (SPEC §8) must still be stoppable. Both are asserted
 * here on live pids.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadWorkspace } from "../../src/config/index.js";
import type { NormalizedWorkspace } from "../../src/config/types.js";
import { emptyPluginHost, type Engine, type Supervisor } from "../../src/daemon/contracts.js";
import { createSupervisor } from "../../src/daemon/supervisor.js";
import { createEngine } from "../../src/engine/index.js";
import type { TaskResult } from "../../src/ipc/protocol.js";
import { nullLogger } from "../../src/util/logger.js";
import type { StatePaths } from "../../src/util/paths.js";
import { delay, settled, statesByTarget, waitFor } from "./helpers.js";

const dirs: string[] = [];
const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of teardown.splice(0)) await stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Touches a marker so a test can tell *which* script won the target's one slot. */
function service(marker: string): string {
  return `printf 'x' > '${marker}'; while true; do sleep 0.05; done`;
}

interface Live {
  dir: string;
  supervisor: Supervisor;
  engine: Engine;
  reload(config: object): void;
  pidOf(id: string): number;
}

/** A workspace on disk driven by a real supervisor and a real engine over it. */
function live(config: (dir: string) => object, subdirs: string[] = []): Live {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-live-")));
  dirs.push(dir);
  for (const rel of subdirs) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  const write = (value: object): void => {
    fs.writeFileSync(path.join(dir, "u8.jsonc"), JSON.stringify(value), "utf8");
  };
  write(config(dir));

  let ws: NormalizedWorkspace = loadWorkspace(dir);
  const stateDir = path.join(dir, ".state");
  const paths: StatePaths = {
    id: ws.id,
    dir: stateDir,
    socket: path.join(stateDir, "daemon.sock"),
    pidFile: path.join(stateDir, "daemon.pid"),
    daemonLog: path.join(stateDir, "daemon.log"),
    stateFile: path.join(stateDir, "state.json"),
    serviceLogDir: path.join(stateDir, "logs", "services"),
    taskLogDir: path.join(stateDir, "logs", "tasks"),
  };
  const workspace = { current: () => ws };
  const supervisor = createSupervisor({
    workspace,
    paths,
    logger: nullLogger,
    timing: { startGraceMs: 60, restartBackoffMs: [20], maxRestartAttempts: 3 },
  });
  const engine = createEngine({
    workspace,
    paths,
    logger: nullLogger,
    supervisor,
    plugins: emptyPluginHost,
    activeProfile: () => ws.defaultProfile,
    readinessPollMs: 20,
  });

  teardown.push(async () => {
    await supervisor.stopAll({ timeoutMs: 1_000 });
  });

  return {
    dir,
    supervisor,
    engine,
    reload(next: object) {
      write(next);
      ws = loadWorkspace(dir);
    },
    pidOf(id: string) {
      const pid = supervisor.state(id).pid;
      if (pid === undefined) throw new Error(`no pid for "${id}" (${supervisor.state(id).status})`);
      return pid;
    },
  };
}

const LIMITS = { stopTimeout: 1_000 };

describe("a kind:\"service\" config command, end to end", () => {
  it("leaves its own script running under the supervisor, and stops with the target", async () => {
    const h = live((dir) => ({
      apps: { svc: { path: ".", scripts: { start: service(path.join(dir, "start.marker")) } } },
      commands: { "start.debug": { kind: "service", script: service(path.join(dir, "debug.marker")) } },
      limits: LIMITS,
    }));

    const result: TaskResult = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(statesByTarget(result)).toEqual({ svc: "ok" });
    await waitFor(() => h.supervisor.state("svc").status === "running", "svc to reach running");
    const pid = h.pidOf("svc");
    expect(pidAlive(pid)).toBe(true);
    // The supervisor owns it — it is in the snapshot every client renders.
    expect(h.supervisor.states().find((s) => s.targetId === "svc")?.status).toBe("running");
    expect(h.supervisor.runningCount()).toBe(1);
    // …running the command's script, never the target's own `start`.
    expect(fs.existsSync(path.join(h.dir, "debug.marker"))).toBe(true);
    expect(fs.existsSync(path.join(h.dir, "start.marker"))).toBe(false);

    const stopped = await settled(h.engine.stopTargets());

    expect(stopped.ok).toBe(true);
    await waitFor(() => !pidAlive(pid), "the supervised process to be reaped");
    expect(h.supervisor.state("svc").status).toBe("stopped");
  });

  it("skips a target the command has no script for, without falling back to start", async () => {
    const h = live((dir) => ({
      apps: {
        api: { path: "api", scripts: { start: service(path.join(dir, "api.marker")) } },
        web: { path: "web", scripts: { start: service(path.join(dir, "web.marker")) } },
      },
      commands: {
        "start.debug": {
          kind: "service",
          targets: { api: service(path.join(dir, "debug.marker")) },
        },
      },
      limits: LIMITS,
    }), ["api", "web"]);

    const result = await settled(h.engine.runCommand({ command: "start.debug" }));

    expect(statesByTarget(result)).toEqual({ api: "ok", web: "skipped" });
    await waitFor(() => h.supervisor.state("api").status === "running", "api to reach running");
    await delay(100);
    expect(h.supervisor.state("web").status).toBe("stopped");
    expect(fs.existsSync(path.join(h.dir, "web.marker"))).toBe(false);
  });
});

describe("a target the config dropped, end to end", () => {
  const both = (dir: string): object => ({
    apps: {
      api: { path: "api", scripts: { start: service(path.join(dir, "api.marker")) } },
      web: { path: "web", scripts: { start: service(path.join(dir, "web.marker")) } },
    },
    profiles: { all: { default: true, targets: ["api", "web"] } },
    limits: LIMITS,
  });
  const apiOnly = (dir: string): object => ({
    apps: { api: { path: "api", scripts: { start: service(path.join(dir, "api.marker")) } } },
    profiles: { all: { default: true, targets: ["api"] } },
    limits: LIMITS,
  });

  it("keeps running until it is stopped by id", async () => {
    const h = live(both, ["api", "web"]);
    await settled(h.engine.startTargets());
    await waitFor(() => h.supervisor.state("web").status === "running", "web to reach running");
    const webPid = h.pidOf("web");
    const apiPid = h.pidOf("api");

    h.reload(apiOnly(h.dir));

    expect(h.supervisor.state("web").status).toBe("running");
    expect(pidAlive(webPid)).toBe(true);

    const result = await settled(h.engine.stopTargets(["web"]));

    expect(result.ok).toBe(true);
    await waitFor(() => !pidAlive(webPid), "the orphaned process to be reaped");
    expect(h.supervisor.state("web").status).toBe("stopped");
    // Untouched: stopping the orphan is not stopping everything.
    expect(pidAlive(apiPid)).toBe(true);
  });

  it("is reaped by a profile-wide stop", async () => {
    const h = live(both, ["api", "web"]);
    await settled(h.engine.startTargets());
    await waitFor(() => h.supervisor.state("web").status === "running", "web to reach running");
    const webPid = h.pidOf("web");

    h.reload(apiOnly(h.dir));
    const result = await settled(h.engine.stopTargets());

    expect(result.ok).toBe(true);
    expect(Object.keys(statesByTarget(result)).sort()).toEqual(["api", "web"]);
    await waitFor(() => !pidAlive(webPid), "the orphaned process to be reaped");
    expect(h.supervisor.runningCount()).toBe(0);
  });
});
