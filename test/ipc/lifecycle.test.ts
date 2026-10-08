import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { U8Error, isU8Error } from "../../src/util/errors.js";
import { createRpcClient } from "../../src/ipc/client.js";
import { createRpcServer } from "../../src/ipc/server.js";
import { PROTOCOL_VERSION } from "../../src/ipc/protocol.js";
import { deferred, makeSocketDir, waitFor } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];

/** Lets one test make the post-listen `chmod` fail; every other call is the real one. */
const fs = vi.hoisted(() => ({ chmodError: null as Error | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (fs.chmodError) throw fs.chmodError;
      return actual.chmod(...args);
    },
  };
});

afterEach(async () => {
  fs.chmodError = null;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const ping = async (): Promise<{ pong: true; version: string; protocolVersion: number }> => ({
  pong: true,
  version: "9.9.9",
  protocolVersion: PROTOCOL_VERSION,
});

/** A bare unix-socket listener in its own process, so it can be SIGKILLed. */
async function spawnSocketOwner(socketPath: string): Promise<ChildProcess> {
  const script =
    "const net=require('node:net');" +
    "const s=net.createServer(()=>{});" +
    "s.listen(process.argv[1],()=>process.stdout.write('ready\\n'));";
  const child = spawn(process.execPath, ["-e", script, socketPath], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = deferred<void>();
  child.stdout?.on("data", (c: Buffer) => {
    if (c.toString("utf8").includes("ready")) ready.resolve();
  });
  await Promise.race([
    ready.promise,
    new Promise((_r, reject) => setTimeout(() => reject(new Error("owner never listened")), 5000)),
  ]);
  return child;
}

describe("socket lifecycle", () => {
  it("reclaims a socket file left behind by a hard-killed process", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const owner = await spawnSocketOwner(socketPath);
    const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    owner.kill("SIGKILL");
    await exited;
    // The file outlives the process — that is exactly what makes it a trap.
    expect(existsSync(socketPath)).toBe(true);

    const server = createRpcServer({ socketPath, handlers: { "daemon.ping": ping } });
    await server.listen();
    cleanups.push(() => server.close());
    const client = createRpcClient({ socketPath, timeoutMs: 3000 });
    cleanups.push(() => client.close());

    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });

  it("refuses to steal a socket a live server owns, and leaves it working", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const first = createRpcServer({ socketPath, handlers: { "daemon.ping": ping } });
    await first.listen();
    cleanups.push(() => first.close());

    const second = createRpcServer({ socketPath, handlers: {} });
    const err = await second.listen().catch((e: unknown) => e);

    expect(isU8Error(err)).toBe(true);
    expect((err as Error).message).toContain("already listening");
    const client = createRpcClient({ socketPath, timeoutMs: 3000 });
    cleanups.push(() => client.close());
    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
    // A failed listen must not have unlinked the live socket.
    await second.close();
    expect(existsSync(socketPath)).toBe(true);
  });

  it("releases the bound socket when securing it fails", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    fs.chmodError = Object.assign(new Error("EPERM: not permitted"), { code: "EPERM" });
    const failed = createRpcServer({ socketPath, handlers: {} });

    const err = await failed.listen().catch((e: unknown) => e);
    fs.chmodError = null;

    expect(isU8Error(err)).toBe(true);
    expect(failed.listening).toBe(false);
    // The bind must have been undone: a fresh server can still claim the path.
    const second = createRpcServer({ socketPath, handlers: { "daemon.ping": ping } });
    await second.listen();
    cleanups.push(() => second.close());
    const client = createRpcClient({ socketPath, timeoutMs: 3000 });
    cleanups.push(() => client.close());
    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });

  it("removes the socket file on close", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const server = createRpcServer({ socketPath, handlers: {} });
    await server.listen();
    expect(existsSync(socketPath)).toBe(true);

    await server.close();

    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("client failure modes", () => {
  it("reports DAEMON_UNREACHABLE when no socket file exists", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const client = createRpcClient({ socketPath, timeoutMs: 1000 });

    const connectErr = await client.connect().catch((e: unknown) => e);
    const requestErr = await client.request("daemon.ping", {}).catch((e: unknown) => e);

    expect((connectErr as U8Error).code).toBe("DAEMON_UNREACHABLE");
    expect((requestErr as U8Error).code).toBe("DAEMON_UNREACHABLE");
    expect(client.connected).toBe(false);
  });

  it("reports DAEMON_UNREACHABLE for a stale socket file nobody is listening on", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const owner = await spawnSocketOwner(socketPath);
    const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    owner.kill("SIGKILL");
    await exited;

    const client = createRpcClient({ socketPath, timeoutMs: 1000 });
    const err = await client.connect().catch((e: unknown) => e);

    expect((err as U8Error).code).toBe("DAEMON_UNREACHABLE");
  });

  it("rejects in-flight requests when the server dies mid-request", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => void process.off("unhandledRejection", onUnhandled));

    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const entered = deferred<void>();
    const server = createRpcServer({
      socketPath,
      handlers: {
        // Never resolves: the request is in flight when the daemon goes away.
        "run.await": async () => {
          entered.resolve();
          return new Promise(() => {});
        },
      },
    });
    await server.listen();
    const closes: Array<Error | undefined> = [];
    const client = createRpcClient({ socketPath, timeoutMs: 10_000, onClose: (e) => closes.push(e) });
    await client.connect();

    const pending = client.request("run.await", { runId: "r1" }).catch((e: unknown) => e);
    await entered.promise;
    await server.close();

    const err = await pending;
    expect((err as U8Error).code).toBe("DAEMON_UNREACHABLE");
    await waitFor(() => closes.length === 1, 3000, "the onClose callback");
    expect(client.connected).toBe(false);

    // Requests after the death fail fast rather than hanging or throwing sync.
    const after = await client.request("daemon.ping", {}).catch((e: unknown) => e);
    expect((after as U8Error).code).toBe("DAEMON_UNREACHABLE");
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });

  it("times out a request the daemon never answers", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const server = createRpcServer({
      socketPath,
      handlers: { "run.await": async () => new Promise(() => {}) },
    });
    await server.listen();
    cleanups.push(() => server.close());
    const client = createRpcClient({ socketPath, timeoutMs: 150 });
    cleanups.push(() => client.close());

    const err = await client.request("run.await", { runId: "r1" }).catch((e: unknown) => e);

    expect((err as U8Error).code).toBe("RPC_ERROR");
    expect((err as Error).message).toContain("timed out");
    expect(client.connected).toBe(true);
  });

  it("lets one request outlive the client's deadline, or fall short of it", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const release = deferred<void>();
    const server = createRpcServer({
      socketPath,
      handlers: {
        // A run that takes as long as it takes: the answer is the whole point.
        "run.await": async () => {
          await release.promise;
          return { runId: "r1", command: "c", ok: true, targets: [], startedAt: 0, finishedAt: 0 };
        },
        "daemon.ping": async () => new Promise(() => {}),
      },
    });
    await server.listen();
    cleanups.push(() => server.close());
    const client = createRpcClient({ socketPath, timeoutMs: 100 });
    cleanups.push(() => client.close());

    const awaited = client.request("run.await", { runId: "r1" }, { timeoutMs: 0 });
    // Well past the client's own deadline, and still waiting.
    await new Promise((r) => setTimeout(r, 250));
    release.resolve();
    expect((await awaited).ok).toBe(true);

    // The override is per request, in both directions: the next one is bound
    // by what it asked for, not by the client's deadline or the last call's.
    const started = Date.now();
    const err = await client.request("daemon.ping", {}, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("daemon.ping timed out after 30ms");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("refuses to reconnect after an explicit close", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    cleanups.push(cleanup);
    const server = createRpcServer({ socketPath, handlers: { "daemon.ping": ping } });
    await server.listen();
    cleanups.push(() => server.close());
    const client = createRpcClient({ socketPath, timeoutMs: 2000 });
    await client.request("daemon.ping", {});
    await client.close();

    const err = await client.request("daemon.ping", {}).catch((e: unknown) => e);

    expect((err as U8Error).code).toBe("DAEMON_UNREACHABLE");
    expect(server.connectionCount).toBe(0);
  });
});
