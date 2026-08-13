#!/usr/bin/env node
/**
 * Emits `schema.json` from the zod config schema so editors can validate
 * `u8.jsonc` via its `$schema` key. Runs after `tsc`, against the built output.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let mod;
try {
  mod = await import(path.join(root, "dist/config/schema.js"));
} catch {
  console.warn("[gen-schema] dist/config/schema.js not built yet — skipping");
  process.exit(0);
}

const schema = mod.jsonSchema ?? mod.configJsonSchema;
if (!schema) {
  console.warn("[gen-schema] no `jsonSchema` export found — skipping");
  process.exit(0);
}

const out = typeof schema === "function" ? schema() : schema;
writeFileSync(path.join(root, "schema.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("[gen-schema] wrote schema.json");
