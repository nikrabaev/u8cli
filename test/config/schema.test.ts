import { describe, expect, it } from "vitest";
import { jsonSchema } from "../../src/config/schema.js";

describe("jsonSchema", () => {
  it("emits a JSON Schema covering the whole config surface", () => {
    const schema = jsonSchema() as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, unknown>;

    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["apps"]);
    // Unknown top-level keys are rejected, so editors flag typos too.
    expect(schema["additionalProperties"]).toBe(false);
    expect(Object.keys(properties).sort()).toEqual([
      "$schema",
      "apps",
      "builtins",
      "commands",
      "env",
      "indicators",
      "limits",
      "name",
      "plugins",
      "profiles",
      "templates",
    ]);
  });

  it("constrains app names so target ids stay unambiguous", () => {
    const schema = jsonSchema() as Record<string, unknown>;
    const apps = (schema["properties"] as Record<string, Record<string, unknown>>)["apps"] ?? {};
    const names = apps["propertyNames"] as Record<string, unknown>;
    expect(names["pattern"]).toBe("^[A-Za-z0-9][A-Za-z0-9_-]*$");
  });
});
