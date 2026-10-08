import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawWorkspaceConfig } from "../../src/config/index.js";
import type { IndicatorRegistry } from "../../src/daemon/contracts.js";
import { createIndicatorRegistry, probeTimeoutMs } from "../../src/indicators/index.js";
import {
  FIXTURE_DIRS,
  cleanupRoots,
  delay,
  fakeServices,
  fixtureConfig,
  holderOf,
  makeWorkspace,
  recordingLogger,
  tempRoot,
  waitFor,
  type FakeServices,
  type MutableHolder,
  type RecordingLogger,
} from "./helpers.js";

/** A config-declared indicator has no namespace — `{version}` — so its cells carry an empty one. */
const NS = "";

const DIR_OF: Record<string, string> = {
  gateway: "gateway",
  "platform.shell": "platform/apps/shell",
  "platform.auth": "platform/apps/auth",
};

let root: string;
let holder: MutableHolder;
let services: FakeServices;
let logger: RecordingLogger;
let registry: IndicatorRegistry;

function build(raw: RawWorkspaceConfig): IndicatorRegistry {
  holder = holderOf(makeWorkspace(root, raw));
  registry = createIndicatorRegistry({ workspace: holder, logger, services });
  return registry;
}

function write(rel: string, contents: string): void {
  fs.writeFileSync(path.join(root, rel), contents, "utf8");
}

beforeEach(() => {
  root = tempRoot(FIXTURE_DIRS);
  services = fakeServices();
  logger = recordingLogger();
});

afterEach(async () => {
  await registry.stop();
  cleanupRoots();
});

describe("config-declared indicators", () => {
  it("runs its command in each owner's cwd and caches trimmed stdout", async () => {
    for (const [id, dir] of Object.entries(DIR_OF)) write(`${dir}/version.txt`, `${id}-1.0\n`);
    build(fixtureConfig({ indicators: { version: { cmd: "cat version.txt", interval: 200 } } }));

    await registry.start();
    await waitFor(
      () => Object.keys(DIR_OF).every((id) => (registry.get(NS, "version", id)?.value ?? "") !== ""),
      "every target to report a version",
    );

    for (const id of Object.keys(DIR_OF)) {
      expect(registry.get(NS, "version", id)?.value).toBe(`${id}-1.0`);
    }
  });

  it("passes the target's merged env", async () => {
    build(
      fixtureConfig({
        env: { U8_TEST_TAG: "workspace" },
        repos: {
          gateway: { path: "gateway", env: { U8_TEST_TAG: "repo" } },
          platform: {
            path: "platform",
            apps: { shell: { path: "apps/shell", env: { U8_TEST_TAG: "app" } } },
          },
        },
        indicators: { tag: { cmd: 'printf "%s" "$U8_TEST_TAG"', interval: 200 } },
      }),
    );

    await registry.start();
    await waitFor(() => registry.get(NS, "tag", "platform.shell")?.value === "app", "the app env");
    // The app override wins over the repo's, which in turn wins over the workspace's.
    expect(registry.get(NS, "tag", "gateway")?.value).toBe("repo");
  });

  it("re-polls and picks up a changed value", async () => {
    write("gateway/version.txt", "1.0.0\n");
    build(fixtureConfig({ indicators: { version: { cmd: "cat version.txt", interval: 150 } } }));

    await registry.start();
    await waitFor(() => registry.get(NS, "version", "gateway")?.value === "1.0.0", "the first poll");

    write("gateway/version.txt", "2.0.0\n");
    await waitFor(() => registry.get(NS, "version", "gateway")?.value === "2.0.0", "the next poll");
  });

  it("sanitizes multi-line command output", async () => {
    build(fixtureConfig({ indicators: { lines: { cmd: 'printf "a\\nb\\tc\\n"', interval: 200 } } }));

    await registry.start();
    await waitFor(() => (registry.get(NS, "lines", "gateway")?.value ?? "") !== "", "the probe");
    expect(registry.get(NS, "lines", "gateway")?.value).toBe("a b c");
  });

  it("goes empty and warns when the command fails", async () => {
    write("gateway/version.txt", "1.0.0\n");
    build(
      fixtureConfig({
        indicators: {
          version: { cmd: "cat version.txt", interval: 150 },
          broken: { cmd: "echo nope >&2; exit 3", interval: 150 },
        },
      }),
    );

    await registry.start();
    await waitFor(() => registry.get(NS, "version", "gateway")?.value === "1.0.0", "the healthy probe");

    // A failing neighbour is a blank cell, not an outage.
    expect(registry.get(NS, "broken", "gateway")?.value).toBe("");
    expect(logger.warnings.some((w) => w.includes('indicator "broken" failed for gateway'))).toBe(true);
  });

  it("survives a probe whose cwd does not exist", async () => {
    // The shell cannot even be spawned here: `exec` rejects instead of resolving
    // with a non-zero exit, which is a different containment path.
    fs.rmSync(path.join(root, "gateway"), { recursive: true, force: true });
    build(fixtureConfig({ indicators: { v: { cmd: "echo hi", interval: 200 } } }));

    await registry.start();
    await waitFor(() => registry.get(NS, "v", "platform.shell")?.value === "hi", "the healthy owner");

    expect(registry.get(NS, "v", "gateway")?.value).toBe("");
    expect(logger.warnings.some((w) => w.includes("indicators:v ") && w.includes("gateway"))).toBe(true);
    expect(logger.errors).toEqual([]);
  });

  it("kills a probe that outruns its interval and leaves the cell empty", async () => {
    build(fixtureConfig({ indicators: { hang: { cmd: "sleep 5", interval: 250 } } }));

    await registry.start();
    await waitFor(
      () => logger.warnings.some((w) => w.includes('indicator "hang" failed')),
      "the probe deadline to fire",
      2_000,
    );
    expect(registry.get(NS, "hang", "gateway")?.value).toBe("");
  });

  it("supports repo scope, running once per repo in the repo directory", async () => {
    write("gateway/marker.txt", "gw\n");
    write("platform/marker.txt", "pf\n");
    build(fixtureConfig({ indicators: { marker: { cmd: "cat marker.txt", interval: 200, scope: "repo" } } }));

    await registry.start();
    await waitFor(() => registry.get(NS, "marker", "platform")?.value === "pf", "the repo-scoped probe");
    expect(registry.get(NS, "marker", "gateway")?.value).toBe("gw");
    expect(registry.values().filter((v) => v.ns === NS)).toHaveLength(2);
  });

  it("follows the config across a rebind", async () => {
    write("gateway/version.txt", "1.0.0\n");
    build(fixtureConfig({ indicators: { version: { cmd: "cat version.txt", interval: 150 } } }));

    await registry.start();
    await waitFor(() => registry.get(NS, "version", "gateway")?.value === "1.0.0", "the first probe");

    holder.set(
      makeWorkspace(root, fixtureConfig({ indicators: { greeting: { cmd: 'printf hi', interval: 150 } } })),
    );
    await registry.rebind();

    await waitFor(() => registry.get(NS, "greeting", "gateway")?.value === "hi", "the new probe");
    expect(registry.get(NS, "version", "gateway")).toBeUndefined();
    expect(registry.values().some((v) => v.ns === NS && v.name === "version")).toBe(false);
  });

  it("keeps a probe deadline inside its own interval", () => {
    expect(probeTimeoutMs(250)).toBe(200);
    expect(probeTimeoutMs(5_000)).toBe(4_000);
    // Clamped: never longer than 5 s, never shorter than 100 ms.
    expect(probeTimeoutMs(600_000)).toBe(5_000);
    expect(probeTimeoutMs(50)).toBe(100);
  });
});

describe("stop", () => {
  it("stops probing once stopped", async () => {
    write("gateway/counter.txt", "0");
    build(
      fixtureConfig({
        indicators: { hits: { cmd: 'wc -l < hits.log | tr -d " "', interval: 60 } },
      }),
    );
    fs.writeFileSync(path.join(root, "gateway/hits.log"), "", "utf8");

    await registry.start();
    await waitFor(() => registry.get(NS, "hits", "gateway")?.value === "0", "the first probe");

    await registry.stop();
    fs.writeFileSync(path.join(root, "gateway/hits.log"), "a\nb\n", "utf8");
    await delay(200);

    expect(registry.get(NS, "hits", "gateway")?.value).toBe("0");
  });

  it("kills a probe that is still running when the registry stops", async () => {
    // The daemon exits moments after `stop()`, taking every escalation timer with
    // it — an unsignalled child would be orphaned for as long as it feels like.
    build(fixtureConfig({ indicators: { slow: { cmd: "echo $$ > probe.pid; sleep 30", interval: 5_000 } } }));
    const pidFile = path.join(root, "gateway/probe.pid");

    await registry.start();
    await waitFor(() => readPid(pidFile) > 0, "the probe to report its pid");
    const pid = readPid(pidFile);
    expect(alive(pid)).toBe(true);

    await registry.stop();
    await waitFor(() => !alive(pid), "the probe to be reaped");

    // A probe u8 itself cut short is not a probe failure: reporting one on every
    // shutdown and every config reload would train the reader to ignore them.
    await waitFor(
      () => logger.debugs.some((d) => d.includes('indicator "slow" interrupted for gateway')),
      "the interruption to be logged quietly",
    );
    expect(logger.warnings.filter((w) => w.includes("slow"))).toEqual([]);
  });
});

function readPid(file: string): number {
  try {
    return Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
