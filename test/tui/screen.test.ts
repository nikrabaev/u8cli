/**
 * The alternate screen, tested on a fake stream.
 *
 * Ink's own test renderer never exercises any of this — its fake stdout is not a
 * TTY, so every escape below is correctly suppressed there. That suppression is
 * the guarantee worth pinning: an escape sequence written into a pipe is
 * corruption, and `u8 status | head` shares this process.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { enterAltScreen, resetAltScreenForTests } from "../../src/tui/screen.js";

interface FakeTty {
  stream: NodeJS.WriteStream;
  written: string;
}

function fakeTty(isTTY: boolean): FakeTty {
  const out: FakeTty = { written: "", stream: undefined as unknown as NodeJS.WriteStream };
  out.stream = {
    isTTY,
    write(chunk: string): boolean {
      out.written += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return out;
}

beforeEach(() => {
  resetAltScreenForTests();
});

describe("enterAltScreen", () => {
  it("switches buffers and homes the cursor, without clearing the screen", () => {
    const tty = fakeTty(true);
    const screen = enterAltScreen(tty.stream, { enabled: true });

    expect(screen.active).toBe(true);
    expect(tty.written).toContain("\x1b[?1049h");
    expect(tty.written).toContain("\x1b[H");
    // `2J` would wipe the visible screen on a terminal that ignores 1049, and
    // 1049h already gives us a blank buffer on one that does not.
    expect(tty.written).not.toContain("\x1b[2J");
    // `3J` erases saved lines — the frame budget exists to keep ink from ever
    // emitting it, so we must not emit it ourselves either.
    expect(tty.written).not.toContain("\x1b[3J");
  });

  it("restores the cursor before switching back, and only once", () => {
    const tty = fakeTty(true);
    const screen = enterAltScreen(tty.stream, { enabled: true });
    tty.written = "";

    screen.restore();
    const leave = tty.written;

    // DECTCEM is a global mode: 1049l does not put the cursor back, so a crash
    // before ink's own cleanup would leave the user typing invisibly.
    expect(leave).toContain("\x1b[?25h");
    expect(leave.indexOf("\x1b[?25h")).toBeLessThan(leave.indexOf("\x1b[?1049l"));
    expect(leave).toContain("\x1b[?2026l");

    // Called from both the finally and the process exit hook.
    tty.written = "";
    screen.restore();
    expect(tty.written).toBe("");
  });

  it("writes nothing at all to a stream that is not a terminal", () => {
    const pipe = fakeTty(false);
    const screen = enterAltScreen(pipe.stream, { enabled: true });

    expect(screen.active).toBe(false);
    expect(pipe.written).toBe("");
    screen.restore();
    expect(pipe.written).toBe("");
  });

  it("writes nothing when the caller opted out", () => {
    const tty = fakeTty(true);
    const screen = enterAltScreen(tty.stream, { enabled: false });

    expect(screen.active).toBe(false);
    expect(tty.written).toBe("");
    screen.restore();
    expect(tty.written).toBe("");
  });

  it("refuses to nest, so the first restore cannot strand the second dashboard", () => {
    const tty = fakeTty(true);
    const first = enterAltScreen(tty.stream, { enabled: true });
    tty.written = "";

    const second = enterAltScreen(tty.stream, { enabled: true });
    expect(second.active).toBe(false);
    expect(tty.written).toBe("");

    second.restore();
    expect(tty.written).toBe("");
    first.restore();
    expect(tty.written).toContain("\x1b[?1049l");
  });

  it("frees the screen once restored, so a later dashboard can take it", () => {
    const tty = fakeTty(true);
    enterAltScreen(tty.stream, { enabled: true }).restore();

    expect(enterAltScreen(tty.stream, { enabled: true }).active).toBe(true);
  });

  it("survives a stream that has already been destroyed", () => {
    const tty = fakeTty(true);
    const screen = enterAltScreen(tty.stream, { enabled: true });
    // The EPIPE path destroys stdout before the exit hook runs.
    (tty.stream as unknown as { write: () => never }).write = () => {
      throw new Error("EPIPE");
    };

    expect(() => screen.restore()).not.toThrow();
  });
});
