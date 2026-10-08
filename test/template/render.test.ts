import { describe, expect, it } from "vitest";
import {
  displayWidth,
  parseTemplate,
  renderTemplate,
  stripAnsi,
  type IndicatorLookup,
} from "../../src/template/index.js";
import { emptyLookup, lookupOf } from "./fixtures.js";

const plain = { color: false } as const;
const colored = { color: true } as const;

const ROW = "{app@status} {app@name:pad(12)}|{git@branch:color(yellow):max(8)}|{version:dim}";

function row(name: string, branch: string, version = "1.0.0"): string {
  return renderTemplate(
    ROW,
    lookupOf({
      "app@status": { value: "running", display: "●", tone: "ok" },
      "app@name": name,
      "git@branch": branch,
      version,
    }),
    colored,
  );
}

describe("values", () => {
  it("renders display in preference to value", () => {
    const lookup = lookupOf({ "app@status": { value: "running", display: "●" } });
    expect(renderTemplate("{app@status}", lookup, plain)).toBe("●");
  });

  it("falls back to value when there is no display", () => {
    expect(renderTemplate("{app@status}", lookupOf({ "app@status": "running" }), plain)).toBe("running");
  });

  it("renders a known-but-empty value as nothing", () => {
    const lookup = lookupOf({ "git@dirty": { value: "", tone: "warn" } });
    expect(renderTemplate("[{git@dirty}]", lookup, colored)).toBe("[]");
  });
});

describe("tones", () => {
  it.each([
    ["ok", "\x1b[32mup\x1b[0m"],
    ["warn", "\x1b[33mup\x1b[0m"],
    ["error", "\x1b[31mup\x1b[0m"],
    ["info", "\x1b[36mup\x1b[0m"],
    ["muted", "\x1b[2;90mup\x1b[0m"],
  ] as const)("%s tone picks a default style", (tone, expected) => {
    const lookup = lookupOf({ "health@status": { value: "up", tone } });
    expect(renderTemplate("{health@status}", lookup, colored)).toBe(expected);
  });

  it("lets an explicit color replace the tone default", () => {
    const lookup = lookupOf({ "health@status": { value: "up", tone: "error" } });
    expect(renderTemplate("{health@status:color(blue)}", lookup, colored)).toBe("\x1b[34mup\x1b[0m");
  });

  it("drops the whole tone default once the token is styled by hand", () => {
    const lookup = lookupOf({ "health@status": { value: "up", tone: "muted" } });
    expect(renderTemplate("{health@status:bold}", lookup, colored)).toBe("\x1b[1mup\x1b[0m");
  });

  it("keeps the tone default when only layout modifiers are used", () => {
    const lookup = lookupOf({ "health@status": { value: "up", tone: "ok" } });
    expect(renderTemplate("{health@status:pad(4)}", lookup, colored)).toBe("\x1b[32mup  \x1b[0m");
  });
});

describe("unknown indicators", () => {
  it("renders a red marker instead of crashing", () => {
    expect(renderTemplate("{git@branch}", emptyLookup, colored)).toBe("\x1b[31m{git@branch!}\x1b[0m");
  });

  it("drops the marker's styling in plain mode", () => {
    expect(renderTemplate("{git@branch:pad(20)}", emptyLookup, plain)).toBe("{git@branch!}");
  });

  it("leaves the known parts of the row rendered", () => {
    const out = renderTemplate("{app@name} {nope@thing}", lookupOf({ "app@name": "api" }), plain);
    expect(out).toBe("api {nope@thing!}");
  });

  it("marks an unknown bare token as it was written, with no namespace invented for it", () => {
    expect(renderTemplate("{version}", emptyLookup, colored)).toBe("\x1b[31m{version!}\x1b[0m");
    expect(renderTemplate("{version:pad(20)}", emptyLookup, plain)).toBe("{version!}");
  });
});

describe("bare tokens", () => {
  it("are looked up with an empty namespace and nothing else answers them", () => {
    const asked: Array<[string, string]> = [];
    const lookup: IndicatorLookup = (ns, name) => {
      asked.push([ns, name]);
      return ns === "" && name === "version"
        ? { ns, name, scope: "app", owner: "gateway", value: "1.2.3" }
        : undefined;
    };
    expect(renderTemplate("{version} {app@version} {name}", lookup, plain)).toBe(
      "1.2.3 {app@version!} {name!}",
    );
    expect(asked).toEqual([
      ["", "version"],
      ["app", "version"],
      ["", "name"],
    ]);
  });
});

describe("plain mode", () => {
  it("is byte-identical to the colored output with escapes stripped", () => {
    const rich = row("api", "feature/login-form");
    const flat = renderTemplate(
      ROW,
      lookupOf({
        "app@status": { value: "running", display: "●", tone: "ok" },
        "app@name": "api",
        "git@branch": "feature/login-form",
        version: "1.0.0",
      }),
      plain,
    );
    expect(flat).toBe(stripAnsi(rich));
    expect(flat).not.toMatch(/\x1b/);
  });

  it("emits no escapes even for unknown tokens and tone defaults", () => {
    const lookup = lookupOf({ "app@status": { value: "running", display: "●", tone: "ok" } });
    expect(renderTemplate("{app@status} {git@branch}", lookup, plain)).toBe("● {git@branch!}");
  });

  it("strips escapes the value itself carried", () => {
    // A config-declared indicator is command stdout; `--json`/pipes asked for no color at all.
    const lookup = lookupOf({ version: "\x1b[32m1.2.3\x1b[0m" });
    expect(renderTemplate("v{version:pad(8)}|", lookup, plain)).toBe("v1.2.3   |");
  });
});

describe("purity", () => {
  it("does not let one styled token poison the tone defaults of the next", () => {
    const lookup = lookupOf({
      "health@status": { value: "up", tone: "muted" },
      version: { value: "1.0", tone: "muted" },
    });
    expect(renderTemplate("{health@status:bold}", lookup, colored)).toBe("\x1b[1mup\x1b[0m");
    expect(renderTemplate("{version}", lookup, colored)).toBe("\x1b[2;90m1.0\x1b[0m");
  });

  it("renders the same row twice identically", () => {
    const parsed = parseTemplate(ROW);
    const lookup = lookupOf({
      "app@status": { value: "running", display: "●", tone: "ok" },
      "app@name": "api",
      "git@branch": "feature/login-form",
      version: "1.0.0",
    });
    expect(renderTemplate(parsed, lookup, colored)).toBe(renderTemplate(parsed, lookup, colored));
  });
});

describe("column alignment", () => {
  it("aligns separators across rows regardless of value length or styling", () => {
    const short = row("api", "main");
    const long = row("checkout-svc", "feature/login-form");

    expect(stripAnsi(short).indexOf("|")).toBe(stripAnsi(long).indexOf("|"));
    expect(displayWidth(short.split("|")[0] ?? "")).toBe(displayWidth(long.split("|")[0] ?? ""));
  });

  it("keeps every styled cell at its declared width", () => {
    const cells = stripAnsi(row("api", "feature/login-form")).split("|");
    // "●" + " " + name padded to 12 columns.
    expect(displayWidth(cells[0] ?? "")).toBe(14);
    expect(cells[0]).toMatch(/^● api +$/);
    expect(cells[1]).toBe("feature…");
    expect(displayWidth(cells[1] ?? "")).toBe(8);
  });

  it("lets an oversized value push the row, unless max() caps it", () => {
    const lookup = lookupOf({ "app@name": "checkout-service" });
    expect(displayWidth(renderTemplate("{app@name:pad(12)}", lookup, colored))).toBe(16);
    expect(displayWidth(renderTemplate("{app@name:max(12):pad(12)}", lookup, colored))).toBe(12);
  });

  it("renders a pre-parsed template identically to a raw one", () => {
    const parsed = parseTemplate(ROW);
    const lookup = lookupOf({
      "app@status": { value: "running", display: "●", tone: "ok" },
      "app@name": "api",
      "git@branch": "main",
      version: "1.0.0",
    });
    expect(renderTemplate(parsed, lookup, colored)).toBe(renderTemplate(ROW, lookup, colored));
  });
});

describe("defaults", () => {
  it("colors by default when no options are passed", () => {
    const lookup = lookupOf({ "app@name": { value: "api", tone: "ok" } });
    expect(renderTemplate("{app@name}", lookup)).toBe("\x1b[32mapi\x1b[0m");
  });
});
