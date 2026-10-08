/**
 * The two presentation decisions every command inherits: how a failure is
 * printed, and whether anything is coloured.
 *
 * These are the cases that cannot be reached by driving a real workspace — an
 * error nobody anticipated, or an environment a test cannot put a terminal in.
 */
import { describe, expect, it } from "vitest";

import { reportError } from "../../src/cli/errors.js";
import { createStyler, shouldUseColor } from "../../src/cli/format.js";
import type { CliIo, OutputStream } from "../../src/cli/io.js";
import { ConfigError, U8Error } from "../../src/util/errors.js";

class Capture implements OutputStream {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function io(env: Record<string, string> = {}, tty = false): CliIo & { err: Capture } {
  const err = new Capture();
  return { stdout: new Capture(), stderr: err, cwd: "/", env, tty, err };
}

describe("reportError", () => {
  it("prints a U8Error as a sentence, with the next step and no stack", () => {
    const target = io();
    const code = reportError(
      new U8Error("UNKNOWN_TARGET", 'unknown target "web"', { known: ["api", "db"] }),
      target,
      createStyler(false),
    );

    expect(code).toBe(1);
    expect(target.err.text).toContain('error: unknown target "web"');
    expect(target.err.text).toContain("known: api, db");
    expect(target.err.text).toContain("u8 status");
    expect(target.err.text).not.toContain("    at ");
  });

  it("does not repeat a hint the message already gave", () => {
    const target = io();
    reportError(
      new U8Error("CONFIG_NOT_FOUND", "no u8.jsonc in /tmp — run `u8 init` to create one"),
      target,
      createStyler(false),
    );

    expect(target.err.text.match(/u8 init/g)).toHaveLength(1);
  });

  it("prints a config error's whole issue list", () => {
    const target = io();
    const code = reportError(
      new ConfigError(
        "invalid workspace config",
        [
          { path: "repos.web.path", message: "expected string" },
          { path: "profiles.dev", message: "unknown target" },
        ],
        "/ws/u8.jsonc",
      ),
      target,
      createStyler(false),
    );

    expect(code).toBe(1);
    expect(target.err.text).toContain("/ws/u8.jsonc");
    expect(target.err.text).toContain("• repos.web.path: expected string");
    expect(target.err.text).toContain("• profiles.dev: unknown target");
  });

  it("prints the stack of an error nobody anticipated — that one is a bug report", () => {
    const target = io();
    const code = reportError(new TypeError("cannot read properties of undefined"), target, createStyler(false));

    expect(code).toBe(1);
    expect(target.err.text).toContain("unexpected error:");
    expect(target.err.text).toContain("TypeError");
    expect(target.err.text).toContain("    at ");
  });
});

describe("shouldUseColor", () => {
  it("follows --no-color, then NO_COLOR, then FORCE_COLOR, then the terminal", () => {
    expect(shouldUseColor(io({}, true), false)).toBe(false);
    expect(shouldUseColor(io({ FORCE_COLOR: "1" }, true), false)).toBe(false);

    expect(shouldUseColor(io({ NO_COLOR: "1" }, true), undefined)).toBe(false);
    expect(shouldUseColor(io({ NO_COLOR: "" }, true), undefined)).toBe(true);

    expect(shouldUseColor(io({ FORCE_COLOR: "1" }, false), undefined)).toBe(true);
    expect(shouldUseColor(io({ FORCE_COLOR: "0" }, false), undefined)).toBe(false);

    expect(shouldUseColor(io({}, true), undefined)).toBe(true);
    expect(shouldUseColor(io({}, false), undefined)).toBe(false);
  });
});
