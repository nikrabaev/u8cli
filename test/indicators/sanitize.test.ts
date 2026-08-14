import { describe, expect, it } from "vitest";
import {
  INDICATOR_ELLIPSIS,
  MAX_INDICATOR_LENGTH,
  sanitizeIndicatorText,
} from "../../src/indicators/index.js";

describe("sanitizeIndicatorText", () => {
  it("passes an ordinary value through untouched", () => {
    expect(sanitizeIndicatorText("v1.4.2")).toBe("v1.4.2");
  });

  it("collapses every kind of whitespace run into one space", () => {
    // \x0b (vertical tab) is whitespace, not a control char to strip.
    expect(sanitizeIndicatorText("one\ntwo\r\nthree\tfour\x0bfive   six")).toBe(
      "one two three four five six",
    );
  });

  it("trims the edges", () => {
    expect(sanitizeIndicatorText("\n  padded  \n")).toBe("padded");
  });

  it("removes C0 and C1 control characters", () => {
    expect(sanitizeIndicatorText("a\x00b\x07c\x1fd\x7fe\x9ff")).toBe("abcdef");
  });

  it("keeps a stripped control from becoming a double space", () => {
    expect(sanitizeIndicatorText("left \x00 right")).toBe("left right");
  });

  it("removes whole escape sequences, not just the escape byte", () => {
    expect(sanitizeIndicatorText("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeIndicatorText("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("caps an over-long value with an ellipsis", () => {
    const out = sanitizeIndicatorText("y".repeat(5_000));
    expect(out).toHaveLength(MAX_INDICATOR_LENGTH);
    expect(out.endsWith(INDICATOR_ELLIPSIS)).toBe(true);
    expect(out.slice(0, -1)).toBe("y".repeat(MAX_INDICATOR_LENGTH - 1));
  });

  it("never cuts a surrogate pair in half", () => {
    // The 200th code unit lands mid-emoji; the whole pair is dropped instead.
    const out = sanitizeIndicatorText(`${"z".repeat(MAX_INDICATOR_LENGTH - 2)}🙂🙂`);
    expect(out.endsWith(INDICATOR_ELLIPSIS)).toBe(true);
    expect(out).not.toContain("�");
    expect([...out].every((ch) => ch === "z" || ch === INDICATOR_ELLIPSIS)).toBe(true);
  });

  it("leaves an exactly-max value alone", () => {
    const exact = "w".repeat(MAX_INDICATOR_LENGTH);
    expect(sanitizeIndicatorText(exact)).toBe(exact);
  });

  it("reduces an all-whitespace value to empty", () => {
    expect(sanitizeIndicatorText("  \n\t  ")).toBe("");
  });
});
