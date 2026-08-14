import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { statePaths } from "../../src/util/paths.js";

describe("socket path length", () => {
  const withHome = (home: string): string => {
    const prev = process.env.U8_STATE_HOME;
    process.env.U8_STATE_HOME = home;
    try {
      return statePaths("/some/workspace/u8.jsonc").socket;
    } finally {
      if (prev === undefined) delete process.env.U8_STATE_HOME;
      else process.env.U8_STATE_HOME = prev;
    }
  };

  it("keeps the socket in the state dir when the path is short enough", () => {
    const socket = withHome("/tmp/u8t");
    expect(socket.startsWith("/tmp/u8t/")).toBe(true);
    expect(socket.endsWith("daemon.sock")).toBe(true);
  });

  it("falls back to the temp dir when the state dir would exceed the kernel cap", () => {
    // connect() answers EINVAL past ~104 bytes, naming no cause.
    const socket = withHome(`/tmp/${"deeply-nested-directory/".repeat(6)}`);
    expect(socket.startsWith(os.tmpdir())).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
  });

  it("derives the same fallback for every caller, so client and daemon still meet", () => {
    const home = `/tmp/${"deeply-nested-directory/".repeat(6)}`;
    expect(withHome(home)).toBe(withHome(home));
    expect(path.isAbsolute(withHome(home))).toBe(true);
  });
});
