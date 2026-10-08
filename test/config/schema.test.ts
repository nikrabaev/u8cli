import { describe, expect, it } from "vitest";
import { jsonSchema } from "../../src/config/schema.js";

describe("jsonSchema", () => {
  it("emits a JSON Schema covering the whole config surface", () => {
    const schema = jsonSchema() as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, unknown>;

    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["repos"]);
    // Unknown top-level keys are rejected, so editors flag typos too.
    expect(schema["additionalProperties"]).toBe(false);
    expect(Object.keys(properties).sort()).toEqual([
      "$schema",
      "builtins",
      "commands",
      "env",
      "indicators",
      "instances",
      "limits",
      "name",
      "plugins",
      "profiles",
      "repos",
      "templates",
      "vars",
    ]);
  });

  it("constrains repo names so target ids stay unambiguous", () => {
    const schema = jsonSchema() as Record<string, unknown>;
    const repos = (schema["properties"] as Record<string, Record<string, unknown>>)["repos"] ?? {};
    const names = repos["propertyNames"] as Record<string, unknown>;
    expect(names["pattern"]).toBe("^[A-Za-z0-9][A-Za-z0-9_-]*$");
  });

  /**
   * The generated schema is what an editor completes and underlines against, so
   * the two-shapes-per-entry keys have to reach it as real unions — an `anyOf`
   * an editor can offer both halves of, not a widened `any`.
   */
  it("emits both shapes of a built-in and of a plugin entry as unions", () => {
    const props = (jsonSchema() as Record<string, Record<string, unknown>>)["properties"] ?? {};

    const builtins = props["builtins"] as Record<string, Record<string, Record<string, unknown>>>;
    expect(builtins["properties"]?.["git"]?.["type"]).toBe("boolean");
    const protos = (builtins["properties"]?.["protos"]?.["anyOf"] ?? []) as Record<string, unknown>[];
    expect(protos.map((branch) => branch["type"])).toEqual(["boolean", "object"]);
    expect(protos[1]?.["required"]).toEqual(["packages"]);
    expect(protos[1]?.["additionalProperties"]).toBe(false);

    const plugins = props["plugins"] as Record<string, Record<string, unknown>>;
    const entry = (plugins["items"]?.["anyOf"] ?? []) as Record<string, unknown>[];
    expect(entry.map((branch) => branch["type"])).toEqual(["string", "object"]);
    expect(entry[1]?.["required"]).toEqual(["spec"]);
    // Options are the plugin's own business: any object passes.
    expect(Object.keys((entry[1]?.["properties"] ?? {}) as object).sort()).toEqual(["options", "spec"]);
  });
});
