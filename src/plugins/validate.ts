/**
 * Structural validation of what a plugin module exported.
 *
 * Plugins are trusted code (SPEC §6), so this is not a sandbox — it is the
 * difference between "your plugin is missing a `run` function" and a
 * `TypeError` thrown from inside the engine ten minutes later. Every rejection
 * names the spec, the offending key and what was expected, because the message
 * is all the author gets: the plugin is disabled, not retried.
 */
import { BARE_NAME_PATTERN, CORE_COMMAND_NAMESPACE, NAME_PATTERN } from "../config/index.js";
import { CUSTOM_NAMESPACE } from "../indicators/index.js";
import type { HookDef, IndicatorDef, PluginCommandDef, PluginDefinition } from "../plugin/types.js";
import { U8Error } from "../util/errors.js";

/** Namespaces a plugin may not claim: `app:start` and `{x@version}` are taken. */
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([CORE_COMMAND_NAMESPACE, CUSTOM_NAMESPACE]);

/**
 * Narrows a module to a plugin definition.
 *
 * Accepts the definition as the default export or as the module itself, and
 * unwraps one extra `default` for a transpiled CommonJS plugin whose
 * `module.exports` is itself `{ default, __esModule }`.
 *
 * @throws U8Error `PLUGIN_LOAD` with a message aimed at the plugin author.
 */
export function validatePluginDefinition(mod: unknown, spec: string): PluginDefinition {
  const candidate = unwrapDefault(mod);
  if (!isPlainRecord(candidate)) {
    throw fail(spec, `expected a plugin definition object, got ${describe(candidate)} — ` +
      `export the result of definePlugin() as the default export`);
  }

  const name = candidate["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw fail(spec, `"name" is required and must be a non-empty string`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw fail(
      spec,
      `invalid plugin name "${name}": it becomes a namespace (${name}:command, {${name}@indicator}), ` +
        `so use letters, digits, "_" or "-", starting with a letter or digit`,
    );
  }
  if (RESERVED_NAMESPACES.has(name)) {
    throw fail(spec, `plugin name "${name}" is reserved by u8cli itself`, name);
  }

  const indicators = section(candidate["indicators"], spec, name, "indicators");
  const commands = section(candidate["commands"], spec, name, "commands");
  const hooks = section(candidate["hooks"], spec, name, "hooks");

  for (const [key, def] of Object.entries(indicators)) {
    const at = `indicators.${key}`;
    requireBareName(key, spec, name, at);
    requireRecord(def, spec, name, at);
    optionalFunction(def, "value", spec, name, at);
    optionalFunction(def, "subscribe", spec, name, at);
  }

  for (const [key, def] of Object.entries(commands)) {
    const at = `commands.${key}`;
    requireBareName(key, spec, name, at);
    requireRecord(def, spec, name, at);
    if (typeof (def as Record<string, unknown>)["run"] !== "function") {
      throw fail(spec, `${at} must define a run() function`, name);
    }
    optionalFunction(def, "appliesTo", spec, name, at);
  }

  for (const [key, def] of Object.entries(hooks)) {
    const at = `hooks["${key}"]`;
    if (key.length === 0) throw fail(spec, `a hook binding must name a command, or "*" for all of them`, name);
    requireRecord(def, spec, name, at);
    optionalFunction(def, "pre", spec, name, at);
    optionalFunction(def, "post", spec, name, at);
  }

  optionalFunction(candidate, "readiness", spec, name, "readiness");
  optionalFunction(candidate, "setup", spec, name, "setup");
  optionalFunction(candidate, "teardown", spec, name, "teardown");

  return {
    ...(candidate as unknown as PluginDefinition),
    name,
    indicators: indicators as Record<string, IndicatorDef>,
    commands: commands as Record<string, PluginCommandDef>,
    hooks: hooks as Record<string, HookDef>,
  };
}

/** `PLUGIN_LOAD`, carrying the declared name so a failure can still be attributed. */
export function fail(spec: string, message: string, plugin?: string): U8Error {
  return new U8Error("PLUGIN_LOAD", `plugin "${spec}": ${message}`, { spec, plugin });
}

/** The plugin name a `PLUGIN_LOAD` error was raised about, when it got that far. */
export function declaredNameOf(err: unknown): string | undefined {
  if (!(err instanceof U8Error) || !isRecord(err.details)) return undefined;
  const plugin = err.details["plugin"];
  return typeof plugin === "string" && plugin.length > 0 ? plugin : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A module namespace, a `default` export, or a CJS `exports.default` — two
 * levels is exactly what `export default definePlugin(...)` compiled to
 * CommonJS and re-imported from ESM unwraps to.
 */
function unwrapDefault(mod: unknown): unknown {
  let out = mod;
  for (let depth = 0; depth < 2; depth++) {
    if (!isRecord(out)) return out;
    const inner = out["default"];
    if (!isRecord(inner)) return out;
    out = inner;
  }
  return out;
}

function section(
  value: unknown,
  spec: string,
  plugin: string,
  what: string,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) throw fail(spec, `"${what}" must be an object, got ${describe(value)}`, plugin);
  return value;
}

function requireRecord(value: unknown, spec: string, plugin: string, at: string): void {
  if (!isPlainRecord(value)) throw fail(spec, `${at} must be an object, got ${describe(value)}`, plugin);
}

function requireBareName(key: string, spec: string, plugin: string, at: string): void {
  if (BARE_NAME_PATTERN.test(key)) return;
  throw fail(
    spec,
    `invalid name in ${at}: use letters, digits, ".", "_" or "-" — the namespace is added for you`,
    plugin,
  );
}

function optionalFunction(
  holder: unknown,
  field: string,
  spec: string,
  plugin: string,
  at: string,
): void {
  if (!isRecord(holder)) return;
  const value = holder[field];
  if (value === undefined || typeof value === "function") return;
  throw fail(spec, `${at === field ? field : `${at}.${field}`} must be a function, got ${describe(value)}`, plugin);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Every keyed section of a definition is a map from a name to a definition, and
 * an array satisfies `typeof x === "object"` while satisfying nothing an author
 * meant: `commands: [{ run() {} }]` would otherwise register a command called
 * `0`. Rejecting it here is the difference between a readable error and a
 * plugin that loads and does the wrong thing.
 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}
