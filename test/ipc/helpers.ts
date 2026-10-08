import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TEMPLATES } from "../../src/config/types.js";
import { PROTOCOL_VERSION, type Snapshot } from "../../src/ipc/protocol.js";

/** Unix socket paths are capped near 104 bytes, so keep the tmp root as short as possible. */
export async function makeSocketDir(): Promise<{ dir: string; socketPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(shorter(os.tmpdir(), "/tmp"), "u8ipc-"));
  const socketPath = path.join(dir, "d.sock");
  if (socketPath.length > 100) throw new Error(`socket path too long for a unix socket: ${socketPath}`);
  return { dir, socketPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function shorter(a: string, b: string): string {
  return a.length <= b.length ? a : b;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A raw socket peer with its own (deliberately independent) line splitter, for
 * frames the typed client would never produce — malformed, oversized, id-less.
 */
export interface RawPeer {
  /** Every response frame received so far, parsed. */
  readonly frames: unknown[];
  send(text: string): void;
  /** Waits until at least `n` frames have arrived, then returns them. */
  expect(n: number, timeoutMs?: number): Promise<unknown[]>;
  close(): void;
}

export async function connectRaw(socketPath: string): Promise<RawPeer> {
  const socket = net.createConnection({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const frames: unknown[] = [];
  let pending = "";
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl === -1) break;
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.length > 0) frames.push(JSON.parse(line));
    }
  });

  return {
    frames,
    send: (text) => {
      socket.write(text);
    },
    expect: async (n, timeoutMs = 3000) => {
      await waitFor(() => frames.length >= n, timeoutMs, `${n} response frame(s)`);
      return frames;
    },
    close: () => socket.destroy(),
  };
}

/** The smallest payload that still satisfies the frozen `Snapshot` contract. */
export function fakeSnapshot(): Snapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.0.0-test",
    workspace: { id: "wsid", name: "ws", rootDir: "/tmp/ws", configPath: "/tmp/ws/u8.jsonc" },
    templates: DEFAULT_TEMPLATES,
    repos: [],
    profiles: [],
    activeProfile: "default",
    commands: [],
    services: [],
    indicators: [],
    plugins: [],
  };
}
