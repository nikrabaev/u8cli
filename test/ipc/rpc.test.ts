import net from "node:net";
import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { U8Error, isU8Error } from "../../src/util/errors.js";
import { createRpcClient, type RpcClient } from "../../src/ipc/client.js";
import { createRpcServer, type RpcHandlerMap, type RpcServer } from "../../src/ipc/server.js";
import {
  PROTOCOL_VERSION,
  RPC_ERRORS,
  type LogLine,
  type ServiceState,
  type Snapshot,
} from "../../src/ipc/protocol.js";
import { connectRaw, fakeSnapshot, makeSocketDir, waitFor } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const serviceState = (targetId: string): ServiceState => ({
  targetId,
  status: "running",
  stale: false,
  restartAttempts: 0,
});

async function startServer(handlers: RpcHandlerMap): Promise<{ server: RpcServer; socketPath: string }> {
  const { socketPath, cleanup } = await makeSocketDir();
  const server = createRpcServer({ socketPath, handlers, version: "9.9.9" });
  await server.listen();
  cleanups.push(() => server.close());
  cleanups.push(cleanup);
  return { server, socketPath };
}

async function connectClient(socketPath: string, timeoutMs = 3000): Promise<RpcClient> {
  const client = createRpcClient({ socketPath, timeoutMs });
  await client.connect();
  cleanups.push(() => client.close());
  return client;
}

describe("rpc request/response", () => {
  it("round-trips a typed handler", async () => {
    const { socketPath } = await startServer({
      "daemon.ping": async () => ({ pong: true, version: "1.2.3", protocolVersion: PROTOCOL_VERSION }),
    });
    const client = await connectClient(socketPath);

    const res = await client.request("daemon.ping", {});

    expect(res).toEqual({ pong: true, version: "1.2.3", protocolVersion: PROTOCOL_VERSION });
    expect(client.connected).toBe(true);
  });

  it("passes params through and exposes the connection to the handler", async () => {
    const seen: Array<{ targetId: string; connId: number }> = [];
    const { socketPath } = await startServer({
      "logs.read": async (params, conn) => {
        seen.push({ targetId: params.targetId, connId: conn.id });
        return { lines: [] };
      },
    });
    const client = await connectClient(socketPath);

    await client.request("logs.read", { targetId: "gateway", lines: 10 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.targetId).toBe("gateway");
    expect(seen[0]?.connId).toBeGreaterThan(0);
  });

  it("answers METHOD_NOT_FOUND for an unregistered method", async () => {
    const { socketPath } = await startServer({});
    const client = await connectClient(socketPath);

    const err = await client.request("daemon.status", {}).catch((e: unknown) => e);

    expect(isU8Error(err)).toBe(true);
    expect((err as U8Error).code).toBe("RPC_ERROR");
    expect((err as { rpcCode?: number }).rpcCode).toBe(RPC_ERRORS.METHOD_NOT_FOUND);
    expect((err as Error).message).toContain("daemon.status");
  });

  it("maps a thrown U8Error onto its u8Code, message and details", async () => {
    const { socketPath } = await startServer({
      "profile.use": async () => {
        throw new U8Error("UNKNOWN_PROFILE", "no such profile: nope", { known: ["full"] });
      },
    });
    const client = await connectClient(socketPath);

    const err = await client.request("profile.use", { name: "nope" }).catch((e: unknown) => e);

    expect(isU8Error(err)).toBe(true);
    expect((err as U8Error).code).toBe("UNKNOWN_PROFILE");
    expect((err as Error).message).toBe("no such profile: nope");
    expect((err as U8Error).details).toEqual({ known: ["full"] });
    expect((err as { rpcCode?: number }).rpcCode).toBe(RPC_ERRORS.APPLICATION_ERROR);
  });

  it("maps a non-U8Error throw onto INTERNAL_ERROR and keeps serving", async () => {
    const { socketPath } = await startServer({
      "workspace.reload": async () => {
        throw new TypeError("boom");
      },
      "daemon.ping": async () => ({ pong: true, version: "1.2.3", protocolVersion: PROTOCOL_VERSION }),
    });
    const client = await connectClient(socketPath);

    const err = await client.request("workspace.reload", {}).catch((e: unknown) => e);

    expect((err as U8Error).code).toBe("RPC_ERROR");
    expect((err as { rpcCode?: number }).rpcCode).toBe(RPC_ERRORS.INTERNAL_ERROR);
    expect((err as Error).message).toBe("boom");
    // The server survived the throw.
    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });

  it("correlates 50 concurrent requests from one client", async () => {
    const { socketPath } = await startServer({
      "logs.read": async (params) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
        const line: LogLine = { targetId: params.targetId, stream: "u8", ts: 0, text: `echo:${params.targetId}` };
        return { lines: [line] };
      },
    });
    const client = await connectClient(socketPath, 10_000);

    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const results = await Promise.all(ids.map((targetId) => client.request("logs.read", { targetId })));

    expect(results.map((r) => r.lines[0]?.text)).toEqual(ids.map((id) => `echo:${id}`));
  });

  it("serves several clients independently", async () => {
    const { server, socketPath } = await startServer({
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const a = await connectClient(socketPath);
    const b = await connectClient(socketPath);

    await Promise.all([a.request("daemon.ping", {}), b.request("daemon.ping", {})]);

    expect(server.connectionCount).toBe(2);
    expect([...server.connections].map((c) => c.id)).toEqual([1, 2]);
  });

  it("answers daemon.ping without a handler, so liveness never depends on the daemon", async () => {
    const { socketPath } = await startServer({});
    const client = await connectClient(socketPath);

    await expect(client.request("daemon.ping", {})).resolves.toEqual({
      pong: true,
      version: "9.9.9",
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("chmods the socket to 0600", async () => {
    const { socketPath } = await startServer({});
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("answers garbage frames with a null-id parse error and still serves valid ones", async () => {
    const { socketPath } = await startServer({});
    const peer = await connectRaw(socketPath);
    cleanups.push(() => peer.close());

    // Staying silent here would hang a peer that framed its request badly, since
    // it has no id to correlate a timeout against.
    peer.send("not json{\n");
    peer.send('{"jsonrpc":"2.0","id":42,"method":"daemon.ping"}\n');
    const frames = await peer.expect(2);

    expect(frames[0]).toMatchObject({ id: null, error: { code: RPC_ERRORS.PARSE_ERROR } });
    expect(frames[1]).toMatchObject({ id: 42, result: { pong: true } });
  });

  it("answers METHOD_NOT_FOUND for names inherited from Object.prototype", async () => {
    const { socketPath } = await startServer({});
    const peer = await connectRaw(socketPath);
    cleanups.push(() => peer.close());

    // Without an own-property check these reach `Object.prototype.toString` etc.
    // and answer with a *result*, so a typo'd method silently "succeeds".
    peer.send('{"jsonrpc":"2.0","id":1,"method":"toString"}\n');
    peer.send('{"jsonrpc":"2.0","id":2,"method":"constructor"}\n');
    peer.send('{"jsonrpc":"2.0","id":3,"method":"hasOwnProperty","params":{}}\n');
    const frames = await peer.expect(3);

    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).toMatchObject({ error: { code: RPC_ERRORS.METHOD_NOT_FOUND } });
      expect(frame).not.toHaveProperty("result");
    }
  });

  it("answers INVALID_REQUEST for a frame carrying an id but no method", async () => {
    const { socketPath } = await startServer({});
    const peer = await connectRaw(socketPath);
    cleanups.push(() => peer.close());

    peer.send('{"jsonrpc":"2.0","id":7}\n');

    expect((await peer.expect(1))[0]).toMatchObject({
      id: 7,
      error: { code: RPC_ERRORS.INVALID_REQUEST },
    });
  });

  it("ignores a client notification and keeps serving the connection", async () => {
    const { socketPath } = await startServer({});
    const peer = await connectRaw(socketPath);
    cleanups.push(() => peer.close());

    peer.send('{"jsonrpc":"2.0","method":"client.hello","params":{"x":1}}\n');
    peer.send('{"jsonrpc":"2.0","id":1,"method":"daemon.ping"}\n');
    const frames = await peer.expect(1);

    // The id-less frame drew no answer, so the ping is the only response.
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 1, result: { pong: true } });
  });

  it("rejects an oversized frame without killing the connection", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    const server = createRpcServer({ socketPath, handlers: {}, version: "9.9.9", maxLineBytes: 1024 });
    await server.listen();
    cleanups.push(() => server.close());
    cleanups.push(cleanup);
    const peer = await connectRaw(socketPath);
    cleanups.push(() => peer.close());

    peer.send(`{"jsonrpc":"2.0","id":1,"method":"daemon.ping","params":{"junk":"${"x".repeat(4000)}"}}\n`);
    peer.send('{"jsonrpc":"2.0","id":2,"method":"daemon.ping"}\n');
    const frames = await peer.expect(2);

    // The oversized frame is refused, the decoder resyncs, and the next one lands.
    expect(frames[0]).toMatchObject({ id: null, error: { code: RPC_ERRORS.PARSE_ERROR } });
    expect(frames[1]).toMatchObject({ id: 2, result: { pong: true } });
    expect(server.connectionCount).toBe(1);
  });

  it("reports an unserializable result instead of leaving the caller hanging", async () => {
    const cyclic = fakeSnapshot() as Snapshot & { self?: unknown };
    cyclic.self = cyclic;
    const { socketPath } = await startServer({
      "workspace.snapshot": async () => cyclic,
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const client = await connectClient(socketPath);

    const err = await client.request("workspace.snapshot", {}).catch((e: unknown) => e);

    expect((err as { rpcCode?: number }).rpcCode).toBe(RPC_ERRORS.INTERNAL_ERROR);
    expect((err as Error).message).toContain("not serializable");
    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });

  it("rejects unserializable params as a U8Error and stays usable", async () => {
    const { socketPath } = await startServer({
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const client = await connectClient(socketPath);
    const cyclic: { name: string; self?: unknown } = { name: "loop" };
    cyclic.self = cyclic;

    const err = await client.request("profile.use", cyclic).catch((e: unknown) => e);

    expect(isU8Error(err)).toBe(true);
    expect((err as U8Error).code).toBe("RPC_ERROR");
    expect((err as Error).message).toContain("not serializable");
    // The failed request must not have consumed the connection or leaked state.
    await expect(client.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });
});

describe("notifications", () => {
  it("broadcasts to attached clients only", async () => {
    const { server, socketPath } = await startServer({
      "client.attach": async () => fakeSnapshot(),
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const [a, b, c] = [
      await connectClient(socketPath),
      await connectClient(socketPath),
      await connectClient(socketPath),
    ];
    const got = { a: [] as ServiceState[], b: [] as ServiceState[], c: [] as ServiceState[] };
    a.on("service.changed", (p) => got.a.push(p.state));
    b.on("service.changed", (p) => got.b.push(p.state));
    c.on("service.changed", (p) => got.c.push(p.state));

    await a.request("client.attach", { clientVersion: "1.0.0" });
    await b.request("client.attach", { clientVersion: "1.0.0" });
    expect(server.attachedCount).toBe(2);

    server.broadcast("service.changed", { state: serviceState("gateway") });

    await waitFor(() => got.a.length === 1 && got.b.length === 1, 3000, "both attached clients");
    expect(got.a[0]?.targetId).toBe("gateway");
    expect(got.b[0]?.targetId).toBe("gateway");
    // A round-trip proves the notification would already have arrived if it had been sent.
    await c.request("daemon.ping", {});
    expect(got.c).toEqual([]);
  });

  it("broadcastTo honours the predicate over the connection's subscriptions", async () => {
    const { server, socketPath } = await startServer({
      "logs.subscribe": async (params, conn) => {
        conn.subscriptions.add(params.targetId);
        return { ok: true };
      },
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const subscriber = await connectClient(socketPath);
    const bystander = await connectClient(socketPath);
    const lines: LogLine[] = [];
    const otherLines: LogLine[] = [];
    subscriber.on("log.line", (p) => lines.push(p.line));
    bystander.on("log.line", (p) => otherLines.push(p.line));

    await subscriber.request("logs.subscribe", { targetId: "db" });

    const line: LogLine = { targetId: "db", stream: "stdout", ts: 1, text: "ready" };
    server.broadcastTo((conn) => conn.subscriptions.has("db"), "log.line", { line });

    await waitFor(() => lines.length === 1, 3000, "the subscriber");
    await bystander.request("daemon.ping", {});
    expect(lines[0]?.text).toBe("ready");
    expect(otherLines).toEqual([]);
  });

  it("unsubscribing stops delivery without affecting other listeners", async () => {
    const { server, socketPath } = await startServer({ "client.attach": async () => fakeSnapshot() });
    const client = await connectClient(socketPath);
    const first: string[] = [];
    const second: string[] = [];
    const off = client.on("service.changed", (p) => first.push(p.state.targetId));
    client.on("service.changed", (p) => second.push(p.state.targetId));
    await client.request("client.attach", { clientVersion: "1.0.0" });

    server.broadcast("service.changed", { state: serviceState("a") });
    await waitFor(() => second.length === 1, 3000, "first delivery");
    off();
    server.broadcast("service.changed", { state: serviceState("b") });
    await waitFor(() => second.length === 2, 3000, "second delivery");

    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "b"]);
  });

  it("delivers to each subscription of the same callback independently", async () => {
    const { server, socketPath } = await startServer({ "client.attach": async () => fakeSnapshot() });
    const client = await connectClient(socketPath);
    const hits: string[] = [];
    const cb = (p: { state: ServiceState }): void => void hits.push(p.state.targetId);
    const offFirst = client.on("service.changed", cb);
    client.on("service.changed", cb);
    await client.request("client.attach", { clientVersion: "1.0.0" });

    server.broadcast("service.changed", { state: serviceState("a") });
    await waitFor(() => hits.length === 2, 3000, "both subscriptions");
    offFirst();
    server.broadcast("service.changed", { state: serviceState("b") });
    await waitFor(() => hits.length === 3, 3000, "the surviving subscription");

    // Unsubscribing one registration must not cancel the other.
    expect(hits).toEqual(["a", "a", "b"]);
  });

  it("closes a single connection without disturbing the others", async () => {
    const { server, socketPath } = await startServer({
      "daemon.ping": async () => ({ pong: true, version: "9.9.9", protocolVersion: PROTOCOL_VERSION }),
    });
    const doomed = await connectClient(socketPath);
    const survivor = await connectClient(socketPath);
    const closed: number[] = [];
    doomed.onClose(() => closed.push(1));
    await Promise.all([doomed.request("daemon.ping", {}), survivor.request("daemon.ping", {})]);

    const [first] = [...server.connections];
    first?.close();

    await waitFor(() => closed.length === 1, 3000, "the closed client to notice");
    await waitFor(() => server.connectionCount === 1, 3000, "the server to reap it");
    expect(doomed.connected).toBe(false);
    await expect(survivor.request("daemon.ping", {})).resolves.toMatchObject({ pong: true });
  });

  it("keeps notification order under backpressure", async () => {
    const { server, socketPath } = await startServer({ "client.attach": async () => fakeSnapshot() });
    const client = await connectClient(socketPath);
    const seen: string[] = [];
    client.on("log.line", (p) => seen.push(p.line.text));
    await client.request("client.attach", { clientVersion: "1.0.0" });

    const payload = "x".repeat(4096);
    const expected = Array.from({ length: 500 }, (_, i) => `${i}:${payload}`);
    for (const text of expected) {
      server.broadcast("log.line", { line: { targetId: "t", stream: "stdout", ts: 0, text } });
    }

    await waitFor(() => seen.length === expected.length, 10_000, "all 500 notifications");
    expect(seen).toEqual(expected);
  });

  it("notices a client that dies abruptly, so idle-exit accounting stays correct", async () => {
    const { server, socketPath } = await startServer({});
    const socket = net.createConnection({ path: socketPath });
    await new Promise((resolve) => socket.once("connect", resolve));
    await waitFor(() => server.connectionCount === 1, 3000, "the connection to register");

    socket.destroy();

    await waitFor(() => server.connectionCount === 0, 3000, "the connection to be reaped");
  });

  it("fires connection open/close callbacks", async () => {
    const { socketPath, cleanup } = await makeSocketDir();
    const opened: number[] = [];
    const closed: number[] = [];
    const server = createRpcServer({
      socketPath,
      handlers: {},
      onConnection: (conn) => opened.push(conn.id),
      onDisconnect: (conn) => closed.push(conn.id),
    });
    await server.listen();
    cleanups.push(cleanup);
    cleanups.push(() => server.close());

    const client = createRpcClient({ socketPath });
    await client.connect();
    await waitFor(() => opened.length === 1, 3000, "the open callback");
    await client.close();
    await waitFor(() => closed.length === 1, 3000, "the close callback");

    expect(opened).toEqual(closed);
  });
});
