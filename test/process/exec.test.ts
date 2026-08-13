import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { exec } from "../../src/process/index.js";
import { fileHasContent, makeScriptsExecutable, script, tempDir, waitFor, waitForPidGone } from "./helpers.js";

beforeAll(makeScriptsExecutable);

describe("exec", () => {
  it("captures both streams of a successful command", async () => {
    const res = await exec(script("both-streams.sh"));

    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBe(null);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe("out-one\nout-two\n");
    expect(res.stderr).toBe("err-one\n");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a non-zero exit as a result, not a rejection", async () => {
    const res = await exec(script("both-streams.sh", "3"));

    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toContain("out-two");
  });

  it("runs in the given cwd with the given env merged over the ambient one", async () => {
    const dir = await tempDir();
    try {
      const res = await exec('printf "%s|%s|%s\\n" "$(pwd -P)" "$U8_TEST_VAR" "${PATH:+has-path}"', {
        cwd: dir.path,
        env: { U8_TEST_VAR: "hello" },
      });

      const [cwd, custom, ambient] = res.stdout.trim().split("|");
      expect(cwd).toBe(await realpath(dir.path));
      expect(custom).toBe("hello");
      // Ambient env survives: a caller's overrides must not blow away PATH.
      expect(ambient).toBe("has-path");
    } finally {
      await dir.cleanup();
    }
  });

  it("feeds `input` to stdin", async () => {
    const res = await exec("cat", { input: "piped\n" });
    expect(res.stdout).toBe("piped\n");
  });

  it("kills a command that exceeds timeoutMs", async () => {
    const started = Date.now();
    const res = await exec("sleep 5", { timeoutMs: 200 });

    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(null);
    expect(res.signal).toBe("SIGTERM");
    expect(res.durationMs).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("escalates to SIGKILL when a timed-out command ignores SIGTERM", async () => {
    const started = Date.now();
    const res = await exec(script("stubborn.sh"), { timeoutMs: 150 });
    const elapsed = Date.now() - started;

    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe("SIGKILL");
    // SIGTERM at 150ms was ignored; only the escalation ended it.
    expect(elapsed).toBeGreaterThan(1_000);
  });

  it("reaps a timed-out command's backgrounded children", async () => {
    const dir = await tempDir();
    try {
      const pidFile = path.join(dir.path, "child.pid");
      const res = await exec(script("spawn-child.sh", pidFile), { timeoutMs: 400 });

      expect(res.timedOut).toBe(true);
      const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      expect(await waitForPidGone(childPid)).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it("kills the whole process group, not just the shell", async () => {
    const dir = await tempDir();
    try {
      const pidFile = path.join(dir.path, "child.pid");
      const ac = new AbortController();
      // Abort as soon as the backgrounded grandchild has announced its pid, so
      // the test never races shell startup.
      const running = exec(script("spawn-child.sh", pidFile), { signal: ac.signal, timeoutMs: 10_000 });
      await waitFor(() => fileHasContent(pidFile), "child pid file");
      ac.abort();

      const res = await running;
      expect(res.ok).toBe(false);

      const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      expect(await waitForPidGone(childPid)).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it("terminates on an AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const res = await exec("sleep 5", { signal: ac.signal });

    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.signal).toBe("SIGTERM");
    expect(res.durationMs).toBeLessThan(3_000);
  });

  it("terminates immediately for an already-aborted signal", async () => {
    const res = await exec("sleep 5", { signal: AbortSignal.abort() });

    expect(res.ok).toBe(false);
    expect(res.durationMs).toBeLessThan(3_000);
  });

  it("keeps the head of oversized output and flags the truncation", async () => {
    const res = await exec(script("spam.sh"), { maxBuffer: 1_000 });

    expect(res.ok).toBe(true);
    expect(res.stdout.startsWith("a".repeat(100))).toBe(true);
    expect(res.stdout).toContain("truncated");
    // The cap holds: the script emits ~20 KB.
    expect(res.stdout.length).toBeLessThan(1_200);
  });

  it("does not truncate output that fits", async () => {
    const res = await exec(script("both-streams.sh"), { maxBuffer: 1_000 });
    expect(res.stdout).toBe("out-one\nout-two\n");
  });

  it("leaves output that lands exactly on maxBuffer untouched", async () => {
    const res = await exec("printf 'abcde'", { maxBuffer: 5 });
    expect(res.stdout).toBe("abcde");
  });

  it("rejects when the shell cannot be spawned", async () => {
    await expect(exec("echo hi", { shell: "/nonexistent/shell" })).rejects.toMatchObject({
      code: "PROCESS_FAILED",
    });
  });

  it("rejects when the cwd does not exist", async () => {
    await expect(exec("echo hi", { cwd: "/definitely/not/a/directory" })).rejects.toMatchObject({
      code: "PROCESS_FAILED",
    });
  });
});
