import { statSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL("../fixtures/scripts/", import.meta.url));

/** Absolute, shell-quoted path to a fixture script. */
export function script(name: string, ...args: string[]): string {
  return [path.join(SCRIPTS_DIR, name), ...args].map((a) => `'${a}'`).join(" ");
}

/** Git file modes are not trustworthy across checkouts; set the bit ourselves. */
export async function makeScriptsExecutable(): Promise<void> {
  for (const name of await readdir(SCRIPTS_DIR)) {
    await chmod(path.join(SCRIPTS_DIR, name), 0o755);
  }
}

/** True once a file exists and is non-empty — a fixture script has reported in. */
export function fileHasContent(p: string): boolean {
  return (statSync(p, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls until the pid disappears; returns false if it outlived `timeoutMs`. */
export async function waitForPidGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(20);
  }
  return !pidAlive(pid);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race partner for assertions that a promise must not deadlock. */
export function timeout(ms: number): Promise<"timed out"> {
  return delay(ms).then(() => "timed out" as const);
}

/** Resolves once `predicate` holds, or rejects with `label` after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

export async function tempDir(prefix = "u8-process-"): Promise<TempDir> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
