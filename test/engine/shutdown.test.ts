/**
 * What a run owes a daemon that is going down.
 *
 * `cancelAll` is the first thing shutdown does, and everything here is a way
 * for work to escape it: a pipeline that spawns *after* the cancel, a plugin
 * hook that never returns, a script that traps SIGTERM and outlives the daemon
 * that spawned it. Each one leaves a process nothing owns any more.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHarnesses, createHarness, delay, settled, statesByTarget, waitFor, type Harness } from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
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

function oneTarget(commands: Record<string, unknown> = {}, limits: Record<string, unknown> = {}): Harness {
  return createHarness({
    dirs: ["gateway"],
    config: { repos: { gateway: { path: "gateway" } }, commands, limits },
  });
}

describe("cancellation", () => {
  it("does not start the work when the run is cancelled while a pre hook is running", async () => {
    const h = oneTarget();
    let ranWork = false;
    let inPre = false;
    h.plugins.addCommand("demo", "demo:work", {
      run: () => {
        ranWork = true;
      },
    });
    // Deliberately ignores the run's signal: a hook that takes its time is all
    // it takes for the work to be launched after shutdown snapshotted what to
    // stop, and the process it spawns then belongs to nobody.
    h.plugins.addHook("slow", "demo:work", {
      pre: async () => {
        inPre = true;
        await delay(120);
      },
    });

    const handle = h.engine.runCommand({ command: "demo:work", targets: ["gateway"] });
    await waitFor(() => inPre, "the pre hook to start");
    h.engine.cancelAll("daemon is shutting down");
    const result = await settled(handle);

    expect(statesByTarget(result)).toEqual({ gateway: "aborted" });
    expect(ranWork).toBe(false);
  });

  it("settles a cancelled run whose plugin pre hook never returns", async () => {
    const h = oneTarget();
    let entered = false;
    h.plugins.addCommand("demo", "demo:work", { run: () => undefined });
    h.plugins.addHook("stuck", "demo:work", {
      pre: () =>
        new Promise<void>(() => {
          entered = true;
        }),
    });

    const handle = h.engine.runCommand({ command: "demo:work", targets: ["gateway"] });
    await waitFor(() => entered, "the pre hook to start");
    h.engine.cancelAll("daemon is shutting down");

    const result = await settled(handle, 2_000);
    expect(statesByTarget(result)).toEqual({ gateway: "aborted" });
  });

  it("settles a cancelled run whose plugin post hook never returns", async () => {
    const h = oneTarget();
    let entered = false;
    h.plugins.addCommand("demo", "demo:work", { run: () => undefined });
    h.plugins.addHook("stuck", "demo:work", {
      post: () =>
        new Promise<void>(() => {
          entered = true;
        }),
    });

    const handle = h.engine.runCommand({ command: "demo:work", targets: ["gateway"] });
    await waitFor(() => entered, "the post hook to start");
    h.engine.cancelAll("daemon is shutting down");

    const result = await settled(handle, 2_000);
    expect(result.targets).toHaveLength(1);
  });
});

describe("drain", () => {
  it("waits for a SIGTERM-ignoring script to be killed before it resolves", async () => {
    const h = oneTarget(
      { probe: { script: "trap '' TERM; printf '%s\\n' \"$$\" > pid.txt; while true; do sleep 0.05; done" } },
      { stopTimeout: 300 },
    );

    const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
    await waitFor(() => h.read("gateway/pid.txt").trim() !== "", "the script to report its pid", 5_000);
    const pid = Number.parseInt(h.read("gateway/pid.txt").trim(), 10);
    expect(pidAlive(pid)).toBe(true);

    h.engine.cancelAll("daemon is shutting down");
    await h.engine.drain(5_000);

    // The daemon may exit now: the run is closed and the group was escalated
    // to SIGKILL rather than left behind with a SIGTERM it ignored.
    expect(h.finished).toHaveLength(1);
    expect(pidAlive(pid)).toBe(false);
    await settled(handle);
  });

  it("resolves immediately when nothing is in flight", async () => {
    const h = oneTarget({ probe: { script: "true" } });
    await settled(h.engine.runCommand({ command: "probe", targets: ["gateway"] }));

    const startedAt = Date.now();
    await h.engine.drain(5_000);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("gives up after timeoutMs rather than blocking shutdown forever", async () => {
    const h = oneTarget();
    let entered = false;
    // A plugin command that ignores `ctx.signal` outright: nothing can make it
    // return, so the bound is the only thing that lets the daemon exit.
    h.plugins.addCommand("demo", "demo:stuck", {
      run: () =>
        new Promise<void>(() => {
          entered = true;
        }),
    });

    h.engine.runCommand({ command: "demo:stuck", targets: ["gateway"] });
    await waitFor(() => entered, "the plugin command to start");
    h.engine.cancelAll("daemon is shutting down");

    const startedAt = Date.now();
    await h.engine.drain(150);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(h.finished).toHaveLength(0);
  });
});
