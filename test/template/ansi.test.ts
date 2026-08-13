import { describe, expect, it } from "vitest";
import { applyStyle, displayWidth, segmentText, stripAnsi } from "../../src/template/index.js";

describe("stripAnsi", () => {
  it("removes SGR sequences and leaves the text", () => {
    expect(stripAnsi("\x1b[1;2;31mboom\x1b[0m")).toBe("boom");
  });

  it("removes cursor and OSC sequences too", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Ghi")).toBe("hi");
    expect(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("● api  main")).toBe("● api  main");
  });
});

describe("displayWidth", () => {
  it("counts visible code points, not bytes", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("●")).toBe(1);
  });

  it("ignores escape sequences", () => {
    expect(displayWidth("\x1b[32mok\x1b[0m")).toBe(2);
    expect(displayWidth(applyStyle("padded    ", { color: "red", bold: true }))).toBe(10);
  });

  it("does not count combining marks as columns", () => {
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("é")).toBe(1);
  });
});

describe("segmentText", () => {
  it("keeps an escape sequence whole and free of columns", () => {
    expect([...segmentText("\x1b[31mab")]).toEqual([
      { text: "\x1b[31m", width: 0, ansi: true },
      { text: "a", width: 1, ansi: false },
      { text: "b", width: 1, ansi: false },
    ]);
  });

  it("walks astral code points as single units", () => {
    expect([...segmentText("👍")].map((s) => s.text)).toEqual(["👍"]);
  });

  it("treats a stray escape byte as ordinary text rather than eating the rest", () => {
    expect([...segmentText("\x1bx")].map((s) => s.text)).toEqual(["\x1b", "x"]);
  });

  it("is reentrant — a nested walk does not disturb the outer one", () => {
    const outer = segmentText("\x1b[31mab");
    const first = outer.next();
    expect(displayWidth("\x1b[32mzz")).toBe(2);
    expect(first.value).toEqual({ text: "\x1b[31m", width: 0, ansi: true });
    expect([...outer].map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("applyStyle", () => {
  it("is a no-op for empty text or an empty style", () => {
    expect(applyStyle("", { color: "red" })).toBe("");
    expect(applyStyle("api", {})).toBe("api");
  });

  it("emits bold, dim and color in a stable order", () => {
    expect(applyStyle("x", { color: "blue", dim: true, bold: true })).toBe("\x1b[1;2;34mx\x1b[0m");
  });
});
