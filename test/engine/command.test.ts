import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskRunLogPath } from "../../src/process/index.js";
import { U8Error } from "../../src/util/errors.js";
import {
  CONCURRENCY_SCRIPT,
  cleanupHarnesses,
  createHarness,
  peakConcurrency,
  resultFor,
  settled,
  statesByTarget,
  waitFor,
  type Harness,
} from "./helpers.js";

afterEach(() => {
  cleanupHarnesses();
});

/** gateway (implicit subapp), platform.shell, platform.auth, db. */
function fourTargets(commands: Record<string, unknown>, extra: Record<string, unknown> = {}): Harness {
  return createHarness({
    dirs: ["gateway", "platform/shell", "platform/auth", "db"],
    config: {
      apps: {
        gateway: { path: "gateway" },
        platform: { path: "platform", subapps: { shell: { path: "shell" }, auth: { path: "auth" } } },
        db: { path: "db" },
      },
      profiles: { full: { default: true, targets: ["gateway", "platform", "db"] } },
      commands,
      ...extra,
    },
  });
}

describe("config commands", () => {
  it("runs the shared script in each target's cwd with the merged env", async () => {
    const h = createHarness({
      dirs: ["gateway", "platform/shell"],
      config: {
        env: { GREETING: "workspace" },
        apps: {
          gateway: { path: "gateway", env: { GREETING: "app" } },
          platform: { path: "platform", subapps: { shell: { path: "shell" } } },
        },
        commands: { probe: { script: 'pwd > out.txt; printf "%s %s\\n" "$GREETING" "${HOME:+has-home}" >> out.txt' } },
      },
    });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ gateway: "ok", "platform.shell": "ok" });
    // Each script saw its own cwd, its own env layer, and the daemon's env.
    expect(h.read("gateway/out.txt")).toBe(`${h.file("gateway")}\napp has-home\n`);
    expect(h.read("platform/shell/out.txt")).toBe(`${h.file("platform/shell")}\nworkspace has-home\n`);
  });

  it("prefers a per-target script over the shared one", async () => {
    const h = fourTargets({
      probe: { script: "echo shared > out.txt", targets: { "platform.shell": "echo override > out.txt" } },
    });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(result.ok).toBe(true);
    expect(h.read("platform/shell/out.txt")).toBe("override\n");
    expect(h.read("platform/auth/out.txt")).toBe("shared\n");
    expect(h.read("gateway/out.txt")).toBe("shared\n");
  });

  it("skips a null target and a target no script resolves for", async () => {
    const h = fourTargets({
      // No shared script: only the two listed targets have work.
      deploy: { targets: { gateway: "echo deployed > out.txt", db: null } },
    });

    const result = await settled(h.engine.runCommand({ command: "deploy" }));

    expect(statesByTarget(result)).toEqual({
      gateway: "ok",
      "platform.shell": "skipped", // absent from the map, no shared script
      "platform.auth": "skipped",
      db: "skipped", // explicit null
    });
    expect(result.ok).toBe(true);
    expect(h.statesOf("db")).toEqual(["pending", "skipped"]);
    expect(resultFor(result, "db").error).toMatch(/no script/);
  });

  it("keeps running other targets when one fails, and reports the run as failed", async () => {
    const h = fourTargets({ probe: { script: "echo ok > out.txt", targets: { gateway: "exit 3" } } });

    const result = await settled(h.engine.runCommand({ command: "probe" }));

    expect(result.ok).toBe(false);
    expect(statesByTarget(result)).toEqual({
      gateway: "failed",
      "platform.shell": "ok",
      "platform.auth": "ok",
      db: "ok",
    });
    const failed = resultFor(result, "gateway");
    expect(failed.exitCode).toBe(3);
    expect(failed.error).toMatch(/exited with code 3/);
    expect(h.read("db/out.txt")).toBe("ok\n");
  });

  it("resolves the active profile when no targets are given, and the given ones otherwise", async () => {
    const h = fourTargets(
      { probe: { script: "echo ran > out.txt" } },
      { profiles: { full: { default: true, targets: ["gateway", "platform", "db"] }, front: { targets: ["platform"] } } },
    );

    h.setProfile("front");
    const profileRun = await settled(h.engine.runCommand({ command: "probe" }));
    expect(profileRun.targets.map((t) => t.targetId)).toEqual(["platform.shell", "platform.auth"]);

    const explicit = await settled(h.engine.runCommand({ command: "probe", targets: ["db"] }));
    expect(explicit.targets.map((t) => t.targetId)).toEqual(["db"]);
  });

  it("rejects an unknown command and an unknown target synchronously", () => {
    const h = fourTargets({ probe: { script: "true" } });

    expect(() => h.engine.runCommand({ command: "nope" })).toThrow(U8Error);
    expect(() => h.engine.runCommand({ command: "probe", targets: ["ghost"] })).toThrow(/unknown target/);
  });

  it("returns the run handle before any progress is emitted", async () => {
    const h = fourTargets({ probe: { script: "true" } });

    const handle = h.engine.runCommand({ command: "probe" });

    // The RPC layer must be able to answer with the id before the first
    // task.progress notification reaches the client.
    expect(handle.runId).toMatch(/\S/);
    expect(h.progress).toHaveLength(0);
    await settled(handle);
    expect(h.progress.length).toBeGreaterThan(0);
  });
});

describe("concurrency", () => {
  function farm(command: Record<string, unknown>): Harness {
    const subapps = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`w${i + 1}`, { path: `w${i + 1}` }]),
    );
    return createHarness({
      dirs: Array.from({ length: 6 }, (_, i) => `farm/w${i + 1}`),
      config: { apps: { farm: { path: "farm", subapps } }, commands: { load: command } },
    });
  }

  it("never exceeds the configured cap", async () => {
    const h = farm({ script: CONCURRENCY_SCRIPT, concurrency: 2 });
    fs.writeFileSync(h.file("farm/mark.txt"), "");

    const result = await settled(
      h.engine.runCommand({ command: "load", targets: ["farm"] }),
      15_000,
    );

    expect(result.ok).toBe(true);
    expect(result.targets).toHaveLength(6);
    expect(peakConcurrency(h.read("farm/mark.txt"))).toBe(2);
  });

  it("honours --serial over every other setting", async () => {
    const h = farm({ script: CONCURRENCY_SCRIPT, concurrency: 4 });
    fs.writeFileSync(h.file("farm/mark.txt"), "");

    const result = await settled(
      h.engine.runCommand({ command: "load", targets: ["farm"], serial: true, concurrency: 6 }),
      15_000,
    );

    expect(result.ok).toBe(true);
    expect(peakConcurrency(h.read("farm/mark.txt"))).toBe(1);
  });

  it("lets the caller widen the cap when the command declares none", async () => {
    const h = farm({ script: CONCURRENCY_SCRIPT });
    fs.writeFileSync(h.file("farm/mark.txt"), "");

    const result = await settled(
      h.engine.runCommand({ command: "load", targets: ["farm"], concurrency: 6 }),
      15_000,
    );

    expect(result.ok).toBe(true);
    expect(peakConcurrency(h.read("farm/mark.txt"))).toBe(6);
  });
});

describe("run logs", () => {
  const script = 'echo "to stdout"; echo "to stderr" >&2';

  it("captures output to the run log, streams it, and reads it back", async () => {
    const h = fourTargets({ probe: { script, targets: { db: null, "platform.auth": null, "platform.shell": null } } });

    const handle = h.engine.runCommand({ command: "probe" });
    const result = await settled(handle);

    const logPath = taskRunLogPath(h.paths.taskLogDir, "probe", handle.runId, "gateway");
    expect(resultFor(result, "gateway").logPath).toBe(logPath);
    expect(fs.readFileSync(logPath, "utf8")).toMatch(/to stdout/);

    // Live stream: both streams tagged, every line carrying the run id.
    const streamed = h.logs.filter((l) => l.targetId === "gateway");
    expect(streamed.every((l) => l.runId === handle.runId)).toBe(true);
    expect(streamed.find((l) => l.text === "to stdout")?.stream).toBe("stdout");
    expect(streamed.find((l) => l.text === "to stderr")?.stream).toBe("stderr");

    const backfill = await h.engine.readRunLog(handle.runId, "gateway", 10);
    expect(backfill.map((l) => l.text)).toEqual(expect.arrayContaining(["to stdout", "to stderr"]));
    expect(backfill.every((l) => l.runId === handle.runId)).toBe(true);
  });

  it("writes no log file for a target that produced no output", async () => {
    const h = fourTargets({ probe: { script: "true" } });

    const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
    const result = await settled(handle);

    expect(resultFor(result, "gateway").logPath).toBeUndefined();
    expect(fs.existsSync(taskRunLogPath(h.paths.taskLogDir, "probe", handle.runId, "gateway"))).toBe(false);
  });

  it("prunes old runs down to limits.taskRunsKeep", async () => {
    const h = fourTargets({ probe: { script } }, { limits: { taskRunsKeep: 2 } });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
      ids.push(handle.runId);
      await settled(handle);
    }

    const commandDir = path.join(h.paths.taskLogDir, "probe");
    expect(fs.readdirSync(commandDir).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("rejects readRunLog for a run it never saw", async () => {
    const h = fourTargets({ probe: { script: "true" } });

    await expect(h.engine.readRunLog("nope", "gateway", 5)).rejects.toBeInstanceOf(U8Error);
  });
});

describe("run retention and cancellation", () => {
  it("answers awaitRun after the run finished, and rejects unknown ids", async () => {
    const h = fourTargets({ probe: { script: "true" } });

    const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
    const result = await settled(handle);

    await expect(h.engine.awaitRun(handle.runId)).resolves.toEqual(result);
    await expect(h.engine.awaitRun("no-such-run")).rejects.toBeInstanceOf(U8Error);
  });

  it("retains a bounded window of finished runs", async () => {
    // Every target is skipped, so the runs cost nothing but bookkeeping.
    const h = fourTargets({ probe: { targets: { gateway: null } } });

    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const handle = h.engine.runCommand({ command: "probe", targets: ["gateway"] });
      ids.push(handle.runId);
      await settled(handle);
    }

    await expect(h.engine.awaitRun(ids[54] ?? "")).resolves.toMatchObject({ ok: true });
    await expect(h.engine.awaitRun(ids[5] ?? "")).resolves.toMatchObject({ ok: true });
    await expect(h.engine.awaitRun(ids[0] ?? "")).rejects.toBeInstanceOf(U8Error);
  });

  it("settles a cancelled run instead of leaving it pending", async () => {
    const h = fourTargets({ probe: { script: "sleep 5", concurrency: 1 } });

    const handle = h.engine.runCommand({ command: "probe" });
    await waitFor(() => h.progress.some((p) => p.state === "running"), "first target to start");

    h.engine.cancelAll("daemon shutting down");
    const result = await settled(handle, 5_000);

    expect(result.ok).toBe(false);
    // The one in flight and the ones never reached both settle as aborted.
    expect(result.targets.every((t) => t.state === "aborted")).toBe(true);
    expect(result.targets[0]?.error).toBe("daemon shutting down");
    expect(h.finished).toHaveLength(1);
  });
});
