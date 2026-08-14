/**
 * Finding and importing plugin modules — SPEC §2.8.
 *
 * Three kinds of spec share one contract: hand back whatever the module
 * exported, or throw a `PLUGIN_LOAD` error naming exactly what was tried.
 *
 *  - **built-ins** ship inside u8cli and are addressed as files next to this
 *    module, so a build (`dist/plugins/builtin/git.js`) and a source checkout
 *    (`src/plugins/builtin/git.ts`) both work with no registry and no bundler;
 *  - **local** specs (`./x.ts`, `/abs/x.js`) are files under the workspace;
 *  - **everything else** is an npm package resolved from the *workspace's*
 *    `node_modules` — never u8cli's own. A workspace ships its own plugins, and
 *    satisfying its import from u8cli's dependency tree would silently load a
 *    different copy (or a package the user never installed).
 *
 * `.ts` sources go through jiti; anything else through a plain dynamic import.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createJiti, type Jiti } from "jiti";

import type { NormalizedWorkspace } from "../config/types.js";
import { errorMessage, U8Error } from "../util/errors.js";
import { resolvePath } from "../util/paths.js";

/** Plugins that ship with u8cli, in the order they load. */
export const BUILTIN_NAMES = ["git", "health"] as const;

export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/** Marks a built-in in `SnapshotPlugin.spec`; not a spec a user may write. */
export const BUILTIN_SPEC_PREFIX = "builtin:";

/** Extensions tried when a local spec names a file without one. */
const LOCAL_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cjs"] as const;

const TS_EXTENSIONS = [".ts", ".mts", ".cts"] as const;

export type PluginSourceKind = "builtin" | "local" | "package";

export interface PluginSource {
  /** As authored (or `builtin:git`); reported verbatim in `list()`. */
  spec: string;
  kind: PluginSourceKind;
  /** Absolute path for local specs, pre-resolved by config normalization. */
  resolved?: string;
  builtin?: BuiltinName;
}

/**
 * Every plugin the workspace wants, in load order: built-ins first (SPEC §2.8),
 * then `plugins` in config order. Load order is the order hooks run in, so it is
 * part of the contract rather than an implementation detail.
 */
export function pluginSources(ws: NormalizedWorkspace): PluginSource[] {
  const out: PluginSource[] = [];
  for (const name of BUILTIN_NAMES) {
    if (!ws.builtins[name]) continue;
    out.push({ spec: `${BUILTIN_SPEC_PREFIX}${name}`, kind: "builtin", builtin: name });
  }
  for (const ref of ws.plugins) {
    out.push(
      isLocalSpec(ref.spec)
        ? { spec: ref.spec, kind: "local", resolved: ref.resolved ?? resolvePath(ref.spec, ws.rootDir) }
        : { spec: ref.spec, kind: "package" },
    );
  }
  return out;
}

/** A path spec, per SPEC §2.8: anything else is an npm package name. */
export function isLocalSpec(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
}

/**
 * Whether this u8cli install actually ships a built-in.
 *
 * Enabling `builtins.git` is a default, not a request: a build that does not
 * carry the file has no plugin to report as broken, and a permanent error on
 * every dashboard for something the user cannot install would be noise. The
 * host logs the absence instead of recording it as a failed plugin.
 */
export function builtinAvailable(name: BuiltinName): boolean {
  return isFile(builtinPath(name));
}

/** Imports the module a source points at. Rejects with a `PLUGIN_LOAD` error. */
export async function importPluginModule(source: PluginSource, rootDir: string): Promise<unknown> {
  const file = resolveSourceFile(source, rootDir);
  if (TS_EXTENSIONS.some((ext) => file.endsWith(ext))) {
    // jiti, not Node's type stripping: it also resolves the `./x.js` specifiers
    // a NodeNext-compiled plugin writes for its own `.ts` neighbours.
    return await loader().import(file);
  }
  return (await import(pathToFileURL(file).href)) as unknown;
}

/** The absolute file a source names, or a `PLUGIN_LOAD` error explaining why not. */
export function resolveSourceFile(source: PluginSource, rootDir: string): string {
  if (source.kind === "builtin") {
    const file = builtinPath(source.builtin ?? (source.spec.slice(BUILTIN_SPEC_PREFIX.length) as BuiltinName));
    if (!fs.existsSync(file)) {
      throw new U8Error("PLUGIN_LOAD", `built-in plugin is missing from this u8cli install: ${file}`, {
        spec: source.spec,
      });
    }
    return file;
  }

  if (source.kind === "local") {
    const base = source.resolved ?? resolvePath(source.spec, rootDir);
    const file = existingFile(base);
    if (file === undefined) {
      throw new U8Error(
        "PLUGIN_LOAD",
        `no plugin file at ${base} (tried it directly and with ${LOCAL_EXTENSIONS.join(", ")})`,
        { spec: source.spec },
      );
    }
    return file;
  }

  return resolvePackage(source.spec, rootDir);
}

/**
 * The built-in next to this module — `.ts` when running from source, `.js` from
 * `dist`. Same trick as `daemonEntryPath`, and for the same reason: it works
 * without a build step and without an env var.
 */
export function builtinPath(name: BuiltinName): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), "builtin", `${name}${self.endsWith(".ts") ? ".ts" : ".js"}`);
}

/**
 * Resolves an npm spec against the workspace root.
 *
 * `require.resolve` covers everything with a `main` or a `require` condition;
 * the package.json fallback covers ESM-only packages, which resolve fine for a
 * real `import` but not for the CJS resolver we have to borrow to aim at a
 * directory of our choosing.
 */
function resolvePackage(spec: string, rootDir: string): string {
  // The path never has to exist: `createRequire` only uses it to know which
  // node_modules chain to walk.
  const require = createRequire(path.join(rootDir, "__u8_plugin_host__.cjs"));
  try {
    return require.resolve(spec);
  } catch (err) {
    const entry = entryFromPackageJson(spec, rootDir, require);
    if (entry !== undefined) return entry;
    throw new U8Error(
      "PLUGIN_LOAD",
      `cannot resolve plugin package "${spec}" from ${rootDir}: ${errorMessage(err)} — ` +
        `plugins are resolved from the workspace's own node_modules, so install it there`,
      { spec, rootDir },
    );
  }
}

function entryFromPackageJson(
  spec: string,
  rootDir: string,
  require: ReturnType<typeof createRequire>,
): string | undefined {
  let manifest: string | undefined;
  try {
    manifest = require.resolve(`${spec}/package.json`);
  } catch {
    const guess = path.join(rootDir, "node_modules", spec, "package.json");
    manifest = fs.existsSync(guess) ? guess : undefined;
  }
  if (manifest === undefined) return undefined;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const rel = importEntry(pkg["exports"]) ?? asString(pkg["module"]) ?? asString(pkg["main"]) ?? "index.js";
  return existingFile(path.resolve(path.dirname(manifest), rel));
}

/** The root export of an `exports` map, as far as a plugin entry point needs. */
function importEntry(exports: unknown): string | undefined {
  if (typeof exports === "string") return exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const root = (exports as Record<string, unknown>)["."] ?? exports;
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  const conditions = root as Record<string, unknown>;
  return asString(conditions["import"]) ?? asString(conditions["default"]);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The path itself if it is a file, else the first extension that lands. */
function existingFile(base: string): string | undefined {
  if (isFile(base)) return base;
  for (const ext of LOCAL_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let jiti: Jiti | undefined;

/** One instance for the process: it carries the transform cache. */
function loader(): Jiti {
  jiti ??= createJiti(import.meta.url);
  return jiti;
}
