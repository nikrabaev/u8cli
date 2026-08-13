/**
 * Unix-socket JSON-RPC server.
 *
 * This is transport only: it owns sockets, framing, error mapping and fan-out,
 * and knows nothing about what the methods mean — the daemon supplies a handler
 * map. Keeping the split here is what lets the IPC layer be tested (and driven
 * with `socat`) without a workspace, a config, or a supervisor.
 */
import { existsSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import net from "node:net";

import { U8Error, errorMessage, isU8Error } from "../util/errors.js";
import { nullLogger, type Logger } from "../util/logger.js";
import { VERSION } from "../version.js";
import { LineDecoder, encodeMessage } from "./framing.js";
import {
  PROTOCOL_VERSION,
  RPC_ERRORS,
  type RpcErrorBody,
  type RpcMethod,
  type RpcNotification,
  type RpcNotificationPayload,
  type RpcParams,
  type RpcRequestEnvelope,
  type RpcResult,
} from "./protocol.js";

/** Grace period between `end()` and a forced `destroy()` when closing. */
const CLOSE_GRACE_MS = 250;
/** A unix connect resolves immediately in practice; anything slower is suspicious. */
const PROBE_TIMEOUT_MS = 500;

export type RpcHandler<M extends RpcMethod> = (
  params: RpcParams<M>,
  conn: RpcConnection,
) => RpcResult<M> | Promise<RpcResult<M>>;

/** Partial by design: an unimplemented method answers METHOD_NOT_FOUND. */
export type RpcHandlerMap = { [M in RpcMethod]?: RpcHandler<M> };

type AnyHandler = (params: never, conn: RpcConnection) => unknown;

export interface RpcConnection {
  readonly id: number;
  /** Daemon-owned subscription keys (log target ids today); the transport never reads them. */
  readonly subscriptions: Set<string>;
  /**
   * Gates `broadcast`. Set automatically once a `client.attach` request succeeds,
   * so a daemon cannot silently drop every push by forgetting to flip it.
   */
  attached: boolean;
  notify<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void;
  close(): void;
}

export interface RpcServerOptions {
  socketPath: string;
  handlers: RpcHandlerMap;
  logger?: Logger;
  /** Reported by the built-in `daemon.ping` fallback. Defaults to the package version. */
  version?: string;
  protocolVersion?: number;
  onConnection?: (conn: RpcConnection) => void;
  onDisconnect?: (conn: RpcConnection) => void;
  maxLineBytes?: number;
}

export interface RpcServer {
  readonly socketPath: string;
  readonly version: string;
  readonly protocolVersion: number;
  readonly connections: Iterable<RpcConnection>;
  readonly connectionCount: number;
  readonly attachedCount: number;
  readonly listening: boolean;
  /** Reclaims a stale socket, listens, then chmods the socket to 0600. */
  listen(): Promise<void>;
  /** Pushes to every attached connection. */
  broadcast<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void;
  broadcastTo<N extends RpcNotification>(
    predicate: (conn: RpcConnection) => boolean,
    name: N,
    params: RpcNotificationPayload<N>,
  ): void;
  close(): Promise<void>;
}

class Connection implements RpcConnection {
  readonly id: number;
  readonly subscriptions = new Set<string>();
  attached = false;

  readonly #socket: net.Socket;
  readonly #decoder: LineDecoder;
  readonly #logger: Logger;
  #closed = false;
  #graceTimer: NodeJS.Timeout | undefined;

  constructor(
    id: number,
    socket: net.Socket,
    deps: {
      logger: Logger;
      maxLineBytes: number | undefined;
      onMessage: (conn: Connection, value: unknown) => void;
      onClose: (conn: Connection) => void;
    },
  ) {
    this.id = id;
    this.#socket = socket;
    this.#logger = deps.logger;
    this.#decoder = new LineDecoder(deps.maxLineBytes);

    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      for (const msg of this.#decoder.push(chunk)) {
        if (!msg.ok) {
          // Answer with a null-id error rather than staying silent: a peer that
          // sent a malformed or oversized frame would otherwise hang to timeout.
          this.#logger.warn(`conn ${this.id}: unparsable frame`, msg.error.message);
          this.respondError(null, {
            code: RPC_ERRORS.PARSE_ERROR,
            message: msg.error.message,
          });
          continue;
        }
        deps.onMessage(this, msg.value);
      }
    });
    socket.on("error", (err: Error) => {
      this.#logger.debug(`conn ${this.id}: socket error`, err.message);
      socket.destroy();
    });
    socket.on("close", () => {
      this.#closed = true;
      if (this.#graceTimer) clearTimeout(this.#graceTimer);
      deps.onClose(this);
    });
  }

  notify<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void {
    this.#send({ jsonrpc: "2.0", method: name, params });
  }

  respondResult(id: number, result: unknown): void {
    this.#send({ jsonrpc: "2.0", id, result: result === undefined ? null : result }, id);
  }

  respondError(id: number | null, error: RpcErrorBody): void {
    this.#send({ jsonrpc: "2.0", id, error }, id ?? undefined);
  }

  close(): void {
    if (this.#closed) return;
    this.#socket.end();
    // A peer that never answers our FIN must not keep `server.close()` pending.
    this.#graceTimer = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS);
    this.#graceTimer.unref();
  }

  /** `fallbackId` lets an unserializable result still produce a response. */
  #send(envelope: unknown, fallbackId?: number): void {
    let text: string;
    try {
      text = encodeMessage(envelope);
    } catch (e) {
      const message = `response is not serializable: ${errorMessage(e)}`;
      this.#logger.error(`conn ${this.id}: ${message}`);
      if (fallbackId === undefined) return;
      text = encodeMessage({
        jsonrpc: "2.0",
        id: fallbackId,
        error: { code: RPC_ERRORS.INTERNAL_ERROR, message },
      });
    }
    this.#write(text);
  }

  #write(text: string): void {
    if (this.#closed || this.#socket.destroyed || !this.#socket.writable) return;
    // A `false` return only means the kernel buffer is full — node queues the rest
    // in order. Never await and never drop, or notifications would reorder.
    this.#socket.write(text, (err) => {
      if (err) this.#logger.debug(`conn ${this.id}: write failed`, err.message);
    });
  }
}

class Server implements RpcServer {
  readonly socketPath: string;
  readonly version: string;
  readonly protocolVersion: number;

  readonly #handlers: Record<string, AnyHandler | undefined>;
  readonly #logger: Logger;
  readonly #opts: RpcServerOptions;
  readonly #conns = new Set<Connection>();
  readonly #server: net.Server;
  #nextConnId = 1;
  #listening = false;
  #closing: Promise<void> | undefined;

  constructor(opts: RpcServerOptions) {
    this.socketPath = opts.socketPath;
    this.version = opts.version ?? VERSION;
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION;
    this.#opts = opts;
    this.#logger = opts.logger ?? nullLogger;
    this.#handlers = opts.handlers as Record<string, AnyHandler | undefined>;
    this.#server = net.createServer((socket) => this.#accept(socket));
  }

  get connections(): Iterable<RpcConnection> {
    return [...this.#conns];
  }

  get connectionCount(): number {
    return this.#conns.size;
  }

  get attachedCount(): number {
    let n = 0;
    for (const c of this.#conns) if (c.attached) n += 1;
    return n;
  }

  get listening(): boolean {
    return this.#listening;
  }

  async listen(): Promise<void> {
    if (this.#listening) return;
    await reclaimSocketPath(this.socketPath, this.#logger);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.#server.off("listening", onListening);
        reject(new U8Error("INTERNAL", `failed to listen on ${this.socketPath}: ${err.message}`));
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.socketPath);
    });
    try {
      await chmod(this.socketPath, 0o600);
    } catch (e) {
      // The bind succeeded, so give the handle back before reporting failure —
      // otherwise a rejected `listen()` leaves a bound, unreachable socket behind.
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      throw new U8Error("INTERNAL", `failed to secure ${this.socketPath}: ${errorMessage(e)}`);
    }
    this.#listening = true;
    this.#server.on("error", (err) => this.#logger.error("server error", err.message));
    this.#logger.debug(`listening on ${this.socketPath}`);
  }

  broadcast<N extends RpcNotification>(name: N, params: RpcNotificationPayload<N>): void {
    for (const conn of this.#conns) if (conn.attached) conn.notify(name, params);
  }

  broadcastTo<N extends RpcNotification>(
    predicate: (conn: RpcConnection) => boolean,
    name: N,
    params: RpcNotificationPayload<N>,
  ): void {
    for (const conn of this.#conns) if (predicate(conn)) conn.notify(name, params);
  }

  close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    const owned = this.#listening;
    for (const conn of [...this.#conns]) conn.close();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
    this.#listening = false;
    // Only remove the socket file if this server is the one that created it.
    if (owned) await unlink(this.socketPath).catch(() => undefined);
  }

  #accept(socket: net.Socket): void {
    const conn = new Connection(this.#nextConnId++, socket, {
      logger: this.#logger,
      maxLineBytes: this.#opts.maxLineBytes,
      onMessage: (c, value) => this.#onMessage(c, value),
      onClose: (c) => {
        this.#conns.delete(c);
        this.#safely(() => this.#opts.onDisconnect?.(c), "onDisconnect");
      },
    });
    this.#conns.add(conn);
    this.#safely(() => this.#opts.onConnection?.(conn), "onConnection");
  }

  #onMessage(conn: Connection, value: unknown): void {
    if (typeof value !== "object" || value === null) {
      this.#logger.warn(`conn ${conn.id}: ignoring non-object frame`);
      return;
    }
    const env = value as Partial<RpcRequestEnvelope>;
    const id = typeof env.id === "number" ? env.id : undefined;
    if (typeof env.method !== "string") {
      if (id !== undefined) {
        conn.respondError(id, { code: RPC_ERRORS.INVALID_REQUEST, message: "missing method" });
      }
      return;
    }
    if (id === undefined) {
      // Client-to-server notifications carry no id, so there is nothing to answer.
      this.#logger.debug(`conn ${conn.id}: ignoring notification ${env.method}`);
      return;
    }
    void this.#invoke(conn, id, env.method, env.params).catch((e: unknown) => {
      this.#logger.error(`conn ${conn.id}: dispatch of ${String(env.method)} crashed`, errorMessage(e));
    });
  }

  async #invoke(conn: Connection, id: number, method: string, params: unknown): Promise<void> {
    // Own properties only: `Object.prototype` members ("toString", "constructor")
    // are reachable through any handler map and would otherwise be *called*.
    const handler = Object.hasOwn(this.#handlers, method) ? this.#handlers[method] : undefined;
    if (!handler) {
      if (method === "daemon.ping") {
        conn.respondResult(id, { pong: true, version: this.version, protocolVersion: this.protocolVersion });
        return;
      }
      conn.respondError(id, { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `unknown method: ${method}` });
      return;
    }
    try {
      const result = await handler(params as never, conn);
      if (method === "client.attach") conn.attached = true;
      conn.respondResult(id, result);
    } catch (e) {
      this.#logger.warn(`conn ${conn.id}: ${method} failed`, errorMessage(e));
      conn.respondError(id, toErrorBody(e));
    }
  }

  /** Caller-supplied lifecycle callbacks must never take the server down. */
  #safely(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      this.#logger.error(`${what} callback threw`, errorMessage(e));
    }
  }
}

/**
 * Creates the server without binding. Call `listen()` (or use `startRpcServer`)
 * to reclaim a stale socket and start accepting.
 */
export function createRpcServer(opts: RpcServerOptions): RpcServer {
  return new Server(opts);
}

/** `createRpcServer` + `listen()`, for the common case. */
export async function startRpcServer(opts: RpcServerOptions): Promise<RpcServer> {
  const server = createRpcServer(opts);
  await server.listen();
  return server;
}

/** Maps anything a handler throws onto the wire error body. */
export function toErrorBody(e: unknown): RpcErrorBody {
  if (isU8Error(e)) {
    return {
      code: RPC_ERRORS.APPLICATION_ERROR,
      message: e.message,
      data: { u8Code: e.code, details: e.details },
    };
  }
  return { code: RPC_ERRORS.INTERNAL_ERROR, message: errorMessage(e) };
}

/**
 * A socket file left behind by a killed daemon is indistinguishable from a live
 * one on disk, so we ask it: a refused connect means nobody is home and the file
 * can go; a successful one means a real daemon owns this workspace.
 */
export async function reclaimSocketPath(socketPath: string, logger: Logger = nullLogger): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (await probeSocket(socketPath)) {
    throw new U8Error("INTERNAL", `a daemon is already listening on ${socketPath}`);
  }
  logger.debug(`removing stale socket ${socketPath}`);
  try {
    await unlink(socketPath);
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
  }
}

/** True when something is accepting connections on `socketPath`. */
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const onConnect = (): void => finish(true);
    const onError = (err: Error): void => {
      const code = errnoCode(err);
      // Unknown failures count as "live" so we never unlink a socket we do not
      // understand — refusing to start is recoverable, deleting is not.
      finish(!(code === "ECONNREFUSED" || code === "ENOENT"));
    };
    const finish = (live: boolean): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.on("error", () => {}); // a late error on a discarded probe must not crash us
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function errnoCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}
