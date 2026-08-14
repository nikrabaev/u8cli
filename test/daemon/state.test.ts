/**
 * The local state file. It is a convenience file, so the bar is: never lose a
 * daemon start over it, and never leave a half-written one behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStateStore, readLocalState, writeLocalState } from "../../src/daemon/state.js";
import type { Logger } from "../../src/util/logger.js";
import { nullLogger } from "../../src/util/logger.js";

const dirs: string[] = [];

function tmpFile(name = "state.json"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-state-file-")));
  dirs.push(dir);
  return path.join(dir, name);
}

function recordingLogger(sink: string[]): Logger {
  return {
    ...nullLogger,
    warn: (msg: string) => sink.push(msg),
    child: () => recordingLogger(sink),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readLocalState", () => {
  it("treats a missing file as the default state", () => {
    expect(readLocalState(tmpFile())).toEqual({ state: {} });
  });

  it("reports a corrupt file instead of throwing", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const result = readLocalState(file);
    expect(result.state).toEqual({});
    expect(result.problem).toContain("not valid JSON");
  });

  it("rejects a document that is not an object of the right shape", () => {
    const list = tmpFile();
    fs.writeFileSync(list, "[1,2,3]", "utf8");
    expect(readLocalState(list).problem).toContain("JSON object");

    const wrongType = tmpFile();
    fs.writeFileSync(wrongType, JSON.stringify({ activeProfile: 42 }), "utf8");
    expect(readLocalState(wrongType).problem).toContain("activeProfile");
    expect(readLocalState(wrongType).state).toEqual({});
  });

  it("reads a well-formed file", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ activeProfile: "frontend" }), "utf8");
    expect(readLocalState(file)).toEqual({ state: { activeProfile: "frontend" } });
  });
});

describe("writeLocalState", () => {
  it("creates the directory, writes 0600, and leaves no temp file", async () => {
    const file = path.join(tmpFile(), "nested", "state.json");

    await writeLocalState(file, { activeProfile: "full" });

    expect(readLocalState(file).state).toEqual({ activeProfile: "full" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["state.json"]);
  });

  it("replaces the previous file atomically", async () => {
    const file = tmpFile();
    await writeLocalState(file, { activeProfile: "one" });
    await writeLocalState(file, { activeProfile: "two" });

    expect(readLocalState(file).state).toEqual({ activeProfile: "two" });
    // A reader may only ever see one whole file, so no `.tmp` may survive.
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("createStateStore", () => {
  it("loads at construction and warns once about a broken file", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "nonsense", "utf8");
    const warnings: string[] = [];

    const store = createStateStore({ file, logger: recordingLogger(warnings) });
    expect(store.current()).toEqual({});
    store.reload();
    store.reload();

    // Every reload re-reads the same broken file; one warning is the useful one.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ignoring local state");
  });

  it("persists a profile before resolving, and re-reads it from disk", async () => {
    const file = tmpFile();
    const store = createStateStore({ file, logger: nullLogger });

    await store.setActiveProfile("frontend");

    // Already on disk by the time the promise settles — the RPC answers on it.
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ activeProfile: "frontend" });
    expect(store.current()).toEqual({ activeProfile: "frontend" });
    expect(createStateStore({ file, logger: nullLogger }).current()).toEqual({ activeProfile: "frontend" });

    await store.setActiveProfile(undefined);
    expect(store.current()).toEqual({});
    expect(store.reload()).toEqual({});
  });

  it("hands out copies, so a caller cannot mutate the cached state", () => {
    const store = createStateStore({ file: tmpFile(), logger: nullLogger });
    const first = store.current();
    first.activeProfile = "tampered";
    expect(store.current().activeProfile).toBeUndefined();
  });
});
