import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { oneLine } from "../../../src/cli/format.js";
import { DEFAULT_PROTOS_INTERVAL_MS, type ProtosOptions } from "../../../src/config/types.js";
import type {
  IndicatorContext,
  IndicatorResult,
  PluginCommandDef,
  PluginDefinition,
  TargetInfo,
} from "../../../src/plugin/types.js";
import protosFactory, {
  createProtosPlugin,
  LINKED_INDICATOR,
  YALC,
} from "../../../src/plugins/builtin/protos.js";
import { templateTokens } from "../../../src/template/index.js";
import { nullLogger } from "../../../src/util/logger.js";
import {
  cleanupHarnesses,
  createHarness,
  resultFor,
  settled,
  statesByTarget,
  type Harness,
} from "../../engine/helpers.js";
import { cleanupRoots, tempRoot } from "../../indicators/helpers.js";

const PROTOS = "@myorg/protos";
const QUERY = "@myorg/react-query";

/** The two packages a workspace in the user's situation would configure. */
function options(overrides: Partial<ProtosOptions> = {}): ProtosOptions {
  return { packages: [PROTOS, QUERY], intervalMs: 250, ...overrides };
}

function plugin(overrides: Partial<ProtosOptions> = {}): PluginDefinition {
  return createProtosPlugin(options(overrides));
}

// ---------------------------------------------------------------------------
// Fixture consumers — real package.json / .yalc / node_modules trees on disk
// ---------------------------------------------------------------------------

interface ConsumerSpec {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  /** `pkg → version`, or `null` for a `.yalc/<pkg>` directory with no manifest. */
  yalc?: Record<string, string | null>;
  /** `pkg → version` inside this consumer's own node_modules. */
  installed?: Record<string, string>;
  /** Written verbatim instead of the generated manifest (malformed JSON, etc.). */
  rawManifest?: string;
  /** Skips the consumer manifest entirely — plenty of repos are not node projects. */
  noManifest?: boolean;
}

function makeConsumer(dir: string, spec: ConsumerSpec = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  if (spec.rawManifest !== undefined) {
    fs.writeFileSync(path.join(dir, "package.json"), spec.rawManifest, "utf8");
  } else if (spec.noManifest !== true) {
    write(path.join(dir, "package.json"), {
      name: path.basename(dir),
      version: "0.0.0",
      ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
      ...(spec.devDependencies ? { devDependencies: spec.devDependencies } : {}),
      ...(spec.peerDependencies ? { peerDependencies: spec.peerDependencies } : {}),
    });
  }
  for (const [pkg, version] of Object.entries(spec.yalc ?? {})) {
    const home = path.join(dir, ".yalc", pkg);
    fs.mkdirSync(home, { recursive: true });
    if (version !== null) write(path.join(home, "package.json"), { name: pkg, version });
  }
  for (const [pkg, version] of Object.entries(spec.installed ?? {})) {
    const home = path.join(dir, "node_modules", pkg);
    fs.mkdirSync(home, { recursive: true });
    write(path.join(home, "package.json"), { name: pkg, version });
  }
  return dir;
}

function write(file: string, body: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

/** A yalc link exactly as `yalc add` leaves it: rewritten range plus `.yalc` copy. */
function linkedTo(pkg: string, version: string): ConsumerSpec {
  return { dependencies: { [pkg]: `file:.yalc/${pkg}` }, yalc: { [pkg]: version } };
}

// ---------------------------------------------------------------------------
// Callsites
// ---------------------------------------------------------------------------

let root: string;

/**
 * The context the registry hands an app-scoped provider. `exec` throws on
 * purpose: an indicator polled every few seconds must answer from the
 * filesystem, never by forking yalc.
 */
function indicatorContext(cwd: string): IndicatorContext {
  return {
    workspace: { id: "fixture", name: "fixture", rootDir: root, configPath: path.join(root, "u8.jsonc") },
    logger: nullLogger,
    store: new Map<string, unknown>(),
    exec: () => Promise.reject(new Error("protos indicators must not shell out")),
    scope: "app",
    repo: { name: "api", baseName: "api", instance: "base", path: cwd },
    cwd,
  };
}

async function cell(def: PluginDefinition, name: string, cwd: string): Promise<IndicatorResult> {
  const indicator = def.indicators?.[name];
  if (!indicator?.value) throw new Error(`the protos plugin does not poll {protos@${name}}`);
  return await indicator.value(indicatorContext(cwd));
}

function valueOf(result: IndicatorResult): string {
  if (result === null || result === undefined) return "";
  return typeof result === "object" ? result.value : result;
}

function toneOf(result: IndicatorResult): string | undefined {
  if (result === null || result === undefined || typeof result !== "object") return undefined;
  return result.tone;
}

function command(def: PluginDefinition, name: string): PluginCommandDef {
  const found = def.commands?.[name];
  if (!found) throw new Error(`the protos plugin does not define protos:${name}`);
  return found;
}

function targetAt(cwd: string, id = "api"): TargetInfo {
  return {
    id,
    baseId: id,
    instance: "base",
    repoName: id,
    name: id,
    implicit: true,
    cwd,
    scripts: {},
    env: {},
    ports: {},
    dependsOn: [],
    hasHealth: false,
  };
}

function applies(def: PluginDefinition, name: string, cwd: string): boolean {
  return command(def, name).appliesTo?.(targetAt(cwd)) ?? true;
}

// ---------------------------------------------------------------------------
// A stub yalc on PATH — the real binary is never assumed to exist
// ---------------------------------------------------------------------------

interface YalcStub {
  /** One `\t`-separated `cwd  args` line per invocation. */
  calls(): string[];
  args(): string[];
}

interface StubSpec {
  /** Written to stdout before exiting. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function installYalcStub(dir: string, spec: StubSpec = {}): YalcStub {
  const bin = path.join(dir, "stub-bin");
  const log = path.join(dir, "yalc-calls.log");
  fs.mkdirSync(bin, { recursive: true });
  const lines = [
    "#!/bin/sh",
    `printf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}`,
    ...(spec.stdout === undefined ? [] : [`printf '%s\\n' ${JSON.stringify(spec.stdout)}`]),
    ...(spec.stderr === undefined ? [] : [`printf '%s\\n' ${JSON.stringify(spec.stderr)} >&2`]),
    `exit ${spec.exitCode ?? 0}`,
  ];
  fs.writeFileSync(path.join(bin, YALC), `${lines.join("\n")}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const read = (): string[] =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    calls: read,
    args: () => read().map((line) => line.split("\t")[1] ?? ""),
  };
}

/** A PATH with no yalc on it at all — the machine of someone who never installed it. */
function removeYalcFromPath(dir: string): void {
  const empty = path.join(dir, "empty-bin");
  fs.mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
}

/**
 * `$SHELL` is pinned: `exec` runs through the user's interactive shell, and a
 * developer's own `~/.zshenv` rewriting `$PATH` would walk straight past the stub.
 */
const ENV_KEYS = ["PATH", "SHELL"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SHELL = "/bin/sh";
  root = tempRoot();
});

afterEach(() => {
  cleanupHarnesses();
  cleanupRoots();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("protos registration", () => {
  it("contributes nothing at all until a workspace names its packages", () => {
    const bare = createProtosPlugin({ packages: [], intervalMs: DEFAULT_PROTOS_INTERVAL_MS });

    expect(bare.name).toBe("protos");
    expect(Object.keys(bare.indicators ?? {})).toEqual([]);
    expect(Object.keys(bare.commands ?? {})).toEqual([]);
    expect(bare.hooks).toBeUndefined();
    expect(bare.readiness).toBeUndefined();
  });

  it("is exported as a factory under both names, so either loader path works", () => {
    expect(protosFactory).toBe(createProtosPlugin);
    expect(protosFactory(options()).name).toBe("protos");
  });

  it("names a command and an indicator after each package's last segment", () => {
    const def = plugin();

    expect(Object.keys(def.indicators ?? {}).sort()).toEqual([LINKED_INDICATOR, "protos", "react-query"]);
    expect(Object.keys(def.commands ?? {}).sort()).toEqual([
      "link",
      "link:protos",
      "link:react-query",
      "unlink",
      "unlink:protos",
      "unlink:react-query",
    ]);
  });

  it("falls back to the flattened full name when two packages share a last segment", () => {
    const def = plugin({ packages: ["@myorg/protos", "@other/protos"] });

    expect(Object.keys(def.indicators ?? {}).sort()).toEqual([
      LINKED_INDICATOR,
      "myorg-protos",
      "other-protos",
    ]);
    expect(Object.keys(def.commands ?? {})).toContain("link:myorg-protos");
    expect(Object.keys(def.commands ?? {})).toContain("unlink:other-protos");
  });

  it("gives a package named with a dot or a leading digit a cell a template can write", () => {
    // npm allows both (`chart.js`, `socket.io`), and the alias is the name a
    // human knows the package by — so it is the grammar that has to keep up.
    const def = plugin({ packages: ["chart.js", "@acme/socket.io", "3d-kit"] });

    const cells = Object.keys(def.indicators ?? {}).filter((name) => name !== LINKED_INDICATOR);
    expect(cells.sort()).toEqual(["3d-kit", "chart.js", "socket.io"]);
    for (const name of cells) {
      expect(templateTokens(`{protos@${name}}`)).toEqual([{ ns: "protos", name }]);
    }
  });

  it("keeps the rollup cell for itself when a package would shadow it", () => {
    const def = plugin({ packages: ["@myorg/linked"] });

    expect(Object.keys(def.indicators ?? {}).sort()).toEqual([LINKED_INDICATOR, "myorg-linked"]);
    // The rollup, not the package: it counts, so it must not report a version.
    expect(def.indicators?.[LINKED_INDICATOR]?.description).toContain("How many");
  });

  it("ignores blanks and duplicates in the configured list", () => {
    const def = plugin({ packages: [PROTOS, "  ", PROTOS, QUERY] });

    expect(Object.keys(def.indicators ?? {})).toHaveLength(3);
  });

  it("polls at the configured interval, falling back when it is not a usable number", () => {
    expect(plugin({ intervalMs: 1_234 }).indicators?.protos?.update).toEqual({
      mode: "poll",
      intervalMs: 1_234,
    });
    const broken = plugin({ intervalMs: Number.NaN }).indicators?.protos?.update;
    expect(broken).toEqual({ mode: "poll", intervalMs: DEFAULT_PROTOS_INTERVAL_MS });
  });

  it("scopes everything to the app, because .yalc and node_modules are per app", () => {
    const def = plugin();

    for (const indicator of Object.values(def.indicators ?? {})) expect(indicator.scope).toBe("app");
    for (const cmd of Object.values(def.commands ?? {})) {
      expect(cmd.kind).toBe("task");
      expect(cmd.groupBy).toBe("target");
    }
  });
});

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

describe("protos indicators", () => {
  it("reports a yalc link as the local build's own version", async () => {
    const dir = makeConsumer(path.join(root, "api"), linkedTo(PROTOS, "1.4.2"));

    const result = await cell(plugin(), "protos", dir);

    expect(valueOf(result)).toBe("1.4.2 local");
    expect(toneOf(result)).toBe("warn");
  });

  it("reports the installed version when nothing is linked", async () => {
    const dir = makeConsumer(path.join(root, "api"), {
      dependencies: { [PROTOS]: "^1.0.0" },
      installed: { [PROTOS]: "1.3.0" },
    });

    const result = await cell(plugin(), "protos", dir);

    expect(valueOf(result)).toBe("1.3.0");
    expect(toneOf(result)).toBe("ok");
  });

  it("falls back to the declared range when nothing is installed", async () => {
    const dir = makeConsumer(path.join(root, "api"), { dependencies: { [PROTOS]: "^1.0.0" } });

    const result = await cell(plugin(), "protos", dir);

    expect(valueOf(result)).toBe("^1.0.0");
    expect(toneOf(result)).toBe("muted");
  });

  it("counts a devDependency and a peerDependency as consumption", async () => {
    const dir = makeConsumer(path.join(root, "api"), {
      devDependencies: { [PROTOS]: "1.2.3" },
      peerDependencies: { [QUERY]: "^2.0.0" },
    });
    const def = plugin();

    expect(valueOf(await cell(def, "protos", dir))).toBe("1.2.3");
    expect(valueOf(await cell(def, "react-query", dir))).toBe("^2.0.0");
  });

  it("renders an empty cell for an app that does not consume the package", async () => {
    const dir = makeConsumer(path.join(root, "api"), { dependencies: { [PROTOS]: "^1.0.0" } });

    const result = await cell(plugin(), "react-query", dir);

    // Empty rather than "n/a": most rows are not consumers, and a column of
    // placeholders is noise on every one of them.
    expect(valueOf(result)).toBe("");
    expect(toneOf(result)).toBeUndefined();
  });

  it("stays blank and silent in a directory that is not a node project", async () => {
    const dir = makeConsumer(path.join(root, "api"), { noManifest: true });
    const def = plugin();

    expect(valueOf(await cell(def, "protos", dir))).toBe("");
    expect(valueOf(await cell(def, LINKED_INDICATOR, dir))).toBe("");
  });

  it("survives a package.json caught half-written, and recovers on the next poll", async () => {
    const dir = makeConsumer(path.join(root, "api"), { rawManifest: `{ "dependencies": { "@myorg/pro` });
    const def = plugin();

    expect(valueOf(await cell(def, "protos", dir))).toBe("");

    write(path.join(dir, "package.json"), { name: "api", dependencies: { [PROTOS]: "^1.0.0" } });

    expect(valueOf(await cell(def, "protos", dir))).toBe("^1.0.0");
  });

  it("re-reads a manifest only when its stamp moves", async () => {
    const dir = makeConsumer(path.join(root, "api"), { noManifest: true });
    const manifest = path.join(dir, "package.json");
    const body = (range: string): string => JSON.stringify({ dependencies: { [PROTOS]: range } });
    const pinned = new Date(1_700_000_000_000);
    const def = plugin();

    fs.writeFileSync(manifest, body("^1.0.0"), "utf8");
    fs.utimesSync(manifest, pinned, pinned);
    expect(valueOf(await cell(def, "protos", dir))).toBe("^1.0.0");

    // Same byte count, same mtime: a change no stat can see, and therefore one
    // the cache is entitled to miss. Not tolerating that miss is what would make
    // every poll re-parse three manifests per package per app.
    fs.writeFileSync(manifest, body("^8.8.8"), "utf8");
    fs.utimesSync(manifest, pinned, pinned);
    expect(valueOf(await cell(def, "protos", dir))).toBe("^1.0.0");

    // A real write moves the mtime, and the cell follows it.
    const later = new Date(1_700_000_060_000);
    fs.utimesSync(manifest, later, later);
    expect(valueOf(await cell(def, "protos", dir))).toBe("^8.8.8");
  });

  it("does not trust a rewritten range whose .yalc copy is gone", async () => {
    const dir = makeConsumer(path.join(root, "api"), {
      dependencies: { [PROTOS]: `file:.yalc/${PROTOS}` },
      installed: { [PROTOS]: "1.3.0" },
    });

    const result = await cell(plugin(), "protos", dir);

    expect(valueOf(result)).toBe("1.3.0");
    expect(toneOf(result)).toBe("ok");
  });

  it("does not trust a leftover .yalc directory the manifest no longer points at", async () => {
    const dir = makeConsumer(path.join(root, "api"), {
      dependencies: { [PROTOS]: "^1.0.0" },
      yalc: { [PROTOS]: "1.4.2" },
      installed: { [PROTOS]: "1.3.0" },
    });

    expect(valueOf(await cell(plugin(), "protos", dir))).toBe("1.3.0");
  });

  it("still says local when the linked copy has no readable version", async () => {
    const dir = makeConsumer(path.join(root, "api"), {
      dependencies: { [PROTOS]: `file:.yalc/${PROTOS}` },
      yalc: { [PROTOS]: null },
    });

    const result = await cell(plugin(), "protos", dir);

    expect(valueOf(result)).toBe("local");
    expect(toneOf(result)).toBe("warn");
  });

  it("works with a .yalc but no node_modules, which is every fresh link", async () => {
    const dir = makeConsumer(path.join(root, "api"), linkedTo(QUERY, "2.0.1"));
    const def = plugin();

    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
    expect(valueOf(await cell(def, "react-query", dir))).toBe("2.0.1 local");
    expect(valueOf(await cell(def, "protos", dir))).toBe("");
  });

  it("rolls up how many packages are linked, and stays blank when none are", async () => {
    const clean = makeConsumer(path.join(root, "clean"), {
      dependencies: { [PROTOS]: "^1.0.0", [QUERY]: "^2.0.0" },
      installed: { [PROTOS]: "1.3.0" },
    });
    const both = makeConsumer(path.join(root, "both"), {
      dependencies: { [PROTOS]: `file:.yalc/${PROTOS}`, [QUERY]: `file:.yalc/${QUERY}` },
      yalc: { [PROTOS]: "1.4.2", [QUERY]: "2.0.1" },
    });
    const def = plugin();

    expect(valueOf(await cell(def, LINKED_INDICATOR, clean))).toBe("");
    const rollup = await cell(def, LINKED_INDICATOR, both);
    expect(valueOf(rollup)).toBe("2 local");
    expect(toneOf(rollup)).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// appliesTo
// ---------------------------------------------------------------------------

describe("protos command targeting", () => {
  it("links only where a package is actually consumed", () => {
    const def = plugin();
    const consumer = makeConsumer(path.join(root, "api"), { dependencies: { [PROTOS]: "^1.0.0" } });
    const stranger = makeConsumer(path.join(root, "docs"), { dependencies: { lodash: "^4.0.0" } });

    expect(applies(def, "link", consumer)).toBe(true);
    expect(applies(def, "link:protos", consumer)).toBe(true);
    // The other configured package is not this app's business.
    expect(applies(def, "link:react-query", consumer)).toBe(false);
    expect(applies(def, "link", stranger)).toBe(false);
  });

  it("unlinks only where something is currently linked", () => {
    const def = plugin();
    const linked = makeConsumer(path.join(root, "api"), linkedTo(PROTOS, "1.4.2"));
    const installed = makeConsumer(path.join(root, "web"), {
      dependencies: { [PROTOS]: "^1.0.0" },
      installed: { [PROTOS]: "1.3.0" },
    });

    expect(applies(def, "unlink", linked)).toBe(true);
    expect(applies(def, "unlink:protos", linked)).toBe(true);
    expect(applies(def, "unlink:react-query", linked)).toBe(false);
    // Consumed, but nothing to undo — the difference between skipped and failed.
    expect(applies(def, "unlink", installed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commands, driven through the real engine against a stub yalc
// ---------------------------------------------------------------------------

/** `api` consumes both packages; `web` consumes one; `docs` consumes neither. */
function harness(): Harness {
  const h = createHarness({
    dirs: ["api", "web", "docs"],
    config: {
      repos: {
        api: { path: "api" },
        web: { path: "web" },
        docs: { path: "docs" },
      },
    },
  });
  const def = plugin();
  for (const name of Object.keys(def.commands ?? {})) {
    h.plugins.addCommand("protos", `protos:${name}`, command(def, name));
  }
  return h;
}

function logsFor(h: Harness, targetId: string): string[] {
  return h.logs.filter((line) => line.targetId === targetId).map((line) => line.text);
}

describe("protos:link", () => {
  it("runs yalc add in the app, once per package it consumes", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0", [QUERY]: "^2.0.0" } });
    const yalc = installYalcStub(h.dir, { stdout: "Package @myorg/protos@1.4.2 added ==> ." });

    const result = await settled(h.engine.runCommand({ command: "protos:link", targets: ["api"] }));

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ api: "ok" });
    expect(yalc.args()).toEqual([`add ${PROTOS}`, `add ${QUERY}`]);
    // Each app has its own node_modules and its own .yalc, so the link has to
    // happen there rather than in the repo root.
    expect(yalc.calls().every((line) => line.startsWith(`${h.file("api")}\t`))).toBe(true);

    const log = logsFor(h, "api");
    expect(log).toContain(`$ yalc add ${PROTOS}`);
    // yalc's own words reach the run log, not just our summary.
    expect(log).toContain("Package @myorg/protos@1.4.2 added ==> .");
  });

  it("links a single package when the per-package command is used", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0", [QUERY]: "^2.0.0" } });
    const yalc = installYalcStub(h.dir);

    const result = await settled(
      h.engine.runCommand({ command: "protos:link:react-query", targets: ["api"] }),
    );

    expect(result.ok).toBe(true);
    expect(yalc.args()).toEqual([`add ${QUERY}`]);
  });

  it("skips an app that does not consume the package, and never forks yalc for it", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0" } });
    makeConsumer(h.file("docs"), { dependencies: { lodash: "^4.0.0" } });
    const yalc = installYalcStub(h.dir);

    const result = await settled(
      h.engine.runCommand({ command: "protos:link", targets: ["api", "docs"] }),
    );

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ api: "ok", docs: "skipped" });
    expect(resultFor(result, "docs").error).toContain("does not apply");
    expect(yalc.args()).toEqual([`add ${PROTOS}`]);
  });

  it("says how to install yalc when the machine has none, instead of leaking ENOENT", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0", [QUERY]: "^2.0.0" } });
    removeYalcFromPath(h.dir);

    const result = await settled(h.engine.runCommand({ command: "protos:link", targets: ["api"] }));

    expect(result.ok).toBe(false);
    const target = resultFor(result, "api");
    expect(target.state).toBe("failed");
    expect(target.error).toContain("yalc is not on PATH");
    expect(target.error).toContain("npm i -g yalc");
    expect(target.error).not.toMatch(/ENOENT|exit 127/);
    // One missing binary is every package's failure: the second is not attempted.
    expect(logsFor(h, "api").filter((line) => line.startsWith("$ yalc"))).toEqual([`$ yalc add ${PROTOS}`]);
  });

  it("teaches the missing publish step when the store has no such package", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0" } });
    installYalcStub(h.dir, {
      stderr: "Could not find package @myorg/protos in store.",
      exitCode: 1,
    });

    const result = await settled(h.engine.runCommand({ command: "protos:link:protos", targets: ["api"] }));

    expect(result.ok).toBe(false);
    const target = resultFor(result, "api");
    expect(target.state).toBe("failed");
    // yalc's own diagnosis, cryptic as it is...
    expect(target.error).toContain("Could not find package @myorg/protos in store.");
    // ...plus the step this link-only design leaves to the user.
    expect(target.error).toContain("yalc publish");
    expect(logsFor(h, "api")).toContain("Could not find package @myorg/protos in store.");
  });

  /**
   * `u8 run` renders a failed target's error as one `oneLine()` table cell, so
   * anything past that budget is seen only by someone who opens the run log.
   * Both failures here are ones the user has to act on, and the real `oneLine`
   * is used rather than a copy of its width so this cannot drift from the CLI.
   */
  describe("what survives the terminal's one-line budget", () => {
    it("keeps the install step and the daemon restart in the missing-yalc cell", async () => {
      const h = harness();
      makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0" } });
      removeYalcFromPath(h.dir);

      const result = await settled(h.engine.runCommand({ command: "protos:link", targets: ["api"] }));

      const cell = oneLine(resultFor(result, "api").error ?? "");
      expect(cell).toContain("not on PATH");
      // Installing is only half of it: the daemon that ran this inherited its
      // PATH when it was spawned, so "install it and run this again" on its own
      // returns the user to this exact error with `which yalc` working.
      expect(cell).toContain(`npm i -g ${YALC}`);
      expect(cell).toContain("u8 daemon stop");
    });

    it("keeps the publish step in the store-miss cell, ahead of yalc's own words", async () => {
      const h = harness();
      makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0" } });
      installYalcStub(h.dir, { stderr: "Could not find package @myorg/protos in store.", exitCode: 1 });

      const result = await settled(h.engine.runCommand({ command: "protos:link:protos", targets: ["api"] }));

      const error = resultFor(result, "api").error ?? "";
      // The advice must come first: yalc's diagnosis is the half the user can
      // already read in the run log, and it is far too long to leave room.
      expect(oneLine(error)).toContain(`${YALC} publish`);
      expect(error.indexOf(`${YALC} publish`)).toBeLessThan(error.indexOf("Could not find package"));
    });
  });

  it("attempts every package and reports both failures together", async () => {
    const h = harness();
    makeConsumer(h.file("api"), { dependencies: { [PROTOS]: "^1.0.0", [QUERY]: "^2.0.0" } });
    const yalc = installYalcStub(h.dir, { stderr: "not in store", exitCode: 1 });

    const result = await settled(h.engine.runCommand({ command: "protos:link", targets: ["api"] }));

    expect(result.ok).toBe(false);
    expect(yalc.args()).toEqual([`add ${PROTOS}`, `add ${QUERY}`]);
    const error = resultFor(result, "api").error ?? "";
    expect(error).toContain(PROTOS);
    expect(error).toContain(QUERY);
  });
});

describe("protos:unlink", () => {
  it("removes the link and says node_modules still holds the linked copy", async () => {
    const h = harness();
    makeConsumer(h.file("api"), {
      ...linkedTo(PROTOS, "1.4.2"),
      installed: { [PROTOS]: "1.4.2" },
    });
    const yalc = installYalcStub(h.dir);

    const result = await settled(h.engine.runCommand({ command: "protos:unlink", targets: ["api"] }));

    expect(result.ok).toBe(true);
    expect(yalc.args()).toEqual([`remove ${PROTOS}`]);

    const log = logsFor(h, "api");
    const note = log.find((line) => line.includes("node_modules"));
    expect(note).toBeDefined();
    expect(note).toContain("still holds the linked copy");
    expect(note).toContain("package manager's install");
    // Never guessed, never run: no installer was invoked behind the user's back.
    expect(yalc.args()).toHaveLength(1);
    expect(log.some((line) => /npm install|pnpm install|yarn install/.test(line))).toBe(false);
  });

  it("says nothing about node_modules when there is no node_modules", async () => {
    const h = harness();
    makeConsumer(h.file("api"), linkedTo(PROTOS, "1.4.2"));
    installYalcStub(h.dir);

    const result = await settled(h.engine.runCommand({ command: "protos:unlink", targets: ["api"] }));

    expect(result.ok).toBe(true);
    expect(logsFor(h, "api").some((line) => line.includes("node_modules"))).toBe(false);
  });

  it("skips a target with nothing linked rather than failing it", async () => {
    const h = harness();
    makeConsumer(h.file("api"), linkedTo(PROTOS, "1.4.2"));
    makeConsumer(h.file("web"), {
      dependencies: { [PROTOS]: "^1.0.0" },
      installed: { [PROTOS]: "1.3.0" },
    });
    const yalc = installYalcStub(h.dir);

    const result = await settled(
      h.engine.runCommand({ command: "protos:unlink", targets: ["api", "web"] }),
    );

    expect(result.ok).toBe(true);
    expect(statesByTarget(result)).toEqual({ api: "ok", web: "skipped" });
    expect(yalc.args()).toEqual([`remove ${PROTOS}`]);
  });

  it("fails with yalc's own words, and adds no publish advice it cannot support", async () => {
    const h = harness();
    makeConsumer(h.file("api"), linkedTo(PROTOS, "1.4.2"));
    installYalcStub(h.dir, { stderr: "Could not remove @myorg/protos", exitCode: 1 });

    const result = await settled(h.engine.runCommand({ command: "protos:unlink", targets: ["api"] }));

    expect(result.ok).toBe(false);
    const error = resultFor(result, "api").error ?? "";
    expect(error).toContain("Could not remove @myorg/protos");
    expect(error).not.toContain("yalc publish");
  });

  it("reports a missing yalc the same way link does", async () => {
    const h = harness();
    makeConsumer(h.file("api"), linkedTo(PROTOS, "1.4.2"));
    removeYalcFromPath(h.dir);

    const result = await settled(h.engine.runCommand({ command: "protos:unlink", targets: ["api"] }));

    expect(result.ok).toBe(false);
    expect(resultFor(result, "api").error).toContain("npm i -g yalc");
  });
});
