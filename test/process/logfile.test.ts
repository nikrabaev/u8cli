import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLogWriter,
  parseLogLine,
  pruneTaskRuns,
  readLastLines,
  serviceLogPath,
  taskRunDir,
  taskRunLogPath,
} from "../../src/process/index.js";
import { tempDir, type TempDir } from "./helpers.js";

let dir: TempDir;

beforeEach(async () => {
  dir = await tempDir("u8-logfile-");
});

afterEach(async () => {
  await dir.cleanup();
});

/** Every persisted line is `<iso ts> <text>`; a torn line fails this. */
const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z .+$/;

async function linesOf(file: string): Promise<string[]> {
  const raw = await readFile(file, "utf8");
  return raw.split("\n").filter((l) => l.length > 0);
}

describe("createLogWriter", () => {
  it("appends timestamped lines and reopens an existing file", async () => {
    const file = path.join(dir.path, "svc.log");

    const first = createLogWriter({ path: file });
    await first.write("hello", 1_700_000_000_000);
    await first.close();

    const second = createLogWriter({ path: file });
    await second.write("again", 1_700_000_001_000);
    await second.close();

    const lines = await linesOf(file);
    expect(lines).toEqual(["2023-11-14T22:13:20.000Z hello", "2023-11-14T22:13:21.000Z again"]);
    expect(parseLogLine(lines[0] ?? "")).toEqual({ ts: 1_700_000_000_000, text: "hello" });
  });

  it("creates missing parent directories", async () => {
    const file = path.join(dir.path, "nested", "deeper", "svc.log");
    const writer = createLogWriter({ path: file });

    await writer.write("x");
    await writer.close();

    expect(existsSync(file)).toBe(true);
  });

  it("serializes concurrent writes so lines never interleave", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file });

    const payloads = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    await Promise.all(payloads.map((p) => writer.write(p)));
    await writer.close();

    const lines = await linesOf(file);
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => LINE_RE.test(l))).toBe(true);
    expect(lines.map((l) => parseLogLine(l).text)).toEqual(payloads);
  });

  it("rotates at maxBytes, keeps `keep` generations and never tears a line", async () => {
    const file = path.join(dir.path, "svc.log");
    // Each line is 24 (ISO) + 1 + 7 + 1 = 33 bytes, so two fit under 70.
    const writer = createLogWriter({ path: file, maxBytes: 70, keep: 2 });

    for (let i = 1; i <= 8; i++) await writer.write(`line-0${i}`, 1_700_000_000_000 + i);
    await writer.close();

    expect((await linesOf(file)).map((l) => parseLogLine(l).text)).toEqual(["line-07", "line-08"]);
    expect((await linesOf(`${file}.1`)).map((l) => parseLogLine(l).text)).toEqual(["line-05", "line-06"]);
    expect((await linesOf(`${file}.2`)).map((l) => parseLogLine(l).text)).toEqual(["line-03", "line-04"]);
    expect(existsSync(`${file}.3`)).toBe(false);

    for (const f of [file, `${file}.1`, `${file}.2`]) {
      const lines = await linesOf(f);
      expect(lines.every((l) => LINE_RE.test(l))).toBe(true);
    }
  });

  it("keeps every line intact when concurrent writes span several rotations", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file, maxBytes: 100, keep: 20 });

    const payloads = Array.from({ length: 60 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    await Promise.all(payloads.map((p) => writer.write(p)));
    await writer.close();

    // Rotation happens *inside* the serialized queue: nothing may be lost,
    // reordered or torn by a rename landing between two writes.
    const persisted = await readLastLines(file, 500);
    expect(persisted.every((l) => LINE_RE.test(l))).toBe(true);
    expect(persisted.map((l) => parseLogLine(l).text)).toEqual(payloads);
  });

  it("drops writes issued after close instead of reopening the file", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file });

    await writer.write("before");
    await writer.close();
    await expect(writer.write("after-close")).resolves.toBeUndefined();

    expect((await linesOf(file)).map((l) => parseLogLine(l).text)).toEqual(["before"]);
  });

  it("writes a line larger than maxBytes whole rather than splitting it", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file, maxBytes: 40, keep: 1 });

    await writer.write("short");
    await writer.write("x".repeat(200));
    await writer.close();

    const lines = await linesOf(file);
    expect(lines).toHaveLength(1);
    expect(parseLogLine(lines[0] ?? "").text).toBe("x".repeat(200));
    expect((await linesOf(`${file}.1`)).map((l) => parseLogLine(l).text)).toEqual(["short"]);
  });
});

describe("readLastLines", () => {
  it("returns the last n lines oldest-first", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file });
    for (let i = 1; i <= 20; i++) await writer.write(`line-${i}`);
    await writer.close();

    const lines = await readLastLines(file, 3);

    expect(lines.map((l) => parseLogLine(l).text)).toEqual(["line-18", "line-19", "line-20"]);
  });

  it("walks into rotated generations when the current file is short", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file, maxBytes: 70, keep: 3 });
    for (let i = 1; i <= 8; i++) await writer.write(`line-0${i}`);
    await writer.close();

    const lines = await readLastLines(file, 5);

    expect(lines.map((l) => parseLogLine(l).text)).toEqual(["line-04", "line-05", "line-06", "line-07", "line-08"]);
  });

  it("stops at the oldest surviving generation when asked for more than exists", async () => {
    const file = path.join(dir.path, "svc.log");
    const writer = createLogWriter({ path: file, maxBytes: 70, keep: 2 });
    for (let i = 1; i <= 8; i++) await writer.write(`line-0${i}`);
    await writer.close();

    // keep=2 means line-01/02 were dropped by rotation; the walk must not
    // over-count and must not loop past the last generation.
    const lines = await readLastLines(file, 100);

    expect(lines.map((l) => parseLogLine(l).text)).toEqual([
      "line-03",
      "line-04",
      "line-05",
      "line-06",
      "line-07",
      "line-08",
    ]);
  });

  it("returns everything available when fewer lines exist than requested", async () => {
    const file = path.join(dir.path, "svc.log");
    await writeFile(file, "only-one\n");

    expect(await readLastLines(file, 10)).toEqual(["only-one"]);
    expect(await readLastLines(file, 0)).toEqual([]);
  });

  it("handles a missing file, an empty file and a missing trailing newline", async () => {
    expect(await readLastLines(path.join(dir.path, "nope.log"), 5)).toEqual([]);

    const empty = path.join(dir.path, "empty.log");
    await writeFile(empty, "");
    expect(await readLastLines(empty, 5)).toEqual([]);

    const partial = path.join(dir.path, "partial.log");
    await writeFile(partial, "a\nb\nno-newline");
    expect(await readLastLines(partial, 2)).toEqual(["b", "no-newline"]);
  });

  it("reads back multi-byte lines that straddle the backward-scan chunks", async () => {
    const file = path.join(dir.path, "utf8.log");
    const writer = createLogWriter({ path: file });
    // 16 KB per line, so the backward scan stops mid-file with chunk boundaries
    // landing inside two-byte characters.
    for (let i = 1; i <= 5; i++) await writer.write(`${i}:${"π".repeat(8_000)}`);
    await writer.close();

    const lines = (await readLastLines(file, 2)).map((l) => parseLogLine(l).text);

    expect(lines).toEqual([`4:${"π".repeat(8_000)}`, `5:${"π".repeat(8_000)}`]);
  });
});

describe("log layout", () => {
  it("sanitizes target ids and command names into path segments", () => {
    expect(serviceLogPath("/logs", "platform.shell")).toBe("/logs/platform.shell.log");
    expect(serviceLogPath("/logs", "weird/../id")).toBe("/logs/weird_.._id.log");
    expect(taskRunLogPath("/logs", "git:pull", "r1", "a/b")).toBe("/logs/git_pull/r1/a_b.log");
  });
});

describe("pruneTaskRuns", () => {
  it("keeps the newest runs by mtime, not by name", async () => {
    const base = dir.path;
    // Alphabetical order (a, b, c) deliberately disagrees with mtime order.
    const ages: Array<[string, number]> = [
      ["run-a", 2_000],
      ["run-b", 1_000],
      ["run-c", 3_000],
    ];
    for (const [name] of ages) {
      const runDir = taskRunDir(base, "test", name);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "gateway.log"), "x\n");
    }
    // Set mtimes after writing; creating files bumps the directory's mtime.
    for (const [name, ageMs] of ages) {
      const when = new Date(Date.now() - ageMs * 1000);
      await utimes(taskRunDir(base, "test", name), when, when);
    }

    // Newest → oldest is b, a, c. Name-ordering would have kept c and dropped a.
    const removed = await pruneTaskRuns(base, "test", 2);

    expect(removed).toEqual(["run-c"]);
    expect(existsSync(taskRunDir(base, "test", "run-c"))).toBe(false);
    expect(existsSync(taskRunDir(base, "test", "run-a"))).toBe(true);
    expect(existsSync(taskRunDir(base, "test", "run-b"))).toBe(true);
  });

  it("is a no-op for an unknown command and removes everything for keep=0", async () => {
    expect(await pruneTaskRuns(dir.path, "never-ran", 5)).toEqual([]);

    await mkdir(taskRunDir(dir.path, "test", "r1"), { recursive: true });
    expect(await pruneTaskRuns(dir.path, "test", 0)).toEqual(["r1"]);
    expect(existsSync(taskRunDir(dir.path, "test", "r1"))).toBe(false);
  });
});
