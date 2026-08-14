#!/usr/bin/env node
/**
 * Emits `schema.json` from the zod config schema so editors can validate
 * `u8.jsonc` via its `$schema` key. Runs after `tsc`, against the built output.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Skipping is right during a normal build (the first `tsc` may not have run
 * yet), but fatal at pack time: a publish from a clean clone would silently
 * ship a stale or missing schema that every generated config points at.
 */
const strict = process.argv.includes("--strict");

const bail = (message) => {
  if (strict) {
    console.error(`[gen-schema] ${message}`);
    process.exit(1);
  }
  console.warn(`[gen-schema] ${message} — skipping`);
  process.exit(0);
};

let mod;
try {
  mod = await import(path.join(root, "dist/config/schema.js"));
} catch {
  bail("dist/config/schema.js not built yet");
}

const schema = mod.jsonSchema ?? mod.configJsonSchema;
if (!schema) {
  bail("no `jsonSchema` export found");
}

const out = typeof schema === "function" ? schema() : schema;
writeFileSync(path.join(root, "schema.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("[gen-schema] wrote schema.json");
