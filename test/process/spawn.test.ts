import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { spawnManaged, type SpawnManagedOptions } from "../../src/process/index.js";
import type { LogStream } from "../../src/ipc/protocol.js";
import type { ProcessHandle } from "../../src/process/types.js";
import { U8Error } from "../../src/util/errors.js";
import {
  fileHasContent,
  makeScriptsExecutable,
  pidAlive,
  script,
  tempDir,
  timeout,
  waitFor,
  waitForPidGone,
} from "./helpers.js";

beforeAll(makeScriptsExecutable);

interface Captured {
  stream: LogStream;
  text: string;
  ts: number;
}

function collect(handle: ProcessHandle): Captured[] {
  const lines: Captured[] = [];
  handle.onOutput((stream, text, ts) => lines.push({ stream, text, ts }));
  return lines;
}

function textOf(lines: Captured[], stream: LogStream): string[] {
  return lines.filter((l) => l.stream === stream).map((l) => l.text);
}

/** Hands back what a call threw, so the error itself can be asserted on. */
function errorFrom(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected the call to throw, but it returned");
}

function start(scriptCmd: string, opts: SpawnManagedOptions = {}): ProcessHandle {
  return spawnManaged({ script: scriptCmd, cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } }, opts);
}

describe("spawnManaged", () => {
  it("splits output into lines, normalizes CRLF and flushes a trailing partial", async () => {
    const handle = start(script("mixed-lines.sh"));
    const lines = collect(handle);

    const exit = await handle.exited;

    expect(exit.code).toBe(0);
    expect(textOf(lines, "stdout")).toEqual(["alpha", "beta", "trailing-partial"]);
    expect(textOf(lines, "stderr")).toEqual(["boom"]);
    expect(lines.every((l) => l.ts > 0)).toBe(true);
  });

  it("splits a single oversized line instead of buffering it", async () => {
    const handle = start(script("long-line.sh"), { maxLineLength: 100 });
    const lines = collect(handle);

    await handle.exited;

    const out = textOf(lines, "stdout");
    expect(out).toEqual(["a".repeat(100), "a".repeat(100), "a".repeat(100), "after"]);
  });

  it("resolves `exited` once with the self-exit code and requested:false", async () => {
    const handle = start(script("short-lived.sh"));
    const lines = collect(handle);

    const exit = await handle.exited;
    const again = await handle.exited;

    expect(exit.code).toBe(7);
    expect(exit.signal).toBe(null);
    expect(exit.requested).toBe(false);
    expect(exit.durationMs).toBeGreaterThan(0);
    expect(again).toBe(exit);
    expect(textOf(lines, "stdout")).toEqual(["working", "done"]);
  });

  it("uses the provided env verbatim — the caller owns the merge", async () => {
    process.env.U8_LEAKED = "leaked";
    try {
      const handle = spawnManaged({
        script: 'printf "%s|%s\\n" "$U8_GIVEN" "${U8_LEAKED:-absent}"',
        cwd: process.cwd(),
        env: { U8_GIVEN: "yes" },
      });
      const lines = collect(handle);

      await handle.exited;

      expect(textOf(lines, "stdout")).toEqual(["yes|absent"]);
    } finally {
      delete process.env.U8_LEAKED;
    }
  });

  it("stops a well-behaved service with SIGTERM, well before the grace expires", async () => {
    const handle = start(script("service.sh"));
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("ready"), "service startup");

    const started = Date.now();
    const exit = await handle.stop({ timeoutMs: 2_000 });
    const elapsed = Date.now() - started;

    expect(exit.requested).toBe(true);
    expect(exit.signal).toBe("SIGTERM");
    expect(exit.code).toBe(null);
    expect(elapsed).toBeLessThan(1_500);
    expect(pidAlive(handle.pid)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const handle = start(script("stubborn.sh"));
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("stubborn"), "service startup");
    const pid = handle.pid;

    const started = Date.now();
    const exit = await handle.stop({ timeoutMs: 300 });
    const elapsed = Date.now() - started;

    expect(exit.signal).toBe("SIGKILL");
    expect(exit.requested).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    expect(await waitForPidGone(pid)).toBe(true);
  });

  it("falls back to the handle's stopTimeoutMs when stop() is given none", async () => {
    const handle = start(script("stubborn.sh"), { stopTimeoutMs: 300 });
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("stubborn"), "service startup");

    const started = Date.now();
    const exit = await handle.stop();
    const elapsed = Date.now() - started;

    expect(exit.signal).toBe("SIGKILL");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    // Would be the 10s built-in default if the option were ignored.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("sends the signal stop() was asked for instead of SIGTERM", async () => {
    const handle = start(script("service.sh"));
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("ready"), "service startup");

    const exit = await handle.stop({ signal: "SIGINT", timeoutMs: 1_000 });

    expect(exit.signal).toBe("SIGINT");
    expect(exit.requested).toBe(true);
  });

  it("kills grandchildren along with the leader", async () => {
    const dir = await tempDir();
    try {
      const pidFile = path.join(dir.path, "child.pid");
      const handle = start(script("spawn-child.sh", pidFile));
      await waitFor(() => fileHasContent(pidFile), "child pid file");
      const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);

      await handle.stop({ timeoutMs: 500 });

      expect(await waitForPidGone(childPid)).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it("reaps the group when the leader exits on its own and leaves a child behind", async () => {
    const dir = await tempDir();
    let childPid = 0;
    try {
      const pidFile = path.join(dir.path, "survivor.pid");
      // The leader exits immediately; the backgrounded child outlives it while
      // still holding stdout, so nothing but this handle knows the group exists.
      const handle = start(`sleep 300 & echo "$!" > '${pidFile}'; echo leader done`);
      const lines = collect(handle);

      const exit = await handle.exited;
      childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);

      // The leader's own outcome must be reported unchanged.
      expect(exit.code).toBe(0);
      expect(exit.signal).toBe(null);
      expect(exit.requested).toBe(false);
      expect(textOf(lines, "stdout")).toContain("leader done");
      expect(await waitForPidGone(childPid)).toBe(true);
    } finally {
      // An unreaped survivor would outlive the suite by five minutes.
      if (childPid > 0) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone, which is what the assertion above demands.
        }
      }
      await dir.cleanup();
    }
  });

  it("is idempotent: repeated stops resolve to the same exit", async () => {
    const handle = start(script("service.sh"));
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("ready"), "service startup");

    const [first, second] = await Promise.all([handle.stop({ timeoutMs: 500 }), handle.stop({ timeoutMs: 500 })]);
    const third = await handle.stop({ timeoutMs: 500 });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.requested).toBe(true);
  });

  it("stopping an already-exited process resolves with its real exit", async () => {
    const handle = start(script("short-lived.sh"));
    const exit = await handle.exited;

    const stopped = await handle.stop({ timeoutMs: 500 });

    expect(stopped).toBe(exit);
    expect(stopped.requested).toBe(false);
  });

  it("unsubscribes output listeners", async () => {
    const handle = start(script("short-lived.sh"));
    const seen: string[] = [];
    const off = handle.onOutput((_s, text) => {
      seen.push(text);
      off();
    });

    await handle.exited;

    expect(seen).toEqual(["working"]);
  });

  it("reports a spawn failure on the u8 stream and still settles `exited`", async () => {
    const handle = spawnManaged({
      script: "echo hi",
      cwd: path.join(process.cwd(), "definitely-not-a-directory"),
      env: {},
    });
    const lines = collect(handle);

    const exit = await handle.exited;

    expect(exit.code).toBe(null);
    expect(textOf(lines, "u8").join(" ")).toContain("spawn failed");
  });

  /**
   * Node reports a missing `cwd` as `spawn <shell> ENOENT`: the errno belongs to
   * the directory but the name in the message is the executable's, so the one
   * thing that is fine takes the blame and the reader goes hunting for a broken
   * shell instead of their own `path` typo.
   */
  it("blames the missing working directory rather than the shell", async () => {
    const missing = path.join(process.cwd(), "definitely-not-a-directory");
    const handle = spawnManaged({ script: "echo hi", cwd: missing, env: {} });
    const lines = collect(handle);

    const exit = await handle.exited;

    const said = textOf(lines, "u8").join(" ");
    expect(said).toContain(`no such directory: ${missing}`);
    expect(said).not.toContain("ENOENT");
    expect(exit.code).toBe(null);
  });

  it("still names the shell when the shell is the thing that is missing", async () => {
    const handle = spawnManaged({
      script: "echo hi",
      cwd: process.cwd(),
      env: {},
      shell: "/nonexistent/u8-shell",
    });
    const lines = collect(handle);

    await handle.exited;

    const said = textOf(lines, "u8").join(" ");
    expect(said).toContain("/nonexistent/u8-shell");
    expect(said).not.toContain("no such directory");
  });

  /**
   * Node hands back only a fixed set of spawn errnos through the "error" event;
   * a `cwd` that is a file fails with ENOTDIR, thrown from the call itself with
   * a message that names neither the directory nor what was wrong with it.
   */
  it("throws a described error when the working directory is a file", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir.path, "u8.jsonc");
      await writeFile(file, "{}", "utf8");

      const failure = errorFrom(() => spawnManaged({ script: "echo hi", cwd: file, env: {} }));

      expect(failure).toBeInstanceOf(U8Error);
      expect((failure as U8Error).code).toBe("PROCESS_FAILED");
      expect(failure.message).toContain(`not a directory: ${file}`);
    } finally {
      await dir.cleanup();
    }
  });

  it("stopping a handle whose spawn failed resolves instead of hanging", async () => {
    const handle = spawnManaged({
      script: "echo hi",
      cwd: path.join(process.cwd(), "definitely-not-a-directory"),
      env: {},
    });

    // A stop() that waited on a group that never existed would deadlock the
    // daemon's shutdown path.
    const exit = await Promise.race([handle.stop({ timeoutMs: 200 }), timeout(3_000)]);

    expect(exit).not.toBe("timed out");
  });

  it("delivers a burst of lines complete and in order", async () => {
    const handle = start('i=0; while [ $i -lt 400 ]; do echo "n-$i"; i=$((i + 1)); done', { maxLineLength: 4 });
    const lines = collect(handle);

    await handle.exited;

    // maxLineLength splits each "n-<i>" at 4 chars; nothing may be lost or reordered.
    const expected = Array.from({ length: 400 }, (_, i) => `n-${i}`).flatMap((l) =>
      Array.from({ length: Math.ceil(l.length / 4) }, (_, j) => l.slice(j * 4, j * 4 + 4)),
    );
    expect(textOf(lines, "stdout")).toEqual(expected);
  });

  it("kill() signals the group without waiting", async () => {
    const handle = start(script("service.sh"));
    const lines = collect(handle);
    await waitFor(() => textOf(lines, "stdout").includes("ready"), "service startup");

    handle.kill("SIGKILL");
    const exit = await handle.exited;

    expect(exit.signal).toBe("SIGKILL");
    expect(exit.requested).toBe(false);
  });
});
