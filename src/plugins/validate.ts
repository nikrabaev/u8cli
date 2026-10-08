/**
 * Structural validation of what a plugin module exported — and, when that export
 * is a factory, the call that turns the workspace's options into a definition.
 *
 * Plugins are trusted code (SPEC §6), so this is not a sandbox — it is the
 * difference between "your plugin is missing a `run` function" and a
 * `TypeError` thrown from inside the engine ten minutes later. Every rejection
 * names the spec, the offending key and what was expected, because the message
 * is all the author gets: the plugin is disabled, not retried.
 */
import { BARE_NAME_PATTERN, CORE_COMMAND_NAMESPACE, NAME_PATTERN, REPO_NAMESPACE } from "../config/index.js";
import { CUSTOM_NAMESPACE } from "../indicators/index.js";
import type { HookDef, IndicatorDef, PluginCommandDef, PluginDefinition } from "../plugin/types.js";
import { errorMessage, U8Error } from "../util/errors.js";

/** Namespaces a plugin may not claim: `app:start`, `{repo@name}` and `{x@version}` are taken. */
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  CORE_COMMAND_NAMESPACE,
  REPO_NAMESPACE,
  CUSTOM_NAMESPACE,
]);

/**
 * Named export a plugin may offer instead of a function default export, for a
 * module that wants to keep exporting a ready-made instance as its default (the
 * `health` built-in does: importing it directly still yields a working plugin).
 */
export const PLUGIN_FACTORY_EXPORT = "createPlugin";

/** A plugin module's factory form: its options in, a definition out. */
export type PluginFactory = (options: Record<string, unknown>) => unknown;

/**
 * The factory a module exports, if it exports one.
 *
 * Four shapes, because a plugin is authored in whatever module system its
 * workspace uses: the module *is* a function (CJS `module.exports = fn`), its
 * default export is one, or either carries the {@link PLUGIN_FACTORY_EXPORT}
 * named export.
 */
export function pluginFactoryOf(mod: unknown): PluginFactory | undefined {
  if (typeof mod === "function") return mod as PluginFactory;
  if (!isRecord(mod)) return undefined;
  const fromDefault = mod["default"];
  if (typeof fromDefault === "function") return fromDefault as PluginFactory;
  const named = mod[PLUGIN_FACTORY_EXPORT];
  if (typeof named === "function") return named as PluginFactory;
  const nested = isRecord(fromDefault) ? fromDefault[PLUGIN_FACTORY_EXPORT] : undefined;
  if (typeof nested === "function") return nested as PluginFactory;
  return undefined;
}

/**
 * Turns what a module exported into the thing to validate: the definition
 * itself, or whatever its factory builds from `options`.
 *
 * Options with nowhere to go are an error rather than a shrug. A workspace that
 * configured a plugin which cannot read configuration would otherwise show every
 * sign of having been configured — the plugin loads, the dashboard renders — and
 * none of the setting's effect, which is the single hardest kind of config bug
 * to see.
 *
 * @throws U8Error `PLUGIN_LOAD` for that case, and for a factory that throws.
 */
export function instantiatePlugin(
  mod: unknown,
  options: Record<string, unknown> | undefined,
  spec: string,
): unknown {
  const factory = pluginFactoryOf(mod);
  if (!factory) {
    if (options === undefined || Object.keys(options).length === 0) return mod;
    throw fail(
      spec,
      `options were configured for it, but it exports a plugin definition rather than a factory — ` +
        `export a function taking its options (export default (options) => definePlugin({ ... })), ` +
        `or remove the options from u8.jsonc`,
      declaredName(mod),
    );
  }
  let built: unknown;
  try {
    built = factory(options ?? {});
  } catch (err) {
    // Same shape as a setup() failure: the plugin is disabled and the author
    // gets told which of its two phases refused.
    throw fail(spec, `creating it from its options failed: ${errorMessage(err)}`, declaredName(mod));
  }
  if (isThenable(built)) {
    // Named, because the generic "expected a plugin definition object, got a
    // object" a Promise would otherwise earn sends an author looking in
    // precisely the wrong place.
    throw fail(
      spec,
      `its factory returned a promise: build the definition synchronously and do async work in setup(), ` +
        `which the host awaits and deadlines`,
    );
  }
  return built;
}

function isThenable(value: unknown): boolean {
  return isRecord(value) && typeof value["then"] === "function";
}

/** The `name` a non-factory module declared, so a failure can be attributed. */
function declaredName(mod: unknown): string | undefined {
  const candidate = unwrapDefault(mod);
  if (!isRecord(candidate)) return undefined;
  const name = candidate["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

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
    requireCommandName(key, spec, name, at);
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

/**
 * A command may name sub-commands with `:` — `link:protos` under the `protos`
 * plugin is invoked as `protos:link:protos`, next to the `protos:link` that does
 * every package at once. Every segment is still a bare name, and the plugin's
 * own namespace is still added for it, so this only buys a *hierarchy* under a
 * namespace nobody else can claim.
 *
 * Indicators deliberately do not get this: `:` separates modifiers inside a
 * template token (`{git@branch:max(20)}`), so a colon in an indicator name would
 * be unrenderable rather than merely unusual.
 */
function requireCommandName(key: string, spec: string, plugin: string, at: string): void {
  const segments = key.split(":");
  if (segments.length > 0 && segments.every((segment) => BARE_NAME_PATTERN.test(segment))) return;
  throw fail(
    spec,
    `invalid name in ${at}: use letters, digits, ".", "_" or "-", or ":" between them for a sub-command ` +
      `(link:protos) — the plugin's namespace is added for you`,
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
