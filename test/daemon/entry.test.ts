/**
 * Unit cover for the two pure decisions the daemon process makes before it
 * exists: how it reads its argv, and where its idle timeout comes from.
 *
 * Importing this module must not start a daemon — that it does not is itself
 * part of what these tests assert.
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveIdleMs } from "../../src/daemon/daemon.js";
import { parseEntryArgs } from "../../src/daemon/entry.js";
import { nullLogger, type Logger } from "../../src/util/logger.js";

const previousIdle = process.env.U8_IDLE_MS;

afterEach(() => {
  if (previousIdle === undefined) delete process.env.U8_IDLE_MS;
  else process.env.U8_IDLE_MS = previousIdle;
});

function warnCollector(sink: string[]): Logger {
  return { ...nullLogger, warn: (msg: string) => sink.push(msg), child: () => warnCollector(sink) };
}

describe("parseEntryArgs", () => {
  it("reads the config in both spellings", () => {
    expect(parseEntryArgs(["--config", "/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
    expect(parseEntryArgs(["--config=/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
    expect(parseEntryArgs(["-c", "/tmp/u8.jsonc"]).configPath).toBe("/tmp/u8.jsonc");
  });

  it("defaults to discovery and foreground off", () => {
    expect(parseEntryArgs([])).toEqual({ foreground: false });
  });

  it("reads the idle override and the foreground switch", () => {
    expect(parseEntryArgs(["--idle-ms", "300", "--foreground"])).toEqual({
      idleMs: 300,
      foreground: true,
    });
  });

  it("refuses arguments it does not understand", () => {
    expect(() => parseEntryArgs(["--nope"])).toThrow(/unknown daemon argument/);
    expect(() => parseEntryArgs(["--config"])).toThrow(/requires a value/);
    expect(() => parseEntryArgs(["--idle-ms", "soon"])).toThrow(/must be a number/);
  });
});

describe("resolveIdleMs", () => {
  it("prefers the explicit override over env and config", () => {
    process.env.U8_IDLE_MS = "1000";
    expect(resolveIdleMs(250, 600_000, nullLogger)).toBe(250);
  });

  it("prefers the environment over the workspace limit", () => {
    process.env.U8_IDLE_MS = "1000";
    expect(resolveIdleMs(undefined, 600_000, nullLogger)).toBe(1_000);
  });

  it("falls back to the workspace limit", () => {
    delete process.env.U8_IDLE_MS;
    expect(resolveIdleMs(undefined, 600_000, nullLogger)).toBe(600_000);
  });

  it("warns about a non-numeric environment value instead of disabling idle exit", () => {
    process.env.U8_IDLE_MS = "later";
    const warnings: string[] = [];
    expect(resolveIdleMs(undefined, 600_000, warnCollector(warnings))).toBe(600_000);
    expect(warnings[0]).toContain("U8_IDLE_MS");
  });

  it("clamps and floors, and treats zero as disabled", () => {
    delete process.env.U8_IDLE_MS;
    expect(resolveIdleMs(-5, 600_000, nullLogger)).toBe(0);
    expect(resolveIdleMs(10.9, 600_000, nullLogger)).toBe(10);
  });
});
