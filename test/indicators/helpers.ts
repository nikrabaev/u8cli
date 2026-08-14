import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkspace, type RawWorkspaceConfig } from "../../src/config/index.js";
import type { NormalizedWorkspace, TargetId } from "../../src/config/types.js";
import type { WorkspaceHolder } from "../../src/daemon/contracts.js";
import type { ServiceStateAccess } from "../../src/indicators/index.js";
import type { IndicatorValue, ServiceState } from "../../src/ipc/protocol.js";
import type { Logger } from "../../src/util/logger.js";

const roots: string[] = [];

/** Real (symlink-resolved) throwaway directory tree; macOS symlinks its tmpdir. */
export function tempRoot(subdirs: readonly string[] = []): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u8-indicators-")));
  roots.push(root);
  for (const dir of subdirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

export function cleanupRoots(): void {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Normalizes without touching the disk: `u8.jsonc` never has to exist. */
export function makeWorkspace(root: string, raw: RawWorkspaceConfig): NormalizedWorkspace {
  return normalizeWorkspace(raw, path.join(root, "u8.jsonc"));
}

/** The two-app fixture: one implicit subapp plus a two-subapp monorepo. */
export const FIXTURE_DIRS = ["gateway", "platform/apps/shell", "platform/apps/auth"];

export function fixtureConfig(extra: Partial<RawWorkspaceConfig> = {}): RawWorkspaceConfig {
  return {
    name: "fixture",
    apps: {
      gateway: { path: "gateway", scripts: { start: "node server.js" } },
      platform: {
        path: "platform",
        subapps: { shell: { path: "apps/shell" }, auth: { path: "apps/auth" } },
      },
    },
    ...extra,
  };
}

export interface MutableHolder extends WorkspaceHolder {
  set(ws: NormalizedWorkspace): void;
}

export function holderOf(ws: NormalizedWorkspace): MutableHolder {
  let current = ws;
  return {
    current: () => current,
    set: (next) => {
      current = next;
    },
  };
}

export interface FakeServices extends ServiceStateAccess {
  /** Patches (and creates) one target's state, the way a supervisor would. */
  set(id: TargetId, patch: Partial<ServiceState>): ServiceState;
}

export function fakeServices(): FakeServices {
  const known = new Map<TargetId, ServiceState>();
  const blank = (id: TargetId): ServiceState => ({
    targetId: id,
    status: "stopped",
    stale: false,
    restartAttempts: 0,
  });
  return {
    state: (id) => known.get(id) ?? blank(id),
    states: () => [...known.values()],
    set(id, patch) {
      const next: ServiceState = { ...(known.get(id) ?? blank(id)), ...patch };
      known.set(id, next);
      return next;
    },
  };
}

export interface RecordingLogger extends Logger {
  readonly warnings: string[];
  readonly errors: string[];
  /** Also kept, so a test can prove something was logged *quietly*. */
  readonly debugs: string[];
}

/** Keeps warn/error lines so a test can prove a failure was reported, not swallowed. */
export function recordingLogger(scope = "test"): RecordingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  const make = (at: string): RecordingLogger => ({
    warnings,
    errors,
    debugs,
    debug: (msg) => {
      debugs.push(`${at} ${msg}`);
    },
    info: () => {},
    warn: (msg) => {
      warnings.push(`${at} ${msg}`);
    },
    error: (msg) => {
      errors.push(`${at} ${msg}`);
    },
    child: (sub) => make(`${at}:${sub}`),
  });
  return make(scope);
}

export interface ChangeRecorder {
  /** Pass to `registry.onChange`. */
  readonly listener: (values: IndicatorValue[]) => void;
  readonly batches: IndicatorValue[][];
  flat(): IndicatorValue[];
  cells(): string[];
  clear(): void;
}

export function changeRecorder(): ChangeRecorder {
  const batches: IndicatorValue[][] = [];
  return {
    listener: (values) => {
      batches.push(values);
    },
    batches,
    flat: () => batches.flat(),
    cells: () => batches.flat().map((v) => `${v.ns}@${v.name}/${v.owner}=${v.value}`),
    clear: () => {
      batches.length = 0;
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `predicate` holds, or rejects with `label` after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface TimerTracker {
  /** Timers created by the registry that have neither fired nor been cleared. */
  live(): number;
  restore(): void;
}

/**
 * Counts pending timers created *inside the registry module*, identified by the
 * call stack — vitest schedules timers of its own throughout a test, and they
 * must not be mistaken for a leak.
 */
export function trackRegistryTimers(marker = "indicators/registry"): TimerTracker {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set<NodeJS.Timeout>();
  const mine = (): boolean => (new Error().stack ?? "").includes(marker);

  type Args = [handler: (...a: never[]) => void, ms?: number, ...rest: never[]];

  globalThis.setTimeout = ((...args: Args): NodeJS.Timeout => {
    const [handler, ms, ...rest] = args;
    if (!mine()) return realSetTimeout(handler, ms, ...rest);
    const box: { handle?: NodeJS.Timeout } = {};
    // A one-shot timer that has fired holds nothing open any more.
    box.handle = realSetTimeout(
      (...inner: never[]) => {
        if (box.handle) live.delete(box.handle);
        handler(...inner);
      },
      ms,
      ...rest,
    );
    live.add(box.handle);
    return box.handle;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.setInterval = ((...args: Args): NodeJS.Timeout => {
    const [handler, ms, ...rest] = args;
    const handle = realSetInterval(handler, ms, ...rest);
    if (mine()) live.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval;

  globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => {
    if (handle) live.delete(handle);
    realClearTimeout(handle);
  }) as unknown as typeof globalThis.clearTimeout;

  globalThis.clearInterval = ((handle?: NodeJS.Timeout) => {
    if (handle) live.delete(handle);
    realClearInterval(handle);
  }) as unknown as typeof globalThis.clearInterval;

  return {
    live: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.clearInterval = realClearInterval;
    },
  };
}
