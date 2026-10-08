/**
 * What happens to a workspace when its daemon dies badly.
 *
 * Two ways to lose a daemon without losing its services: `kill -9`, and deleting
 * the state directory out from under it. Both used to leave the process tree
 * running with nothing that knew about it — invisible to `u8 status`, doubled by
 * the next `u8 start`, and reachable only with `pgrep` and `kill`. Everything
 * here is real: real daemons, real services, real signals, and `pgrep` as the
 * final arbiter of what survived.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { daemonTitle, liveDaemonPid, runDaemonEntry } from "../../src/daemon/entry.js";
import { findProcessesMatching } from "../../src/daemon/state.js";
import type { RpcClient } from "../../src/ipc/index.js";
import type { ServiceState } from "../../src/ipc/protocol.js";
import {
  cleanup,
  cleanupStateHome,
  connect,
  createWorkspace,
  daemonLog,
  daemonPid,
  pidAlive,
  waitForPidGone,
  type Workspace,
} from "./helpers.js";

/** Markers still expected to be gone once a test's daemons have been torn down. */
const markers: string[] = [];

afterEach(async () => {
  try {
    await cleanup();
  } finally {
    // The whole point of this file: a test that passes while leaving a service
    // behind has proved nothing. `pgrep`, not the daemon's own opinion.
    const survivors = markers.splice(0).filter((marker) => matching(marker).length > 0);
    for (const marker of survivors) {
      for (const pid of matching(marker)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Raced us to the exit.
        }
      }
    }
    expect(survivors).toEqual([]);
  }
});

afterAll(() => {
  cleanupStateHome();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

/** A string unique to one test, embedded in its service script so `pgrep` can find it. */
function newMarker(): string {
  const marker = `u8recov-${process.pid.toString(36)}-${(seq += 1).toString(36)}`;
  markers.push(marker);
  return marker;
}

/** Pids whose command line contains `marker` — the ground truth for "is it still running". */
function matching(marker: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

/** A one-service workspace whose service idles forever and is findable by marker. */
function soloWorkspace(marker: string, script?: string): Workspace {
  return createWorkspace(
    {
      repos: {
        api: {
          path: "api",
          scripts: { start: script ?? `echo ${marker}; while true; do sleep 0.05; done` },
        },
      },
      profiles: { all: { default: true, targets: ["api"] } },
    },
    ["api"],
  );
}

async function startApi(client: RpcClient): Promise<ServiceState> {
  const run = await client.request("service.start", { targets: ["api"] });
  const result = await client.request("run.await", { runId: run.runId });
  expect(result.ok).toBe(true);
  return await stateOf(client, "api");
}

async function stateOf(client: RpcClient, targetId: string): Promise<ServiceState> {
  const snapshot = await client.request("workspace.snapshot", {});
  const state = snapshot.services.find((s) => s.targetId === targetId);
  if (!state) throw new Error(`no state for ${targetId} in the snapshot`);
  return state;
}

/** Kills the daemon the way a crash would: no signal handler, no shutdown. */
async function sigkillDaemon(ws: Workspace): Promise<number> {
  const pid = daemonPid(ws);
  expect(pid).toBeGreaterThan(0);
  process.kill(pid as number, "SIGKILL");
  expect(await waitForPidGone(pid as number)).toBe(true);
  return pid as number;
}

/** A live process that has nothing to do with u8, for the pid-reuse cases. */
function spawnStranger(): number {
  const pid = Number(
    execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim(),
  );
  expect(pid).toBeGreaterThan(0);
  return pid;
}

/**
 * A live process whose *command line quotes* `text` without being it — a shell
 * running a script that mentions the daemon, a `grep`, an editor. The `while`
 * loop is what keeps `sh` from exec'ing the body and losing the text with it.
 */
function spawnMentioning(text: string): number {
  const pid = Number(
    execFileSync("sh", ["-c", `sh -c 'while true; do sleep 1; done # ${text}' >/dev/null 2>&1 & echo $!`], {
      encoding: "utf8",
    }).trim(),
  );
  expect(pid).toBeGreaterThan(0);
  return pid;
}

/** Runs the daemon entry point in-process, capturing what it would have logged. */
async function runEntry(argv: string[]): Promise<{ code: number; output: string }> {
  let output = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const capture = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    // `--foreground` keeps the redirect off, so the failure lands here instead
    // of in the daemon log of a daemon that never started.
    return { code: await runDaemonEntry([...argv, "--foreground"]), output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// ---------------------------------------------------------------------------
// kill -9
// ---------------------------------------------------------------------------

describe("a SIGKILLed daemon", () => {
  it("hands its services to the next daemon instead of losing them", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    const before = await startApi(first);
    expect(before.status).toBe("running");
    expect(matching(marker)).toHaveLength(1);

    await sigkillDaemon(ws);
    // The service is exactly where the auditor found it: alive, and owned by
    // nothing at all.
    expect(pidAlive(before.pid as number)).toBe(true);

    const second = await connect(ws);
    const recovered = await stateOf(second, "api");

    expect(recovered.status).toBe("running");
    expect(recovered.pid).toBe(before.pid);
    expect(recovered.startedAt).toBe(before.startedAt);
    expect((await second.request("daemon.status", {})).runningServices).toBe(1);
    expect(matching(marker)).toHaveLength(1);
  });

  it("never starts a second copy of a service it already owns", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    const before = await startApi(first);

    await sigkillDaemon(ws);

    const second = await connect(ws);
    const again = await startApi(second);

    // One process, and the same one: an adopted service is already started.
    expect(matching(marker)).toEqual([before.pid]);
    expect(again.pid).toBe(before.pid);
  });

  it("stops an adopted service and its whole process group", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    const before = await startApi(first);

    await sigkillDaemon(ws);
    const second = await connect(ws);
    expect((await stateOf(second, "api")).status).toBe("running");

    const run = await second.request("service.stop", { targets: ["api"] });
    expect((await second.request("run.await", { runId: run.runId })).ok).toBe(true);

    expect(await waitForPidGone(before.pid as number)).toBe(true);
    expect(matching(marker)).toEqual([]);
    expect((await stateOf(second, "api")).status).toBe("stopped");
    expect((await second.request("daemon.status", {})).runningServices).toBe(0);
  });

  it("says in the service log that an adopted process has no live output", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    await startApi(first);

    await sigkillDaemon(ws);
    const second = await connect(ws);
    await stateOf(second, "api");

    const { lines } = await second.request("logs.read", { targetId: "api", lines: 200 });
    const text = lines.map((l) => l.text).join("\n");
    // `u8 logs -f` on an adopted process can only ever be quiet; the log has to
    // say why rather than let the user read silence as "nothing is happening".
    expect(text).toMatch(/adopted pid=\d+ from a previous daemon/);
    expect(text).toContain("no further live log lines will be captured");
    expect(daemonLog(ws)).toMatch(/adopted api \(pid \d+\)/);
  });

  it("restores live logs when an adopted service is restarted", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    const before = await startApi(first);

    await sigkillDaemon(ws);
    const second = await connect(ws);

    const run = await second.request("service.restart", { targets: ["api"] });
    expect((await second.request("run.await", { runId: run.runId })).ok).toBe(true);

    const after = await stateOf(second, "api");
    expect(after.status).toBe("running");
    expect(after.pid).not.toBe(before.pid);
    expect(await waitForPidGone(before.pid as number)).toBe(true);
    // A real spawn again, so its stdout is ours once more: the marker line the
    // adopted process could never have reported comes back.
    const { lines } = await second.request("logs.read", { targetId: "api", lines: 200 });
    expect(lines.map((l) => l.text).join("\n")).toContain(marker);
    expect(matching(marker)).toEqual([after.pid]);
  });

  it("reaps an orphaned process group whose leader is already gone", async () => {
    const marker = newMarker();
    // The leader backgrounds the real work and then exits. Under a live daemon
    // the group is swept when the leader goes; with the daemon dead, nothing
    // sweeps it, and there is no process left whose identity can be confirmed.
    const ws = soloWorkspace(marker, `{ echo ${marker}; while true; do sleep 0.05; done; } & sleep 2`);
    const first = await connect(ws);
    const before = await startApi(first);

    await sigkillDaemon(ws);
    expect(await waitForPidGone(before.pid as number, 5_000)).toBe(true);
    // The leader is gone; its child is not.
    expect(matching(marker)).toHaveLength(1);

    const second = await connect(ws);

    expect(matching(marker)).toEqual([]);
    expect((await stateOf(second, "api")).status).toBe("stopped");
    expect(daemonLog(ws)).toMatch(/stopped api \(pid \d+\) left by a previous daemon/);
  });

  it("ignores a record whose pid now belongs to something else", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    const before = await startApi(first);
    await sigkillDaemon(ws);

    process.kill(before.pid as number, "SIGKILL");
    expect(await waitForPidGone(before.pid as number)).toBe(true);

    // A live process the daemon never spawned, standing in for the pid its
    // record names after the number was handed out again. The record's spawn
    // time is what gives it away, so it is moved out of reach of the slack.
    const stranger = spawnStranger();
    const file = `${ws.paths.dir}/supervised.json`;
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
      processes: Array<{ pid: number; pgid: number; startedAt: number }>;
    };
    const record = doc.processes[0];
    expect(record).toBeDefined();
    if (record) {
      record.pid = stranger;
      record.pgid = stranger;
      record.startedAt -= 60_000;
    }
    fs.writeFileSync(file, JSON.stringify(doc));

    try {
      const second = await connect(ws);

      // Neither adopted (it is not ours) nor signalled (killing a stranger's
      // process group is the one mistake here that cannot be taken back).
      expect((await stateOf(second, "api")).status).toBe("stopped");
      expect(pidAlive(stranger)).toBe(true);
    } finally {
      try {
        process.kill(stranger, "SIGKILL");
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A deleted state directory
// ---------------------------------------------------------------------------

describe("a daemon whose state directory is deleted", () => {
  it("stops its services and exits instead of lingering unreachable", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const client = await connect(ws);
    const service = await startApi(client);
    const daemon = daemonPid(ws) as number;

    fs.rmSync(ws.paths.dir, { recursive: true, force: true });

    expect(await waitForPidGone(daemon, 15_000)).toBe(true);
    expect(await waitForPidGone(service.pid as number, 5_000)).toBe(true);
    expect(matching(marker)).toEqual([]);
  });

  it("leaves exactly one daemon serving the workspace afterwards", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const first = await connect(ws);
    await startApi(first);
    const daemon = daemonPid(ws) as number;

    fs.rmSync(ws.paths.dir, { recursive: true, force: true });
    expect(await waitForPidGone(daemon, 15_000)).toBe(true);

    const second = await connect(ws);
    const status = await second.request("daemon.status", {});

    expect(status.pid).not.toBe(daemon);
    expect(daemonPid(ws)).toBe(status.pid);
    expect(pidAlive(daemon)).toBe(false);
    expect(status.runningServices).toBe(0);
    expect(matching(marker)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refusing to race
// ---------------------------------------------------------------------------

describe("the pid file as proof of a live daemon", () => {
  it("identifies the daemon it names, and nothing else", async () => {
    const ws = soloWorkspace(newMarker());
    await connect(ws);
    const daemon = daemonPid(ws) as number;

    expect(await liveDaemonPid(ws.paths)).toBe(daemon);

    // A live pid that is not a daemon for this workspace must not lock it out:
    // pid files outlive the daemons that wrote them.
    const stranger = spawnStranger();
    fs.writeFileSync(ws.paths.pidFile, `${stranger}\n`);
    try {
      expect(await liveDaemonPid(ws.paths)).toBeUndefined();
    } finally {
      process.kill(stranger, "SIGKILL");
      fs.writeFileSync(ws.paths.pidFile, `${daemon}\n`);
    }
  });

  it("refuses to start a second daemon while the first still owns the workspace", async () => {
    const ws = soloWorkspace(newMarker());
    await connect(ws);
    const daemon = daemonPid(ws) as number;

    // Frozen, so the socket can be deleted without the daemon noticing yet —
    // this is the window in which a second daemon used to start beside it.
    process.kill(daemon, "SIGSTOP");
    try {
      fs.rmSync(ws.paths.socket, { force: true });
      const { code, output } = await runEntry(["--config", ws.configPath]);

      expect(code).toBe(1);
      expect(output).toContain(`already running as pid ${daemon}`);
      expect(daemonPid(ws)).toBe(daemon);
    } finally {
      process.kill(daemon, "SIGCONT");
    }

    // And once it is running again it notices for itself and stands down.
    expect(await waitForPidGone(daemon, 15_000)).toBe(true);
  });

  it("is not fooled by a process that merely quotes the daemon's title", async () => {
    const ws = soloWorkspace(newMarker());
    await connect(ws);
    const daemon = daemonPid(ws) as number;
    const title = daemonTitle(ws.paths.id);

    // A shell script that mentions the daemon, a `grep`, a `pgrep -f` typed by
    // whoever is debugging this very situation: matching one of those refuses
    // every start for the workspace for as long as it lives, and the refusal
    // names a pid that cannot be stopped because it is not a daemon.
    const impostor = spawnMentioning(title);
    try {
      expect(await findProcessesMatching(title)).toEqual([daemon]);
    } finally {
      process.kill(impostor, "SIGKILL");
    }
  });

  it("refuses even when the whole state directory — pid file and all — is gone", async () => {
    const marker = newMarker();
    const ws = soloWorkspace(marker);
    const client = await connect(ws);
    const service = await startApi(client);
    const daemon = daemonPid(ws) as number;

    process.kill(daemon, "SIGSTOP");
    try {
      // Nothing on disk names the daemon any more; the process table still does.
      fs.rmSync(ws.paths.dir, { recursive: true, force: true });
      const { code, output } = await runEntry(["--config", ws.configPath]);

      expect(code).toBe(1);
      expect(output).toContain(`already running as pid ${daemon}`);
    } finally {
      process.kill(daemon, "SIGCONT");
    }

    // The one daemon there ever was takes its services down with it.
    expect(await waitForPidGone(daemon, 15_000)).toBe(true);
    expect(await waitForPidGone(service.pid as number, 5_000)).toBe(true);
    expect(matching(marker)).toEqual([]);
  });
});
