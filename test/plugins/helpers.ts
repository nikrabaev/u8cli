/**
 * Harness for the plugin-host tests.
 *
 * Everything is real: fixture plugins are files on disk in a temporary
 * workspace, imported by the same loader the daemon uses (jiti for `.ts`, a
 * dynamic import otherwise), and an npm-style plugin is a real package inside a
 * real `node_modules`. Nothing here mocks the host or the loader.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkspace } from "../../src/config/index.js";
import type { NormalizedWorkspace } from "../../src/config/types.js";
import type { WorkspaceHolder } from "../../src/daemon/contracts.js";
import type { ServiceState } from "../../src/ipc/protocol.js";
import type {
  CommandContext,
  HookContext,
  HookResult,
  IndicatorContext,
  TargetInfo,
} from "../../src/plugin/types.js";
import { createPluginHost, type LoadablePluginHost, type PluginHostDeps } from "../../src/plugins/index.js";
import { nullLogger } from "../../src/util/logger.js";

const dirs: string[] = [];
const hosts: LoadablePluginHost[] = [];

/** Absolute path of `u8cli/plugin` for a fixture that imports the real SDK. */
export const PLUGIN_SDK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/plugin/index.js",
);

export interface FixtureOptions {
  /** Merged over the default one-app workspace. */
  config?: Record<string, unknown>;
  /** Written verbatim, relative to the workspace root. */
  files?: Record<string, string>;
  /** Extra directories to create (app cwds are created for you). */
  dirs?: string[];
}

export interface Fixture {
  dir: string;
  ws: NormalizedWorkspace;
  workspace: WorkspaceHolder;
  /** A tracked host over this workspace; disposed by {@link cleanupPlugins}. */
  host(opts?: Partial<PluginHostDeps>): LoadablePluginHost;
  file(rel: string): string;
  read(rel: string): string;
  exists(rel: string): boolean;
}

/**
 * A workspace with one app and the built-ins off.
 *
 * Built-ins ship inside u8cli and would otherwise appear in every `list()`;
 * tests that care about them turn them back on explicitly.
 */
export function createFixture(opts: FixtureOptions = {}): Fixture {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-plugins-")));
  dirs.push(dir);

  const config = {
    builtins: { git: false, health: false },
    apps: { api: { path: "api", scripts: { start: "sleep 30" } } },
    ...opts.config,
  };
  for (const rel of ["api", ...(opts.dirs ?? [])]) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(path.join(dir, rel), content);
  write(path.join(dir, "u8.jsonc"), JSON.stringify(config, null, 2));
  // Node decides a `.js` file's module kind from the nearest package.json, and a
  // fixture plugin written as ESM has to be read as ESM.
  write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "u8-fixture-workspace", private: true, type: "module" }, null, 2),
  );

  const ws = loadWorkspace(dir);
  const workspace: WorkspaceHolder = { current: () => ws };

  return {
    dir,
    ws,
    workspace,
    host(hostOpts: Partial<PluginHostDeps> = {}) {
      const host = createPluginHost({ workspace, logger: nullLogger, ...hostOpts });
      hosts.push(host);
      return host;
    },
    file: (rel: string) => path.join(dir, rel),
    read: (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8"),
    exists: (rel: string) => fs.existsSync(path.join(dir, rel)),
  };
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/**
 * A fake npm package under the workspace's own `node_modules` — the only place
 * SPEC §2.8 lets a plugin package be resolved from.
 */
export function installPackage(fixture: Fixture, name: string, source: string, pkg: object = {}): void {
  const root = path.join(fixture.dir, "node_modules", name);
  write(path.join(root, "index.js"), source);
  write(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", ...pkg }, null, 2),
  );
}

export async function cleanupPlugins(): Promise<void> {
  for (const host of hosts.splice(0)) await host.dispose().catch(() => undefined);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Callsite contexts
// ---------------------------------------------------------------------------

/**
 * The context the indicator registry would hand a provider — including a store
 * of its own, so a test can prove the host swaps in the plugin's.
 */
export function indicatorContext(fixture: Fixture, overrides: Partial<IndicatorContext> = {}): IndicatorContext {
  const app = fixture.ws.apps[0];
  const subapp = fixture.ws.subapps[0];
  if (!app || !subapp) throw new Error("fixture workspace has no app");
  return {
    workspace: info(fixture.ws),
    logger: nullLogger,
    exec: async () => execStub(),
    store: new Map<string, unknown>(),
    scope: "subapp",
    app: { name: app.name, path: app.path },
    target: targetInfo(fixture),
    cwd: subapp.cwd,
    service: serviceState(subapp.id),
    ...overrides,
  };
}

export function commandContext(fixture: Fixture, overrides: Partial<CommandContext> = {}): CommandContext {
  const app = fixture.ws.apps[0];
  const subapp = fixture.ws.subapps[0];
  if (!app || !subapp) throw new Error("fixture workspace has no app");
  return {
    workspace: info(fixture.ws),
    logger: nullLogger,
    exec: async () => execStub(),
    store: new Map<string, unknown>(),
    command: "demo:run",
    runId: "test-run",
    app: { name: app.name, path: app.path },
    target: targetInfo(fixture),
    cwd: subapp.cwd,
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function hookContext(
  fixture: Fixture,
  phase: "pre" | "post",
  result?: HookResult,
  overrides: Partial<HookContext> = {},
): HookContext {
  const { log: _log, signal: _signal, ...base } = commandContext(fixture);
  return { ...base, phase, result, ...overrides };
}

export function targetInfo(fixture: Fixture): TargetInfo {
  const subapp = fixture.ws.subapps[0];
  if (!subapp) throw new Error("fixture workspace has no subapp");
  return {
    id: subapp.id,
    appName: subapp.appName,
    name: subapp.name,
    implicit: subapp.implicit,
    cwd: subapp.cwd,
    scripts: { ...subapp.scripts },
    env: { ...subapp.env },
    dependsOn: [...subapp.dependsOn],
    hasHealth: subapp.health !== undefined,
  };
}

export function serviceState(targetId: string, status: ServiceState["status"] = "running"): ServiceState {
  return { targetId, status, stale: false, restartAttempts: 0, pid: 1234, startedAt: Date.now() };
}

function info(ws: NormalizedWorkspace) {
  return { id: ws.id, name: ws.name, rootDir: ws.rootDir, configPath: ws.configPath };
}

function execStub() {
  return { ok: true, exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
}
