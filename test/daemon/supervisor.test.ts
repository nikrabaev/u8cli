import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadWorkspaceFrom } from "../../src/config/index.js";
import type { NormalizedWorkspace } from "../../src/config/types.js";
import type { Supervisor, WorkspaceHolder } from "../../src/daemon/contracts.js";
import {
  createSupervisor,
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  START_GRACE_MS,
  type SupervisorTiming,
} from "../../src/daemon/supervisor.js";
import type { LogLine, ServiceState, ServiceStatus } from "../../src/ipc/protocol.js";
import { serviceLogPath } from "../../src/process/index.js";
import { U8Error } from "../../src/util/errors.js";
import { nullLogger } from "../../src/util/logger.js";
import { statePaths, type StatePaths } from "../../src/util/paths.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Git file modes are not trustworthy across checkouts; set the bit ourselves. */
async function makeScriptsExecutable(): Promise<void> {
  for (const name of await readdir(FIXTURES)) await chmod(path.join(FIXTURES, name), 0o755);
}

/** Absolute, shell-quoted invocation of a fixture script. */
function fixture(name: string, ...args: string[]): string {
  return [path.join(FIXTURES, name), ...args].map((a) => `'${a}'`).join(" ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(10);
  }
  return !pidAlive(pid);
}

/** Only *ref'd* timers appear here, which is exactly what "holds the loop open" means. */
function refdTimerCount(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

// ---------------------------------------------------------------------------
// Harness: a real workspace on disk, a hand-built holder, a real supervisor.
// ---------------------------------------------------------------------------

type ConfigBuilder = (dir: string) => Record<string, unknown>;

interface Harness {
  dir: string;
  paths: StatePaths;
  sup: Supervisor;
  /** Every `onChange` payload, in order. */
  changes: ServiceState[];
  /** Every `onLog` payload, in order. */
  logs: LogLine[];
  statuses(id: string): ServiceStatus[];
  u8Lines(id: string): string[];
  /** Rewrites `u8.jsonc` and swaps what the holder hands out — a config reload. */
  reload(build: ConfigBuilder): Promise<void>;
}

/**
 * Healthy-path timings: only the wait for `running` is shortened, since the
 * production backoff ladder starts at a second and no test can sit through it.
 */
const FAST: Partial<SupervisorTiming> = {
  startGraceMs: 80,
  restartBackoffMs: [20],
  maxRestartAttempts: 5,
};

/**
 * Crash-path timings keep the *real* grace: a fork + shell + exec + exit round
 * trip takes tens of milliseconds, so a shortened grace would race it and the
 * "died inside the grace" case would stop being the case under test.
 */
function crashTiming(over: Partial<SupervisorTiming> = {}): Partial<SupervisorTiming> {
  return { startGraceMs: START_GRACE_MS, restartBackoffMs: [20], maxRestartAttempts: 5, ...over };
}

const cleanups: Array<() => Promise<void>> = [];
let stateHome: string;

beforeAll(async () => {
  await makeScriptsExecutable();
  stateHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "u8-sup-state-")));
  process.env.U8_STATE_HOME = stateHome;
});

afterAll(async () => {
  delete process.env.U8_STATE_HOME;
  await rm(stateHome, { recursive: true, force: true });
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function harness(build: ConfigBuilder, timing: Partial<SupervisorTiming> = FAST): Promise<Harness> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "u8-sup-")));
  const configPath = path.join(dir, "u8.jsonc");
  await writeFile(configPath, JSON.stringify(build(dir)), "utf8");

  let ws: NormalizedWorkspace = loadWorkspaceFrom(configPath);
  const workspace: WorkspaceHolder = { current: () => ws };
  const paths = statePaths(configPath);
  const sup = createSupervisor({ workspace, paths, logger: nullLogger, timing });

  const changes: ServiceState[] = [];
  const logs: LogLine[] = [];
  sup.onChange((s) => changes.push(s));
  sup.onLog((l) => logs.push(l));

  cleanups.push(async () => {
    await sup.stopAll({ timeoutMs: 500 });
    await rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    paths,
    sup,
    changes,
    logs,
    statuses: (id) => changes.filter((c) => c.targetId === id).map((c) => c.status),
    u8Lines: (id) => logs.filter((l) => l.targetId === id && l.stream === "u8").map((l) => l.text),
    reload: async (next) => {
      await writeFile(configPath, JSON.stringify(next(dir)), "utf8");
      ws = loadWorkspaceFrom(configPath);
    },
  };
}

const oneService: ConfigBuilder = () => ({
  apps: { svc: { path: ".", scripts: { start: fixture("service.sh") } } },
  limits: { stopTimeout: 1_000 },
});

async function startAndWaitRunning(h: Harness, id: string): Promise<number> {
  const state = await h.sup.start(id);
  await waitFor(() => h.sup.state(id).status === "running", `${id} running`);
  expect(state.pid).toBeGreaterThan(0);
  return state.pid ?? -1;
}

// ---------------------------------------------------------------------------

describe("backoff ladder", () => {
  it("matches the spec: 1s → 30s, capped, giving up after 10 attempts", () => {
    expect(START_GRACE_MS).toBe(500);
    expect(MAX_RESTART_ATTEMPTS).toBe(10);
    expect(RESTART_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect([1, 2, 3, 4, 5, 6, 7, 40].map((n) => restartDelayMs(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    // Defensive clamp: an attempt counter can only ever be 1-based.
    expect(restartDelayMs(0)).toBe(1_000);
  });
});

describe("supervisor lifecycle", () => {
  it("walks starting → running → stopping → stopped and reaps the process", async () => {
    const h = await harness(oneService);

    const started = await h.sup.start("svc");
    expect(started.status).toBe("starting");
    expect(started.startedAt).toBeGreaterThan(0);
    const pid = started.pid ?? -1;

    await waitFor(() => h.sup.state("svc").status === "running", "running");
    expect(h.sup.isRunning("svc")).toBe(true);
    expect(h.sup.runningCount()).toBe(1);

    const stopped = await h.sup.stop("svc");

    expect(stopped.status).toBe("stopped");
    expect(stopped.signal).toBe("SIGTERM");
    expect(stopped.restartAttempts).toBe(0);
    expect(await waitForPidGone(pid)).toBe(true);
    expect(h.statuses("svc")).toEqual(["starting", "running", "stopping", "stopped"]);
    expect(h.sup.runningCount()).toBe(0);
  });

  it("reports every target as stopped before anything is started", async () => {
    const h = await harness(() => ({
      apps: {
        one: { path: ".", scripts: { start: fixture("service.sh") } },
        two: { path: ".", subapps: { a: {}, b: {} } },
      },
    }));

    expect(h.sup.states().map((s) => s.targetId)).toEqual(["one", "two.a", "two.b"]);
    expect(h.sup.states().every((s) => s.status === "stopped" && s.restartAttempts === 0)).toBe(true);
    expect(h.sup.isRunning("one")).toBe(false);
    expect(h.sup.runningCount()).toBe(0);
    expect(h.sup.state("nope").status).toBe("stopped");
  });

  it("starting an already-running target is a no-op unless forced", async () => {
    const h = await harness(oneService);
    const pid = await startAndWaitRunning(h, "svc");

    const again = await h.sup.start("svc");

    expect(again.pid).toBe(pid);
    expect(again.status).toBe("running");
    expect(h.u8Lines("svc").filter((l) => l.startsWith("spawned pid=")).length).toBe(1);
  });

  it("restart replaces the process and re-enters starting", async () => {
    const h = await harness(oneService);
    const first = await startAndWaitRunning(h, "svc");

    const restarted = await h.sup.restart("svc");

    expect(restarted.status).toBe("starting");
    expect(restarted.pid).not.toBe(first);
    expect(await waitForPidGone(first)).toBe(true);
    expect(h.statuses("svc")).toEqual(["starting", "running", "stopping", "stopped", "starting"]);
  });

  it("gives the child the daemon env merged with the subapp env, in the subapp cwd", async () => {
    const h = await harness(() => ({
      apps: {
        envy: {
          path: ".",
          env: { U8_FROM_CONFIG: "yes" },
          scripts: {
            start: `printf '%s|%s|%s\\n' "$U8_FROM_CONFIG" "\${PATH:+has-path}" "$(pwd -P)"; sleep 5`,
          },
        },
      },
    }));

    await h.sup.start("envy");
    await waitFor(() => h.logs.some((l) => l.stream === "stdout"), "first output line");

    const line = h.logs.find((l) => l.stream === "stdout")?.text;
    expect(line).toBe(`yes|has-path|${h.dir}`);
  });

  it("throws PROCESS_FAILED for a target with no start script", async () => {
    const h = await harness(() => ({ apps: { nostart: { path: "." } } }));

    const err = await h.sup.start("nostart").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(U8Error);
    expect((err as U8Error).code).toBe("PROCESS_FAILED");
    expect((err as Error).message).toContain("nostart");
    expect(h.sup.state("nostart").status).toBe("stopped");

    const unknown = await h.sup.start("ghost").catch((e: unknown) => e);
    expect((unknown as U8Error).code).toBe("UNKNOWN_TARGET");
  });

  it("never reports a target the workspace does not have and that owns nothing", async () => {
    const h = await harness(oneService);

    // Both create tracking entries: `start` before it validates the target,
    // `stop` because it accepts any id by design.
    await h.sup.start("ghost").catch(() => undefined);
    await h.sup.stop("typo.subapp");

    expect(h.sup.states().map((s) => s.targetId)).toEqual(["svc"]);
  });

  it("keeps reporting a running target the config dropped, until it settles", async () => {
    const h = await harness(oneService);
    await startAndWaitRunning(h, "svc");

    await h.reload(() => ({ apps: { other: { path: ".", scripts: { start: fixture("service.sh") } } } }));

    expect(h.sup.states().map((s) => [s.targetId, s.status])).toEqual([
      ["other", "stopped"],
      ["svc", "running"],
    ]);

    await h.sup.stop("svc");

    expect(h.sup.states().map((s) => s.targetId)).toEqual(["other"]);
  });
});

/**
 * `start` resolves while the process is still inside its grace, so on its own it
 * cannot say whether the start worked. `waitForSettled` is what turns "spawned"
 * into the verdict SPEC §2.5 asks for: a service is done when it is *running*.
 */
describe("waitForSettled", () => {
  it("resolves as crashed for a process that dies inside the grace", async () => {
    const h = await harness(
      () => ({ apps: { boom: { path: ".", scripts: { start: fixture("crash-now.sh") } } } }),
      crashTiming(),
    );

    const spawned = await h.sup.start("boom");
    expect(spawned.status).toBe("starting");
    const settledState = await h.sup.waitForSettled("boom");

    expect(settledState.status).toBe("crashed");
    expect(settledState.exitCode).toBe(3);
    expect(settledState.lastError).toContain("code 3");
    expect(h.statuses("boom")).toEqual(["starting", "crashed"]);
  });

  it("resolves as running once the grace elapses", async () => {
    const h = await harness(oneService);

    const spawned = await h.sup.start("svc");
    expect(spawned.status).toBe("starting");
    const settledState = await h.sup.waitForSettled("svc");

    expect(settledState.status).toBe("running");
    expect(settledState.pid).toBe(spawned.pid);
    expect(h.sup.state("svc").status).toBe("running");
  });

  it("resolves as stopped when the target is stopped before it settled", async () => {
    const h = await harness(oneService, { ...FAST, startGraceMs: 5_000 });

    await h.sup.start("svc");
    const pending = h.sup.waitForSettled("svc");
    await h.sup.stop("svc");

    expect((await pending).status).toBe("stopped");
  });

  it("resolves at once for a target that is not starting", async () => {
    const h = await harness(oneService);

    expect((await h.sup.waitForSettled("svc")).status).toBe("stopped");
    expect((await h.sup.waitForSettled("never-heard-of-it")).status).toBe("stopped");

    await startAndWaitRunning(h, "svc");
    expect((await h.sup.waitForSettled("svc")).status).toBe("running");
  });
});

describe("crash handling", () => {
  it("reports a crash inside the start grace, never passing through running", async () => {
    const h = await harness(
      () => ({ apps: { boom: { path: ".", scripts: { start: fixture("crash-now.sh") } } } }),
      crashTiming(),
    );

    await h.sup.start("boom");
    await waitFor(() => h.sup.state("boom").status === "crashed", "crash");

    const state = h.sup.state("boom");
    expect(state.exitCode).toBe(3);
    expect(state.signal).toBe(null);
    expect(state.pid).toBeUndefined();
    expect(state.lastError).toContain("code 3");
    expect(state.restartAttempts).toBe(0); // restart policy defaults to none
    expect(h.statuses("boom")).toEqual(["starting", "crashed"]);
    expect(h.u8Lines("boom")).toContain("exited code=3");

    await delay(100); // default restart policy: nothing may resurrect it
    expect(h.sup.state("boom").status).toBe("crashed");
    expect(h.u8Lines("boom").filter((l) => l.startsWith("spawned pid=")).length).toBe(1);
  });

  it("detects a crash after the process reached running, and restarts it", async () => {
    const h = await harness(
      (dir) => ({
        apps: {
          later: {
            path: ".",
            restart: "on-crash",
            scripts: {
              // Survives the grace, dies once, then stays up: the ordinary
              // "healthy service falls over hours later" case.
              start: `n=$(( $(cat '${path.join(dir, "runs")}' 2>/dev/null || echo 0) + 1 )); printf '%s\\n' "$n" > '${path.join(dir, "runs")}'; printf 'up %s\\n' "$n"; if [ "$n" -le 1 ]; then sleep 0.25; exit 5; fi; while true; do sleep 0.05; done`,
            },
          },
        },
      }),
      { startGraceMs: 80, restartBackoffMs: [20], maxRestartAttempts: 5 },
    );

    await h.sup.start("later");
    await waitFor(() => h.sup.state("later").status === "crashed", "crash after running");

    expect(h.sup.state("later").exitCode).toBe(5);
    expect(h.sup.state("later").restartAttempts).toBe(1);

    await waitFor(() => h.sup.state("later").status === "running", "healthy again");

    expect(h.statuses("later")).toEqual(["starting", "running", "crashed", "starting", "running"]);
    expect(h.sup.state("later").restartAttempts).toBe(0);
    expect(h.u8Lines("later")).toContain("exited code=5");
  });

  it("restarts on-crash with backoff and resets the counter after a healthy run", async () => {
    const h = await harness(
      (dir) => ({
        apps: {
          flappy: {
            path: ".",
            restart: "on-crash",
            scripts: { start: fixture("crash-until.sh", path.join(dir, "count"), "2") },
          },
        },
      }),
      crashTiming({ restartBackoffMs: [20, 40] }),
    );

    await h.sup.start("flappy");
    await waitFor(() => h.sup.state("flappy").status === "running", "healthy run after two crashes");

    expect(h.statuses("flappy")).toEqual([
      "starting",
      "crashed",
      "starting",
      "crashed",
      "starting",
      "running",
    ]);
    const attempts = h.changes.filter((c) => c.targetId === "flappy").map((c) => c.restartAttempts);
    expect(Math.max(...attempts)).toBe(2);
    // Surviving the grace clears the consecutive-failure count.
    expect(h.sup.state("flappy").restartAttempts).toBe(0);
    expect(h.u8Lines("flappy").filter((l) => /^restarting in \d+ms \(attempt \d\/5\)$/.test(l))).toHaveLength(2);
    expect(readFileSync(path.join(h.dir, "count"), "utf8").trim()).toBe("3");
  });

  it("gives up after the attempt cap and stays crashed", async () => {
    const h = await harness(
      () => ({ apps: { doomed: { path: ".", restart: "on-crash", scripts: { start: fixture("crash-now.sh") } } } }),
      crashTiming({ restartBackoffMs: [15], maxRestartAttempts: 3 }),
    );

    await h.sup.start("doomed");
    await waitFor(() => (h.sup.state("doomed").lastError ?? "").includes("gave up"), "give-up");

    const state = h.sup.state("doomed");
    expect(state.status).toBe("crashed");
    expect(state.restartAttempts).toBe(3);
    expect(state.lastError).toContain("gave up after 3 restart attempts");
    expect(state.lastError).toContain("code 3");
    expect(h.u8Lines("doomed")).toContain("gave up after 3 attempts");
    expect(h.u8Lines("doomed").filter((l) => l.startsWith("spawned pid=")).length).toBe(4); // 1 + 3 retries

    await delay(80); // longer than another backoff would take
    expect(h.u8Lines("doomed").filter((l) => l.startsWith("spawned pid=")).length).toBe(4);
  });

  it("cancels a pending restart when the target is stopped, and holds no ref'd timer", async () => {
    const h = await harness(
      () => ({ apps: { flaky: { path: ".", restart: "on-crash", scripts: { start: fixture("crash-now.sh") } } } }),
      crashTiming({ restartBackoffMs: [250] }),
    );
    const baselineTimers = refdTimerCount();

    await h.sup.start("flaky");
    await waitFor(() => h.sup.state("flaky").restartAttempts === 1, "scheduled restart");

    // The backoff must not be the reason a daemon with nothing to do stays alive.
    expect(refdTimerCount()).toBeLessThanOrEqual(baselineTimers);

    const stopped = await h.sup.stop("flaky");
    expect(stopped.status).toBe("stopped");
    expect(stopped.restartAttempts).toBe(0);

    await delay(350); // past the cancelled backoff
    expect(h.sup.state("flaky").status).toBe("stopped");
    expect(h.u8Lines("flaky").filter((l) => l.startsWith("spawned pid=")).length).toBe(1);
    expect(refdTimerCount()).toBeLessThanOrEqual(baselineTimers);
  });

  it("starting by hand after a give-up resets the attempt counter", async () => {
    const h = await harness(
      (dir) => ({
        apps: {
          flappy: {
            path: ".",
            restart: "on-crash",
            scripts: { start: fixture("crash-until.sh", path.join(dir, "count"), "2") },
          },
        },
      }),
      crashTiming({ restartBackoffMs: [10], maxRestartAttempts: 1 }),
    );

    await h.sup.start("flappy");
    await waitFor(() => (h.sup.state("flappy").lastError ?? "").includes("gave up"), "give-up");

    const restarted = await h.sup.start("flappy", { force: true });

    expect(restarted.restartAttempts).toBe(0);
    await waitFor(() => h.sup.state("flappy").status === "running", "healthy after manual start");
  });
});

describe("stopping", () => {
  it("runs a custom stop script and still reaps a group it failed to kill", async () => {
    const h = await harness((dir) => ({
      apps: {
        svc: {
          path: ".",
          scripts: {
            start: fixture("service-child.sh", path.join(dir, "child.pid")),
            stop: fixture("stop-marker.sh", path.join(dir, "stopped.marker")),
          },
        },
      },
    }));

    const leader = await startAndWaitRunning(h, "svc");
    const pidFile = path.join(h.dir, "child.pid");
    await waitFor(() => (statSync(pidFile, { throwIfNoEntry: false })?.size ?? 0) > 0, "grandchild pid file");
    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8"), 10);

    const stopped = await h.sup.stop("svc");

    expect(existsSync(path.join(h.dir, "stopped.marker"))).toBe(true);
    expect(h.u8Lines("svc")).toContain("stop script finished");
    expect(stopped.status).toBe("stopped");
    expect(await waitForPidGone(leader)).toBe(true);
    expect(await waitForPidGone(grandchild)).toBe(true);
  });

  it("does not auto-restart when the stop script is what killed the process", async () => {
    const h = await harness(
      (dir) => ({
        apps: {
          svc: {
            path: ".",
            restart: "on-crash",
            scripts: {
              // `$$` is the group leader the supervisor spawned, so the stop
              // script kills the service itself. It then lingers, so the exit
              // lands *while the script is still running* — before the process
              // layer's own `stop()` could mark it requested. Only the
              // supervisor's stop-in-progress flag can classify it correctly.
              start: `printf '%s\\n' "$$" > '${path.join(dir, "svc.pid")}'; printf 'ready\\n'; while true; do sleep 0.05; done`,
              stop: `kill "$(cat '${path.join(dir, "svc.pid")}')"; sleep 0.4`,
            },
          },
        },
      }),
      { startGraceMs: 80, restartBackoffMs: [20], maxRestartAttempts: 5 },
    );
    const pid = await startAndWaitRunning(h, "svc");

    const stopped = await h.sup.stop("svc");

    expect(stopped.status).toBe("stopped");
    expect(await waitForPidGone(pid)).toBe(true);
    await delay(150); // several backoffs' worth
    expect(h.sup.state("svc").status).toBe("stopped");
    expect(h.statuses("svc")).not.toContain("crashed");
    expect(h.u8Lines("svc").filter((l) => l.startsWith("spawned pid=")).length).toBe(1);
  });

  it("survives a stop script that fails and still stops the service", async () => {
    const h = await harness(() => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh"), stop: "exit 9" } } },
    }));
    const pid = await startAndWaitRunning(h, "svc");

    const stopped = await h.sup.stop("svc");

    expect(stopped.status).toBe("stopped");
    expect(await waitForPidGone(pid)).toBe(true);
    expect(h.u8Lines("svc")).toContain("stop script failed (exit code 9)");
  });

  it("is idempotent: stopping a stopped target resolves without throwing", async () => {
    const h = await harness(oneService);

    const never = await h.sup.stop("svc");
    expect(never.status).toBe("stopped");

    await startAndWaitRunning(h, "svc");
    const [first, second] = await Promise.all([h.sup.stop("svc"), h.sup.stop("svc")]);
    const third = await h.sup.stop("svc");

    expect([first?.status, second?.status, third.status]).toEqual(["stopped", "stopped", "stopped"]);
    expect(h.statuses("svc").filter((s) => s === "stopping")).toHaveLength(1);
  });

  it("stopAll brings every started service down", async () => {
    const h = await harness(() => ({
      apps: {
        a: { path: ".", scripts: { start: fixture("service.sh") } },
        b: { path: ".", scripts: { start: fixture("service.sh") } },
        c: { path: ".", scripts: { start: fixture("service.sh") } },
      },
    }));
    const pids = await Promise.all(["a", "b", "c"].map((id) => startAndWaitRunning(h, id)));

    await h.sup.stopAll({ timeoutMs: 500 });

    expect(h.sup.runningCount()).toBe(0);
    expect(h.sup.states().map((s) => s.status)).toEqual(["stopped", "stopped", "stopped"]);
    for (const pid of pids) expect(await waitForPidGone(pid)).toBe(true);
  });
});

describe("logs", () => {
  it("streams every line to subscribers and to disk, and reads it back", async () => {
    const h = await harness(oneService);

    await h.sup.start("svc");
    await waitFor(() => h.logs.some((l) => l.text === "ready"), "stdout line");
    await waitFor(() => h.logs.some((l) => l.text === "warming up"), "stderr line");

    expect(h.logs.find((l) => l.text === "ready")?.stream).toBe("stdout");
    expect(h.logs.find((l) => l.text === "warming up")?.stream).toBe("stderr");
    expect(h.logs.every((l) => l.targetId === "svc" && l.ts > 0 && l.runId === undefined)).toBe(true);
    expect(h.u8Lines("svc").some((l) => /^spawned pid=\d+$/.test(l))).toBe(true);

    const logPath = serviceLogPath(h.paths.serviceLogDir, "svc");
    expect(logPath.startsWith(h.paths.serviceLogDir)).toBe(true);

    const back = await h.sup.readLog("svc", 20);
    const texts = back.map((l) => l.text);
    expect(texts).toContain("ready");
    expect(texts).toContain("warming up");
    expect(texts.some((t) => t.startsWith("spawned pid="))).toBe(true);
    // The on-disk format carries no stream marker, so backfill is all "stdout".
    expect(back.every((l) => l.stream === "stdout" && l.targetId === "svc" && l.ts > 0)).toBe(true);
    expect(existsSync(logPath)).toBe(true);

    expect(await h.sup.readLog("svc", 0)).toEqual([]);
    expect(await h.sup.readLog("never-started", 5)).toEqual([]);
  });

  it("rotates the service log using the workspace's own limits", async () => {
    const h = await harness(() => ({
      apps: {
        chatty: {
          path: ".",
          scripts: { start: `i=0; while [ $i -lt 40 ]; do printf 'x-%s\\n' "$i"; i=$((i+1)); done; sleep 5` },
        },
      },
      limits: { logMaxBytes: 200, logKeep: 2 },
    }));

    await h.sup.start("chatty");
    await waitFor(() => h.logs.filter((l) => l.text.startsWith("x-")).length === 40, "all output");
    const back = await h.sup.readLog("chatty", 5); // also drains the write queue

    const files = (await readdir(h.paths.serviceLogDir)).filter((f) => f.startsWith("chatty.log")).sort();
    expect(files).toEqual(["chatty.log", "chatty.log.1", "chatty.log.2"]);
    expect(statSync(path.join(h.paths.serviceLogDir, "chatty.log")).size).toBeLessThanOrEqual(200);
    // Rotation must not blank out the log view: the tail still reads back.
    expect(back.map((l) => l.text)).toContain("x-39");
  });

  it("keeps subscriber failures away from the process", async () => {
    const h = await harness(oneService);
    h.sup.onChange(() => {
      throw new Error("listener blew up");
    });
    h.sup.onLog(() => {
      throw new Error("log listener blew up");
    });

    const pid = await startAndWaitRunning(h, "svc");
    const stopped = await h.sup.stop("svc");

    expect(stopped.status).toBe("stopped");
    expect(await waitForPidGone(pid)).toBe(true);
  });

  it("unsubscribes cleanly", async () => {
    const h = await harness(oneService);
    const seen: ServiceState[] = [];
    const off = h.sup.onChange((s) => seen.push(s));

    await h.sup.start("svc");
    off();
    await waitFor(() => h.sup.state("svc").status === "running", "running");

    expect(seen.map((s) => s.status)).toEqual(["starting"]);
  });
});

describe("service commands", () => {
  /** A start script that proves which of the two definitions actually spawned. */
  const marker = (dir: string, name: string): string =>
    `printf '%s\\n' '${name}' > '${path.join(dir, "which.marker")}'; printf 'ready\\n'; while true; do sleep 0.05; done`;

  /** `svc` with an ordinary start script plus a `kind: "service"` command. */
  const withDebugCommand = (script: (dir: string) => string): ConfigBuilder => (dir) => ({
    apps: { svc: { path: ".", scripts: { start: marker(dir, "start") } } },
    commands: { "start.debug": { kind: "service", script: script(dir) } },
    limits: { stopTimeout: 1_000 },
  });

  it("supervises the script the command named, and says so in the log", async () => {
    const h = await harness(withDebugCommand((dir) => marker(dir, "debug")));

    const started = await h.sup.start("svc", { script: marker(h.dir, "debug"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "running");

    expect(started.pid).toBeGreaterThan(0);
    expect(readFileSync(path.join(h.dir, "which.marker"), "utf8").trim()).toBe("debug");
    expect(h.u8Lines("svc").some((l) => /^spawned pid=\d+ via start\.debug$/.test(l))).toBe(true);

    const stopped = await h.sup.stop("svc");

    expect(stopped.status).toBe("stopped");
    expect(await waitForPidGone(started.pid ?? -1)).toBe(true);
  });

  it("replaces a running process when a different script is started", async () => {
    const h = await harness(withDebugCommand((dir) => marker(dir, "debug")));
    const first = await startAndWaitRunning(h, "svc");

    const replaced = await h.sup.start("svc", { script: marker(h.dir, "debug"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "running again");

    expect(replaced.pid).not.toBe(first);
    expect(await waitForPidGone(first)).toBe(true);
    expect(readFileSync(path.join(h.dir, "which.marker"), "utf8").trim()).toBe("debug");
    // Starting the very same definition again stays the no-op it is for app:start.
    const again = await h.sup.start("svc", { script: marker(h.dir, "debug"), via: "start.debug" });
    expect(again.pid).toBe(replaced.pid);
    expect(h.u8Lines("svc").filter((l) => l.startsWith("spawned pid=")).length).toBe(2);
  });

  it("brings the command's own script back when the crash ladder restarts it", async () => {
    const count = (dir: string): string => path.join(dir, "count");
    const h = await harness(
      (dir) => ({
        apps: { svc: { path: ".", restart: "on-crash", scripts: { start: marker(dir, "start") } } },
        commands: {
          "start.debug": { kind: "service", script: fixture("crash-until.sh", count(dir), "1") },
        },
      }),
      crashTiming({ restartBackoffMs: [20] }),
    );

    await h.sup.start("svc", { script: fixture("crash-until.sh", count(h.dir), "1"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "healthy after one crash");

    // The restart re-ran the command's script, not the target's `start` script.
    expect(readFileSync(count(h.dir), "utf8").trim()).toBe("2");
    expect(existsSync(path.join(h.dir, "which.marker"))).toBe(false);
    expect(h.u8Lines("svc").filter((l) => /via start\.debug$/.test(l))).toHaveLength(2);
  });

  it("hands the target back to its own start script when a plain start takes over", async () => {
    const h = await harness(withDebugCommand((dir) => marker(dir, "debug")));
    const debug = await h.sup.start("svc", { script: marker(h.dir, "debug"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "the debug process");
    const debugPid = debug.pid ?? -1;

    const plain = await h.sup.start("svc");
    await waitFor(() => h.sup.state("svc").status === "running", "the start-script process");

    expect(plain.pid).not.toBe(debugPid);
    expect(await waitForPidGone(debugPid)).toBe(true);
    await waitFor(
      () => readFileSync(path.join(h.dir, "which.marker"), "utf8").trim() === "start",
      "the start script to take the slot",
    );
    // The process now belongs to the target's own definition again, so that is
    // what staleness measures it against.
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(false);
  });

  /**
   * The counterpart to replacement: same definition, different text. SPEC §8
   * keeps the process running and marks it `stale`, so a plain start must not
   * quietly kill it — that would make `stale` unobservable, and would restart
   * every edited service the next time anything starts the profile.
   */
  it("does not replace a process a reload only made stale", async () => {
    const plain = (arg: string): ConfigBuilder => () => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", arg) } } },
      limits: { stopTimeout: 1_000 },
    });
    const h = await harness(plain("first"));
    const pid = await startAndWaitRunning(h, "svc");

    await h.reload(plain("edited"));
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(true);

    const again = await h.sup.start("svc");

    expect(again.pid).toBe(pid);
    expect(pidAlive(pid)).toBe(true);
    expect(h.sup.state("svc").stale).toBe(true);
    expect(h.u8Lines("svc").filter((l) => l.startsWith("spawned pid=")).length).toBe(1);

    // The same holds for a command-started process whose command was edited.
    const debugged = await harness(() => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", "plain") } } },
      commands: { "start.debug": { kind: "service", script: fixture("service.sh", "debug") } },
      limits: { stopTimeout: 1_000 },
    }));
    const first = await debugged.sup.start("svc", {
      script: fixture("service.sh", "debug"),
      via: "start.debug",
    });
    await waitFor(() => debugged.sup.state("svc").status === "running", "the debug process");

    await debugged.reload(() => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", "plain") } } },
      commands: { "start.debug": { kind: "service", script: fixture("service.sh", "edited-debug") } },
      limits: { stopTimeout: 1_000 },
    }));
    const rerun = await debugged.sup.start("svc", {
      script: fixture("service.sh", "edited-debug"),
      via: "start.debug",
    });

    expect(rerun.pid).toBe(first.pid);
    debugged.sup.markStale(["svc"]);
    expect(debugged.sup.state("svc").stale).toBe(true);
  });
});

describe("staleness", () => {
  it("flips only when the spawn-time definition actually changed", async () => {
    const h = await harness(oneService);
    await startAndWaitRunning(h, "svc");

    const before = h.changes.length;
    h.sup.markStale(["svc", "never-heard-of-it"]);
    expect(h.changes.length).toBe(before);
    expect(h.sup.state("svc").stale).toBe(false);

    await h.reload(() => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", "now-different") } } },
      limits: { stopTimeout: 1_000 },
    }));

    h.sup.markStale(["svc"]);
    expect(h.changes.length).toBe(before + 1);
    expect(h.sup.state("svc").stale).toBe(true);

    h.sup.markStale(["svc"]); // already flagged: no second event
    expect(h.changes.length).toBe(before + 1);

    await h.sup.restart("svc");
    expect(h.sup.state("svc").stale).toBe(false);
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(false);
  });

  /**
   * The engine resolves a service command's script from the workspace snapshot
   * its run started with, so a reload landing in between hands the supervisor a
   * script the config no longer contains. What is *running* is the stale thing —
   * re-reading the definition at spawn time would call it current and hide it.
   */
  it("measures the script it actually spawned, not the one the config reads now", async () => {
    const build = (debugArg: string): ConfigBuilder => () => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", "plain") } } },
      commands: { "start.debug": { kind: "service", script: fixture("service.sh", debugArg) } },
      limits: { stopTimeout: 1_000 },
    });
    const h = await harness(build("current"));

    await h.sup.start("svc", { script: fixture("service.sh", "already-gone"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "running");

    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(true);
  });

  it("measures a command-started process against that command, not the start script", async () => {
    const debug = (arg: string): string => fixture("service.sh", arg);
    const build = (start: string, debugArg: string): ConfigBuilder => () => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", start) } } },
      commands: { "start.debug": { kind: "service", script: debug(debugArg) } },
      limits: { stopTimeout: 1_000 },
    });
    const h = await harness(build("plain", "debug"));

    await h.sup.start("svc", { script: debug("debug"), via: "start.debug" });
    await waitFor(() => h.sup.state("svc").status === "running", "running");

    // Started from the command's definition, which has not changed.
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(false);

    // The target's own start script is irrelevant to this process.
    await h.reload(build("edited", "debug"));
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(false);

    // Editing the command it was started from is what makes it stale.
    await h.reload(build("edited", "edited-debug"));
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(true);

    // So is losing the command altogether.
    await h.reload(() => ({
      apps: { svc: { path: ".", scripts: { start: debug("debug") } } },
    }));
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(true);
  });

  it("never marks a target that is not running", async () => {
    const h = await harness(oneService);
    await startAndWaitRunning(h, "svc");
    await h.reload(() => ({
      apps: { svc: { path: ".", scripts: { start: fixture("service.sh", "now-different") } } },
    }));
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(true);

    await h.sup.stop("svc");

    expect(h.sup.state("svc").stale).toBe(false);
    h.sup.markStale(["svc"]);
    expect(h.sup.state("svc").stale).toBe(false);
  });
});



