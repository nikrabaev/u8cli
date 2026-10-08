import { describe, expect, it } from "vitest";
import { parseInterpolation, parseRef, renderInterpolation } from "../../src/config/interpolate.js";

describe("parseInterpolation", () => {
  it("leaves a string with no reference as one literal", () => {
    expect(parseInterpolation("http://localhost:3000")).toEqual({
      segments: [{ kind: "text", text: "http://localhost:3000" }],
      errors: [],
    });
  });

  it("splits text and references in order", () => {
    expect(parseInterpolation("http://localhost:${api.ports.http}/v1").segments).toEqual([
      { kind: "text", text: "http://localhost:" },
      { kind: "ref", ref: "api.ports.http" },
      { kind: "text", text: "/v1" },
    ]);
  });

  it("treats every $ that does not open a reference as literal", () => {
    for (const text of ["$PATH", "a$b", "cost: 5$", "$(pwd)", "$"]) {
      expect(parseInterpolation(text)).toEqual({ segments: [{ kind: "text", text }], errors: [] });
    }
  });

  it("unescapes $${ to a literal ${", () => {
    expect(parseInterpolation("$${HOME}/bin").segments).toEqual([{ kind: "text", text: "${HOME}/bin" }]);
    expect(parseInterpolation("${ports.http}$${x}").segments).toEqual([
      { kind: "ref", ref: "ports.http" },
      { kind: "text", text: "${x}" },
    ]);
  });

  it("reports an unterminated or empty reference instead of guessing", () => {
    expect(parseInterpolation("http://${ports.http").errors).toHaveLength(1);
    expect(parseInterpolation("a${}b").errors).toEqual(['empty reference "${}"']);
  });

  it("tolerates padding inside the braces", () => {
    expect(parseInterpolation("${ ports.http }").segments).toEqual([{ kind: "ref", ref: "ports.http" }]);
  });
});

describe("parseRef", () => {
  it("reads a two-segment ports reference as the app's own", () => {
    expect(parseRef("ports.http")).toEqual({ kind: "port", name: "http" });
  });

  it("reads the target of a port reference from the right, dots and all", () => {
    expect(parseRef("api.ports.http")).toEqual({ kind: "port", target: "api", name: "http" });
    expect(parseRef("platform.shell.ports.debug")).toEqual({
      kind: "port",
      target: "platform.shell",
      name: "debug",
    });
  });

  it("keeps a repo that is named like a scope addressable", () => {
    expect(parseRef("ports.ports.http")).toEqual({ kind: "port", target: "ports", name: "http" });
    expect(parseRef("instance.ports.http")).toEqual({ kind: "port", target: "instance", name: "http" });
  });

  it("recognises vars and the built-in scopes", () => {
    expect(parseRef("vars.region")).toEqual({ kind: "var", name: "region" });
    expect(parseRef("instance.name")).toEqual({ kind: "builtin", scope: "instance", field: "name" });
    expect(parseRef("base.path")).toEqual({ kind: "builtin", scope: "base", field: "path" });
  });

  it("names the fields a scope does have when asked for one it does not", () => {
    expect(parseRef("instance.port")).toEqual({
      error: 'unknown reference "${instance.port}" — "instance" has "name", "slug", "suffix"',
    });
  });

  it("explains that config values are not shell-expanded for a bare name", () => {
    const result = parseRef("HOME");
    expect("error" in result && result.error).toContain("not shell-expanded");
  });
});

describe("renderInterpolation", () => {
  it("substitutes resolved references and keeps unresolved ones as written", () => {
    const rendered = renderInterpolation(parseInterpolation("${ports.http}:${ports.nope}"), (ref) =>
      ref.kind === "port" && ref.name === "http" ? { value: "3000" } : { error: "no such port" },
    );
    expect(rendered).toEqual({ value: "3000:${ports.nope}", errors: ["no such port"] });
  });
});
