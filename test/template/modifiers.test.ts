import { describe, expect, it } from "vitest";
import {
  displayWidth,
  MAX_MODIFIER_WIDTH,
  parseTemplate,
  renderTemplate,
  RESET,
  stripAnsi,
  type RenderOptions,
} from "../../src/template/index.js";
import { lookupOf } from "./fixtures.js";

const plain: RenderOptions = { color: false };
const colored: RenderOptions = { color: true };

function render(template: string, value: string, opts: RenderOptions = plain): string {
  return renderTemplate(template, lookupOf({ "app@name": value }), opts);
}

describe("pad(n)", () => {
  it("right-pads to the requested width", () => {
    expect(render("{app@name:pad(6)}", "api")).toBe("api   ");
    expect(displayWidth(render("{app@name:pad(6)}", "api"))).toBe(6);
  });

  it("leaves text wider than n untouched rather than clipping", () => {
    expect(render("{app@name:pad(3)}", "gateway")).toBe("gateway");
  });

  it("pads an empty value to a full column", () => {
    expect(render("{app@name:pad(4)}", "")).toBe("    ");
  });

  it("measures visible width, not bytes, when a value carries its own ANSI", () => {
    const value = "\x1b[31mERR\x1b[0m";
    expect(displayWidth(render("{app@name:pad(6)}", value))).toBe(6);
    expect(stripAnsi(render("{app@name:pad(6)}", value))).toBe("ERR   ");
  });
});

describe("max(n)", () => {
  it("truncates with an ellipsis that counts toward the budget", () => {
    const out = render("{app@name:max(10)}", "feature/login-form");
    expect(out).toBe("feature/l…");
    expect(displayWidth(out)).toBe(10);
  });

  it("leaves text at or below the budget alone", () => {
    expect(render("{app@name:max(7)}", "gateway")).toBe("gateway");
    expect(render("{app@name:max(9)}", "gateway")).toBe("gateway");
  });

  it("degrades to a bare ellipsis at width 1 and to nothing at width 0", () => {
    expect(render("{app@name:max(1)}", "gateway")).toBe("…");
    expect(render("{app@name:max(0)}", "gateway")).toBe("");
  });

  it("cuts on visible columns, not bytes, when a value carries its own ANSI", () => {
    // An `x@` indicator is arbitrary command stdout — routinely colored.
    const out = render("{app@name:max(5)}", "\x1b[31mERROR-LONG\x1b[0m", colored);
    expect(stripAnsi(out)).toBe("ERRO…");
    expect(displayWidth(out)).toBe(5);
  });

  it("never leaves a half-eaten escape sequence behind", () => {
    const out = render("{app@name:max(4)}", "\x1b[31mERROR-LONG\x1b[0m", colored);
    expect(stripAnsi(out)).not.toMatch(/\x1b/);
    expect(out.endsWith(RESET)).toBe(true);
  });

  it("keeps a colored value from bleeding into the next cell", () => {
    const out = renderTemplate(
      "{app@name:max(4)}|{app@name}",
      lookupOf({ "app@name": "\x1b[31mERROR-LONG\x1b[0m" }),
      colored,
    );
    const [cell] = out.split("|");
    expect(cell?.endsWith(RESET)).toBe(true);
  });
});

describe("pad and max compose left to right", () => {
  it("pad then max truncates the padding", () => {
    const out = render("{app@name:pad(10):max(5)}", "ab");
    expect(out).toBe("ab  …");
    expect(displayWidth(out)).toBe(5);
  });

  it("max then pad re-fills the column", () => {
    const out = render("{app@name:max(5):pad(10)}", "abcdefgh");
    expect(out).toBe("abcd…     ");
    expect(displayWidth(out)).toBe(10);
  });
});

describe("absurd widths", () => {
  it("rejects a width past the cap instead of throwing out of the render loop", () => {
    // `" ".repeat(9999999999)` is a RangeError; a template typo must stay a warning.
    const template = "{app@name:pad(9999999999)}";
    expect(parseTemplate(template).warnings[0]?.message).toMatch(/between 0 and 1000/);
    expect(render(template, "api")).toBe("api");
  });

  it("rejects a width that would allocate a huge row", () => {
    expect(render(`{app@name:pad(${MAX_MODIFIER_WIDTH + 1})}`, "api")).toBe("api");
    expect(render(`{app@name:max(${MAX_MODIFIER_WIDTH + 1})}`, "api")).toBe("api");
  });

  it("still honours the cap itself", () => {
    expect(displayWidth(render(`{app@name:pad(${MAX_MODIFIER_WIDTH})}`, "api"))).toBe(MAX_MODIFIER_WIDTH);
  });
});

describe("style modifiers", () => {
  it.each([
    ["color(green)", "\x1b[32mapi\x1b[0m"],
    ["color(gray)", "\x1b[90mapi\x1b[0m"],
    ["dim", "\x1b[2mapi\x1b[0m"],
    ["bold", "\x1b[1mapi\x1b[0m"],
    ["bold:dim:color(red)", "\x1b[1;2;31mapi\x1b[0m"],
  ])("%s emits one SGR pair", (modifier, expected) => {
    expect(render(`{app@name:${modifier}}`, "api", colored)).toBe(expected);
  });

  it("ignores a rejected modifier instead of failing the row", () => {
    expect(render("{app@name:color(chartreuse)}", "api", colored)).toBe("api");
  });

  it("emits no escape sequence for an empty value", () => {
    expect(render("{app@name:color(red)}", "", colored)).toBe("");
  });

  it("styles the padding too, keeping the column width intact", () => {
    const out = render("{app@name:pad(8):color(cyan)}", "api", colored);
    expect(out).toBe("\x1b[36mapi     \x1b[0m");
    expect(displayWidth(out)).toBe(8);
  });
});
