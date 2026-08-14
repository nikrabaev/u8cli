import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "../../src/config/types.js";
import { parseTemplate, renderTemplate, templateTokens, type TokenNode } from "../../src/template/index.js";
import { lookupOf } from "./fixtures.js";

const plain = { color: false } as const;

function tokens(template: string): TokenNode[] {
  return parseTemplate(template).nodes.filter((n): n is TokenNode => n.kind === "token");
}

describe("grammar", () => {
  it("treats a template without tokens as a single literal", () => {
    const parsed = parseTemplate("  status: idle  ");
    expect(parsed.nodes).toEqual([{ kind: "literal", text: "  status: idle  " }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses a lone token", () => {
    const parsed = parseTemplate("{app@status}");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.nodes).toEqual([
      { kind: "token", ns: "app", name: "status", modifiers: [], source: "{app@status}" },
    ]);
  });

  it("keeps literals between tokens, including adjacency", () => {
    const parsed = parseTemplate("[{app@name}] {git@branch}/{x@version}");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.nodes.map((n) => (n.kind === "token" ? `${n.ns}@${n.name}` : n.text))).toEqual([
      "[",
      "app@name",
      "] ",
      "git@branch",
      "/",
      "x@version",
    ]);
  });

  it("accepts dashes, digits and underscores in names", () => {
    expect(tokens("{my-plugin@build_status2}")).toHaveLength(1);
  });

  it("parses colon-chained modifiers in authored order", () => {
    const [token] = tokens("{git@branch:color(yellow):max(15)}");
    expect(token?.modifiers).toEqual([
      { kind: "color", color: "yellow" },
      { kind: "max", width: 15 },
    ]);
  });
});

describe("brace escapes", () => {
  it("renders {{ and }} as literal braces and produces no tokens", () => {
    const parsed = parseTemplate("{{app@name}}");
    expect(parsed.warnings).toEqual([]);
    expect(tokens("{{app@name}}")).toEqual([]);
    expect(renderTemplate(parsed, lookupOf({ "app@name": "api" }), plain)).toBe("{app@name}");
  });

  it("escapes braces around a real token", () => {
    const out = renderTemplate("{{{app@name}}}", lookupOf({ "app@name": "api" }), plain);
    expect(out).toBe("{api}");
  });

  it("passes a lone closing brace through", () => {
    expect(renderTemplate("a } b", lookupOf({}), plain)).toBe("a } b");
  });
});

describe("malformed input", () => {
  it("warns and renders the source text for an unterminated token", () => {
    const parsed = parseTemplate("name: {app@name");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.message).toMatch(/unterminated/);
    expect(parsed.warnings[0]?.index).toBe(6);
    expect(renderTemplate(parsed, lookupOf({ "app@name": "api" }), plain)).toBe("name: {app@name");
  });

  it.each(["{oops}", "{app@}", "{@name}", "{app name}", "{app@na me}", "{}"])(
    "warns and renders %s literally",
    (source) => {
      const parsed = parseTemplate(source);
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]?.message).toMatch(/malformed token/);
      expect(renderTemplate(parsed, lookupOf({ "app@name": "api" }), plain)).toBe(source);
    },
  );

  it("keeps rendering the rest of the row after a malformed token", () => {
    const out = renderTemplate("{nope} {app@name}", lookupOf({ "app@name": "api" }), plain);
    expect(out).toBe("{nope} api");
  });

  it("never throws on adversarial input", () => {
    for (const src of ["{{{", "}}}", "{:::}", "{a@b:::}", "{a@b:pad(", "{", "}"]) {
      expect(() => renderTemplate(src, lookupOf({}), plain)).not.toThrow();
    }
  });
});

describe("modifier diagnostics", () => {
  it("warns about an unknown modifier and drops it", () => {
    const parsed = parseTemplate("{app@name:wat}");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.message).toMatch(/unknown modifier "wat"/);
    expect(tokens("{app@name:wat}")[0]?.modifiers).toEqual([]);
  });

  it.each([
    ["{app@name:pad(x)}", /width/],
    ["{app@name:pad()}", /width/],
    ["{app@name:pad(-1)}", /width/],
    ["{app@name:max(2,3)}", /width/],
    ["{app@name:color(chartreuse)}", /unknown color/],
    ["{app@name:color()}", /one color name/],
    ["{app@name:bold(1)}", /takes no arguments/],
  ])("warns about %s", (template, message) => {
    const parsed = parseTemplate(template);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.message).toMatch(message);
    expect(parsed.nodes.filter((n) => n.kind === "token")).toHaveLength(1);
  });

  it("keeps the valid modifiers of a partially bad chain", () => {
    const [token] = tokens("{app@name:pad(8):nope:bold}");
    expect(token?.modifiers).toEqual([{ kind: "pad", width: 8 }, { kind: "bold" }]);
    expect(parseTemplate("{app@name:pad(8):nope:bold}").warnings).toHaveLength(1);
  });
});

describe("templateTokens", () => {
  it("lists well-formed tokens only, so config validation can check them", () => {
    expect(templateTokens("{app@name:pad(4)} {broken} {git@branch}")).toEqual([
      { ns: "app", name: "name" },
      { ns: "git", name: "branch" },
    ]);
  });

  it("accepts an already-parsed template", () => {
    const parsed = parseTemplate("{app@name} {app@name}");
    expect(templateTokens(parsed)).toEqual([
      { ns: "app", name: "name" },
      { ns: "app", name: "name" },
    ]);
  });
});

describe("shipped defaults", () => {
  it.each(Object.entries(DEFAULT_TEMPLATES))("%s parses without warnings", (_name, template) => {
    const parsed = parseTemplate(template);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.nodes.filter((n) => n.kind === "token").length).toBeGreaterThan(0);
  });

  it("renders the default subapp row against a plausible cache", () => {
    const out = renderTemplate(
      DEFAULT_TEMPLATES.subapp,
      lookupOf({
        "app@status": { value: "running", display: "●", tone: "ok" },
        "app@name": "gateway",
        "health@status": { value: "healthy", tone: "ok" },
      }),
      plain,
    );
    // status and health carry pad() because without colour they fall back to
    // words of varying width ("running"/"starting"), which would shift the row.
    expect(out).toBe(`  ${"●".padEnd(8)} ${"gateway".padEnd(22)} ${"healthy".padEnd(9)}`);
  });
});
